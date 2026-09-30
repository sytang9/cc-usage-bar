#!/usr/bin/env bash
# Test harness for subagent-statusline.sh (one row per subagent in the agent panel).
# Self-contained bash; no external test framework. Sandboxes HOME per case and
# builds a fake session transcript tree under it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/subagent-statusline.sh"

FAIL_COUNT=0
PASS_COUNT=0

pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

make_sandbox() {
  mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-sub-test.XXXXXX"
}

# usage_line <msg id> <input> <cache write> <cache read> -> one assistant transcript line
usage_line() {
  printf '{"type":"assistant","timestamp":"2026-09-30T10:00:00Z","message":{"id":"%s","usage":{"input_tokens":%s,"cache_creation_input_tokens":%s,"cache_read_input_tokens":%s,"output_tokens":5}}}\n' \
    "$1" "$2" "$3" "$4"
}

# make_session <home> -> sets SESSION_JSONL and SUB_DIR; writes one engineer agent a1
make_session() {
  local home_dir="$1"
  local proj="$home_dir/.claude/projects/p"
  SESSION_JSONL="$proj/s1.jsonl"
  SUB_DIR="$proj/s1/subagents"
  mkdir -p "$SUB_DIR"
  : >"$SESSION_JSONL"
  printf '{"agentType":"engineer","description":"T4 roles"}\n' >"$SUB_DIR/agent-a1.meta.json"
  {
    usage_line m1 2 40000 0          # first call: 40k context, cache build, not a miss
    usage_line m2 2 5000 40000       # 45k
    usage_line m2 2 5000 40000       # same message id again: counted once
    usage_line m3 2 150000 0         # full rewrite after the cache expired: a miss
  } >"$SUB_DIR/agent-a1.jsonl"
}

# input_json <tokenCount> <status> -> the stdin Claude Code sends
input_json() {
  local start_ms=$(( ($(date +%s) - 300) * 1000 ))
  printf '{"session_id":"s1","transcript_path":"%s","cwd":"/work/lead","columns":120,"tasks":[{"id":"a1","type":"local_agent","status":"%s","description":"T4 roles","label":"T4 roles","startTime":%s,"model":"claude-sonnet-5-5","contextWindowSize":1000000,"tokenCount":%s,"cwd":"/work/infrasel-sh-t4"}]}' \
    "$SESSION_JSONL" "$2" "$start_ms" "$1"
}

run_script() {
  OUT="$(HOME="$1" XDG_CACHE_HOME="$1/.cache" bash "$TARGET" <<<"$2" 2>&1)"
  EXIT_CODE=$?
}

# content_of <out> -> the row body of the first emitted line, ANSI stripped
content_of() {
  printf '%s\n' "$1" | head -1 | jq -r '.content' 2>/dev/null | sed $'s/\033\\[[0-9;]*m//g'
}

# --- Case 1: one JSON row per task, keyed by id, with type, context and totals --
case1() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  run_script "$home_dir" "$(input_json 41266 running)"
  local body
  body="$(content_of "$OUT")"
  # processed = 40000 + 45000 + 150000 (m2 once) = 235002 + 4 input = 235.0k
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$(printf '%s\n' "$OUT" | head -1 | jq -r '.id')" == "a1" ]] \
    && [[ "$body" == *"engineer"* ]] \
    && [[ "$body" == *"T4 roles"* ]] \
    && [[ "$body" == *"ctx 41k (4%)"* ]] \
    && [[ "$body" == *"tok 235k (17% cached)"* ]] \
    && [[ "$body" == *"1 cache miss"* ]] \
    && [[ "$body" == *"running 5m"* ]] \
    && [[ "$body" == *"infrasel-sh-t4"* ]]; then
    pass "case1: row has id, type, ctx, tok with cached share, cache miss, running age, worktree"
  else
    fail "case1: exit=$EXIT_CODE out=[$OUT] body=[$body]"
  fi
  rm -rf "$home_dir"
}

# --- Case 2: incremental read; a partial last line waits until it is complete --
case2() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  run_script "$home_dir" "$(input_json 41266 running)"
  usage_line m4 2 200000 0 >>"$SUB_DIR/agent-a1.jsonl"   # a second full rewrite: miss 2
  printf '{"type":"assistant","message":{"id":"m5","usa' >>"$SUB_DIR/agent-a1.jsonl"
  run_script "$home_dir" "$(input_json 151002 running)"
  local body1
  body1="$(content_of "$OUT")"
  printf 'ge":{"input_tokens":0,"cache_creation_input_tokens":300000,"cache_read_input_tokens":0}}}\n' \
    >>"$SUB_DIR/agent-a1.jsonl"
  run_script "$home_dir" "$(input_json 151002 running)"
  local body2
  body2="$(content_of "$OUT")"
  if [[ "$body1" == *"2 cache misses"* ]] && [[ "$body2" == *"3 cache misses"* ]]; then
    pass "case2: misses grow incrementally and a partial line is read once complete"
  else
    fail "case2: body1=[$body1] body2=[$body2]"
  fi
  rm -rf "$home_dir"
}

