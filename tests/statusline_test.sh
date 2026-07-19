#!/usr/bin/env bash
# Test harness for statusline-usage.sh (2-row capsule/test-tube bar design)
# Self-contained bash; no external test framework. Sandboxes HOME per case.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/statusline-usage.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

# Capsule wall-cap glyphs (see statusline-usage.sh GLYPH_WALL_L/GLYPH_WALL_R).
WALL_L="▕"
WALL_R="▏"

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

# make_sandbox: create a fresh temp dir to use as HOME, echo its path
make_sandbox() {
  mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-test.XXXXXX"
}

# run_with_home <home_dir> <fixture_file> -> sets OUT, EXIT_CODE
run_script() {
  local home_dir="$1"
  local fixture="$2"
  OUT="$(HOME="$home_dir" bash "$TARGET" <"$fixture" 2>&1)"
  EXIT_CODE=$?
}

# --- Case 1: normal.json with full account identity -> 2-row capsule bar --
case1() {
  local home_dir
  home_dir="$(make_sandbox)"
  mkdir -p "$home_dir/.claude"
  cp "$FIXTURES/claude_account.json" "$home_dir/.claude.json"

  run_script "$home_dir" "$FIXTURES/normal.json"

  local line_count
  line_count="$(printf '%s\n' "$OUT" | wc -l)"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$line_count" -eq 2 ]] \
    && printf '%s' "$OUT" | grep -q "test-user@example.com" \
    && printf '%s' "$OUT" | grep -q "Opus" \
    && printf '%s' "$OUT" | grep -qF "$WALL_L" \
    && printf '%s' "$OUT" | grep -qF "$WALL_R" \
    && printf '%s' "$OUT" | grep -q "5H" \
    && printf '%s' "$OUT" | grep -q "WK" \
    && printf '%s' "$OUT" | grep -q "CTX" \
    && printf '%s' "$OUT" | grep -q "62" \
    && printf '%s' "$OUT" | grep -q "31"; then
    pass "case1 normal output is exactly 2 rows with capsules, labels, pcts, identity"
  else
    fail "case1 normal output (exit=$EXIT_CODE lines=$line_count): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

# --- Case 2: high.json triggers crit color (256-color code 167) -----------
case2() {
  local home_dir
  home_dir="$(make_sandbox)"

  run_script "$home_dir" "$FIXTURES/high.json"

  if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$OUT" | grep -q $'\033\[38;5;167m'; then
    pass "case2 high pct shows crit color 167"
  else
    fail "case2 high pct crit color missing (exit=$EXIT_CODE): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

# --- Case 3: null_limits.json -> "—" placeholder, exit 0, non-empty -------
case3() {
  local home_dir
  home_dir="$(make_sandbox)"

  run_script "$home_dir" "$FIXTURES/null_limits.json"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -q "5H" \
    && printf '%s' "$OUT" | grep -q "WK" \
    && printf '%s' "$OUT" | grep -q "—" \
    && [[ -n "$OUT" ]]; then
    pass "case3 null rate_limits shows — placeholder for 5H/WK, exit 0, non-empty"
  else
    fail "case3 null rate_limits (exit=$EXIT_CODE): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

# --- Case 4: normal.json but no oauthAccount -> email omitted -------------
case4() {
  local home_dir
  home_dir="$(make_sandbox)"
  mkdir -p "$home_dir/.claude"
  echo '{}' >"$home_dir/.claude.json"

  run_script "$home_dir" "$FIXTURES/normal.json"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && ! printf '%s' "$OUT" | grep -q "test-user@example.com" \
    && [[ -n "$OUT" ]]; then
    pass "case4 missing oauthAccount omits email, still prints rows"
  else
    fail "case4 missing oauthAccount (exit=$EXIT_CODE): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

# --- Case 5: secret-leak guard ---------------------------------------------
case5() {
  local home_dir
  local fake_token="sk-ant-oat01-FAKESECRETTOKENVALUE1234567890"
  home_dir="$(make_sandbox)"
  mkdir -p "$home_dir/.claude"
  cp "$FIXTURES/claude_account.json" "$home_dir/.claude.json"
  printf '{"claudeAiOauth":{"accessToken":"%s"}}' "$fake_token" >"$home_dir/.claude/.credentials.json"
  chmod 600 "$home_dir/.claude/.credentials.json"

  run_script "$home_dir" "$FIXTURES/normal.json"

  if [[ "$EXIT_CODE" -eq 0 ]] && ! printf '%s' "$OUT" | grep -q "$fake_token"; then
    pass "case5 fake token never appears in output"
  else
    fail "case5 secret leak detected (exit=$EXIT_CODE): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

# --- Bonus: no jq on PATH -> clean fallback line, exit 0 -------------------
case6() {
  local home_dir stub_dir bash_bin
  home_dir="$(make_sandbox)"
  stub_dir="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-nopath.XXXXXX")"
  bash_bin="$(command -v bash)"

  # Keep bash itself reachable (needed to run the script at all, since the
  # shebang is `env bash`) via a symlink in an otherwise-empty stub dir, so
  # jq (which lives alongside bash in /usr/bin) is NOT on PATH.
  ln -s "$bash_bin" "$stub_dir/bash"
  OUT="$(HOME="$home_dir" PATH="$stub_dir" bash "$TARGET" <"$FIXTURES/normal.json" 2>&1)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -q "jq not installed" \
    && [[ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ]]; then
    pass "case6 missing jq prints single clean fallback line, exit 0"
  else
    fail "case6 missing jq handling (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir" "$stub_dir"
}

# --- Bonus: malformed JSON on stdin -> single fallback line, exit 0 -------
case7() {
  local home_dir
  home_dir="$(make_sandbox)"

  OUT="$(HOME="$home_dir" bash "$TARGET" <<<'{not valid json' 2>&1)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -eq 0 ]] && [[ -n "$OUT" ]] && [[ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ]]; then
    pass "case7 malformed JSON yields single fallback line, exit 0"
  else
    fail "case7 malformed JSON handling (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir"
}

# --- Bonus: unbound variable inside main -> guard still catches it --------
# `set -u` makes bash hard-exit the whole *process* on an unbound variable
# reference in non-interactive mode -- this bypasses a naive `main || echo`
# guard entirely (the `||` never runs). The script must instead run main in
# a command substitution so the hard-exit is confined to a subshell. This
# test injects an unbound-variable reference into a scratch copy of the real
# script to prove that isolation mechanism actually works, rather than
# trusting that every current code path inside main happens to be bug-free.
case8() {
  local home_dir scratch_script
  home_dir="$(make_sandbox)"
  scratch_script="$(mktemp "${TMPDIR:-/tmp}/cc-usage-bar-unbound.XXXXXX.sh")"

  sed 's/local model_name effort_level ctx_pct/local model_name effort_level ctx_pct\n  echo "$THIS_VAR_IS_INTENTIONALLY_UNBOUND" >\/dev\/null/' \
    "$TARGET" >"$scratch_script"
  chmod +x "$scratch_script"

  OUT="$(HOME="$home_dir" bash "$scratch_script" <"$FIXTURES/normal.json" 2>/dev/null)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -n "$OUT" ]] \
    && [[ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ]]; then
    pass "case8 unbound variable inside main is caught by the guard"
  else
    fail "case8 unbound variable not caught (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir" "$scratch_script"
}

# --- Fill-color boundary cases ----------------------------------------------
# statusline-usage.sh's color_for() rule (see its PCT_OK_MAX/PCT_WARN_MAX
# constants): pct < 60 -> ok (108), 60 <= pct <= 85 -> warn (179),
# pct > 85 -> crit (167). Each case below feeds a minimal inline JSON (both
# rate-limit buckets set to the same boundary pct, since only the 5H/WK
# capsules' own fill color is under test here) and asserts the exact
# 256-color SGR escape for that boundary's expected bucket appears.
run_boundary_pct() {
  local home_dir="$1" pct="$2"
  local json
  json="$(printf '{"rate_limits":{"five_hour":{"used_percentage":%s,"resets_at":4102444800},"seven_day":{"used_percentage":%s,"resets_at":4102444800}}}' "$pct" "$pct")"
  OUT="$(HOME="$home_dir" bash "$TARGET" <<<"$json" 2>&1)"
  EXIT_CODE=$?
}

assert_color_boundary() {
  local pct="$1" expected_color="$2" label="$3"
  local home_dir pattern
  home_dir="$(make_sandbox)"

  run_boundary_pct "$home_dir" "$pct"
  pattern="$(printf '\033[38;5;%sm' "$expected_color")"

  if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$OUT" | grep -qF "$pattern"; then
    pass "$label"
  else
    fail "$label (exit=$EXIT_CODE): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

# --- Case 9: pct 59 -> still ok (108), one below the warn threshold --------
case9() {
  assert_color_boundary 59 108 "case9 pct 59 shows ok fill color 108 (just below warn threshold)"
}

# --- Case 10: pct 60 -> warn (179), the first warn value -------------------
case10() {
  assert_color_boundary 60 179 "case10 pct 60 shows warn fill color 179 (first warn value)"
}

# --- Case 11: pct 85 -> still warn (179), the last warn value --------------
case11() {
  assert_color_boundary 85 179 "case11 pct 85 shows warn fill color 179 (last warn value)"
}

# --- Case 12: pct 86 -> crit (167), the first crit value -------------------
case12() {
  assert_color_boundary 86 167 "case12 pct 86 shows crit fill color 167 (first crit value)"
}

# --- Case 13: label tints for 5H (110), WK (176), CTX (246) ----------------
case13() {
  local home_dir
  home_dir="$(make_sandbox)"

  run_script "$home_dir" "$FIXTURES/normal.json"

  local p5h pwk pctx
  p5h="$(printf '\033[38;5;110m')"
  pwk="$(printf '\033[38;5;176m')"
  pctx="$(printf '\033[38;5;246m')"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -qF "$p5h" \
    && printf '%s' "$OUT" | grep -qF "$pwk" \
    && printf '%s' "$OUT" | grep -qF "$pctx"; then
    pass "case13 label tints present: 5H=110, WK=176, CTX=246"
  else
    fail "case13 label tints missing (exit=$EXIT_CODE): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

main() {
  if [[ ! -x "$TARGET" ]]; then
    echo "FAIL: target script not found or not executable: $TARGET"
    exit 1
  fi

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
  case11
  case12
  case13

  echo
  echo "----------------------------------------"
  echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