# --- Case 3: no transcript yet -> row still renders from the native fields --
case3() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  rm -f "$SUB_DIR/agent-a1.jsonl" "$SUB_DIR/agent-a1.meta.json"
  run_script "$home_dir" "$(input_json 41266 running)"
  local body
  body="$(content_of "$OUT")"
  if [[ "$EXIT_CODE" -eq 0 ]] && [[ "$body" == *"T4 roles"* ]] && [[ "$body" == *"ctx 41k (4%)"* ]] \
    && [[ "$body" != *"miss"* ]] && [[ "$body" != *"tok "* ]]; then
    pass "case3: missing transcript renders ctx only"
  else
    fail "case3: exit=$EXIT_CODE body=[$body]"
  fi
  rm -rf "$home_dir"
}

# --- Case 4: context past the warn and crit thresholds is coloured --
case4() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  run_script "$home_dir" "$(input_json 700000 running)"
  local warn="$OUT"
  run_script "$home_dir" "$(input_json 900000 running)"
  local crit="$OUT"
  if printf '%s' "$warn" | jq -r '.content' | grep -q $'ctx \033\\[38;5;179m700k (70%)' \
    && printf '%s' "$crit" | jq -r '.content' | grep -q $'ctx \033\\[38;5;167m900k (90%)'; then
    pass "case4: 70% renders amber, 90% renders red"
  else
    fail "case4: warn=[$warn] crit=[$crit]"
  fi
  rm -rf "$home_dir"
}

# --- Case 5: a finished agent says done --
case5() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  run_script "$home_dir" "$(input_json 41266 completed)"
  local body
  body="$(content_of "$OUT")"
  if [[ "$body" == *"done"* ]]; then
    pass "case5: completed task shows done"
  else
    fail "case5: body=[$body]"
  fi
  rm -rf "$home_dir"
}

# --- Case 6: garbage or empty stdin -> exit 0 and no rows (defaults stay) --
case6() {
  local home_dir
  home_dir="$(make_sandbox)"
  run_script "$home_dir" "not json"
  local e1="$EXIT_CODE" o1="$OUT"
  run_script "$home_dir" ""
  if [[ "$e1" -eq 0 ]] && [[ -z "$o1" ]] && [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUT" ]]; then
    pass "case6: bad input exits 0 with no output"
  else
    fail "case6: e1=$e1 o1=[$o1] e2=$EXIT_CODE o2=[$OUT]"
  fi
  rm -rf "$home_dir"
}

# --- Case 7: an invalid UTF-8 byte must not push the offset past the file end --
case7() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  printf '{"type":"user","message":{"content":"bad \xff\xfe bytes"}}\n' >>"$SUB_DIR/agent-a1.jsonl"
  run_script "$home_dir" "$(input_json 41266 running)"
  local size offset
  size="$(wc -c <"$SUB_DIR/agent-a1.jsonl" | tr -d ' ')"
  offset="$(cut -d' ' -f1 "$home_dir/.cache/cc-usage-bar/subagents/s1/a1.json" 2>/dev/null)"
  if [[ "$offset" == "$size" ]] && [[ "$(content_of "$OUT")" == *"1 cache miss"* ]]; then
    pass "case7: offset equals the file size after an invalid byte"
  else
    fail "case7: offset=$offset size=$size out=[$OUT]"
  fi
  rm -rf "$home_dir"
}

# --- Case 8: a poison line (non-object, non-numeric usage) must not freeze totals --
case8() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  {
    printf '"junk"\n'
    printf '{"type":"assistant","message":{"id":"m9","usage":{"input_tokens":"x","cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n'
    printf '{"type":"assistant","message":"not an object"}\n'
    usage_line m10 0 500000 0
  } >>"$SUB_DIR/agent-a1.jsonl"
  run_script "$home_dir" "$(input_json 41266 running)"
  local body
  body="$(content_of "$OUT")"
  if [[ "$body" == *"2 cache misses"* ]]; then
    pass "case8: poison lines are skipped and later calls still count"
  else
    fail "case8: body=[$body]"
  fi
  rm -rf "$home_dir"
}

# --- Case 9: an empty transcript_path must not shift cwd into the wrong field --
case9() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  local input
  input="$(input_json 41266 running | jq -c '.transcript_path = "" | .tasks[0].cwd = "/work/lead"')"
  run_script "$home_dir" "$input"
  local body
  body="$(content_of "$OUT")"
  if [[ "$body" == *"T4 roles"* ]] && [[ "$body" != *"lead"* ]]; then
    pass "case9: empty transcript_path keeps the lead cwd, no false worktree"
  else
    fail "case9: body=[$body]"
  fi
  rm -rf "$home_dir"
}

# --- Case 10: consecutive calls without a message id are each counted --
case10() {
  local home_dir
  home_dir="$(make_sandbox)"
  make_session "$home_dir"
  : >"$SUB_DIR/agent-a1.jsonl"
  for _ in 1 2 3; do
    printf '{"type":"assistant","message":{"usage":{"input_tokens":0,"cache_creation_input_tokens":150000,"cache_read_input_tokens":0}}}\n' \
      >>"$SUB_DIR/agent-a1.jsonl"
  done
  run_script "$home_dir" "$(input_json 41266 running)"
  local body
  body="$(content_of "$OUT")"
  if [[ "$body" == *"2 cache misses"* ]]; then
    pass "case10: id-less calls are not deduplicated"
  else
    fail "case10: body=[$body]"
  fi
  rm -rf "$home_dir"
}

case1
case2
case3
case4
case5
case6
case7
case8
case9
case10

echo
echo "subagent_statusline_test: $PASS_COUNT passed, $FAIL_COUNT failed"
[[ "$FAIL_COUNT" -eq 0 ]]
