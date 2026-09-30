#!/usr/bin/env bash
# subagent-statusline.sh — Claude Code subagentStatusLine: one row per subagent.
#
# Claude Code pipes {session_id, transcript_path, cwd, columns, tasks[]} to stdin
# on every refresh tick and renders each {"id", "content"} line we print as that
# subagent's row in the agent panel. Per row: agent type, label, model, the
# agent's session size now (its context in tokens, and as % of its window),
# cache misses, age, and the worktree when it differs from the lead's.
#
# The session size is Claude Code's own tokenCount. Misses come from the agent's
# own transcript
# (<transcript dir>/<session>/subagents/agent-<id>.jsonl), read incrementally:
# a per-agent state file remembers the byte offset, so each tick reads only new
# lines. Contract: NEVER exit non-zero; on any failure print nothing, so Claude
# Code keeps its default rows.

set -uo pipefail

readonly PCT_OK_MAX=59      # < 60 -> ok (same thresholds as statusline-usage.sh)
readonly PCT_WARN_MAX=85    # 60..85 -> warn; > 85 -> crit
readonly COLOR_OK=108
readonly COLOR_WARN=179
readonly COLOR_CRIT=167
readonly COLOR_DIM=245
readonly MISS_TOKENS=100000 # a cache write this big after the first call = a full rewrite
readonly LABEL_MAX=28
readonly EMPTY_STATE='{"offset":0,"calls":0,"misses":0,"last":""}'

# update_totals <transcript> <state file> -> echoes the state JSON after
# reading any complete new lines; echoes nothing when there is no transcript.
# The state file holds "<offset> <json>", so an unchanged transcript costs no jq.
update_totals() {
  local transcript="$1" state_file="$2"
  [[ -f "$transcript" ]] || return 0
  local offset=0 state="$EMPTY_STATE" size
  if [[ -f "$state_file" ]]; then
    read -r offset state <"$state_file" 2>/dev/null || { offset=0; state="$EMPTY_STATE"; }
    [[ "$offset" =~ ^[0-9]+$ && -n "$state" ]] || { offset=0; state="$EMPTY_STATE"; }
  fi
  size="$(wc -c <"$transcript" | tr -d ' ')"
  (( size < offset )) && { state="$EMPTY_STATE"; offset=0; }   # file was replaced
  # Read only up to the last newline: a line still being written waits for the
  # next tick. Bytes are counted by the shell, not jq, because jq -R replaces
  # invalid UTF-8 with 3-byte U+FFFD and would overshoot the file.
  local end="$size"
  # Both checks look at the first $size bytes only, so an append between the
  # two reads cannot make a half-written line look complete.
  if (( size > offset )) && [[ "$(tail -c +"$size" "$transcript" | head -c 1 | wc -l | tr -d ' ')" != "1" ]]; then
    end=$(( size - $(tail -c +"$((offset + 1))" "$transcript" | head -c "$((size - offset))" \
      | tail -n 1 | wc -c | tr -d ' ') ))
  fi
  if (( end > offset )); then
    local next
    next="$(tail -c +"$((offset + 1))" "$transcript" | head -c "$((end - offset))" \
      | jq -Rsr --argjson st "$state" --argjson miss "$MISS_TOKENS" --argjson end "$end" '
      def n: if type == "number" then . else 0 end;
      reduce (split("\n")[] | fromjson? | objects | select(.type == "assistant")
              | select((.message | type) == "object" and (.message.usage | type) == "object")) as $d ($st;
          if $d.message.id != null and $d.message.id == .last then .
          else ($d.message.usage) as $u
            | .misses += (if .calls > 0 and ($u.cache_creation_input_tokens | n) > $miss then 1 else 0 end)
            | .calls += 1
            | .last = $d.message.id
          end)
      | "\($end) \(tojson)"' 2>/dev/null)"
    if [[ -n "$next" ]]; then
      read -r offset state <<<"$next"
      mkdir -p "$(dirname "$state_file")" 2>/dev/null \
        && printf '%s\n' "$next" >"$state_file.tmp" 2>/dev/null \
        && mv -f "$state_file.tmp" "$state_file" 2>/dev/null
    fi
  fi
  printf '%s' "$state"
}

# render_rows <input JSON>: prints one {"id","content"} line per task.
render_rows() {
  local input="$1"
  local session_id transcript_path lead_cwd sub_dir state_dir now
  # \x1f, not tab: tab is IFS whitespace, so an empty field would shift the rest.
  IFS=$'\x1f' read -r session_id transcript_path lead_cwd \
    < <(jq -r '[.session_id // "", .transcript_path // "", .cwd // ""] | join("\u001f")' <<<"$input")
  [[ "$session_id" =~ ^[A-Za-z0-9._-]+$ && "$session_id" != *..* ]] || session_id="none"
  sub_dir="${transcript_path%.jsonl}/subagents"
  state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/cc-usage-bar/subagents/${session_id:-none}"
  now="$(date +%s)"

  local task id agent_type totals
  while IFS=$'\x1f' read -r id task; do
    [[ "$id" =~ ^[A-Za-z0-9._-]+$ && "$id" != *..* ]] || continue
    agent_type=""
    [[ -f "$sub_dir/agent-$id.meta.json" ]] \
      && agent_type="$(jq -r '.agentType // empty' "$sub_dir/agent-$id.meta.json" 2>/dev/null)"
    totals=""
    [[ -n "$transcript_path" ]] && totals="$(update_totals "$sub_dir/agent-$id.jsonl" "$state_dir/$id.json")"
    jq -cn --argjson t "$task" --arg type "$agent_type" --arg totals "${totals:-null}" \
      --arg lead "$lead_cwd" --argjson now "$now" \
      --argjson ok "$PCT_OK_MAX" --argjson warn "$PCT_WARN_MAX" \
      --argjson c_ok "$COLOR_OK" --argjson c_warn "$COLOR_WARN" --argjson c_crit "$COLOR_CRIT" \
      --argjson c_dim "$COLOR_DIM" --argjson label_max "$LABEL_MAX" '
      def sgr($c): "\u001b[38;5;\($c)m";
      def reset: "\u001b[0m";
      def human: if . >= 1000000 then (. / 100000 | round) as $t | "\($t / 10 | floor).\($t % 10)M"
                 else "\(. / 1000 | round)k" end;
      ($totals | fromjson? // null) as $s
      | ($t.label // $t.description // "" | if length > $label_max then .[:$label_max - 1] + "…" else . end) as $label
      | ($t.model // "" | sub("^claude-"; "") | sub("-(?<a>[0-9]+)-(?<b>[0-9]+).*$"; " \(.a).\(.b)")) as $model
      | (if ($t.contextWindowSize // 0) > 0 then (($t.tokenCount // 0) * 100 / $t.contextWindowSize | floor) else null end) as $pct
      | (if $pct == null then null elif $pct > $warn then $c_crit elif $pct > $ok then $c_warn else $c_ok end) as $pc
      | (if $t.status == "running" then
           ((($now * 1000) - ($t.startTime // ($now * 1000))) / 60000 | floor) as $m
           | if $m >= 60 then "\($m / 60 | floor)h\($m % 60)m" else "\($m)m" end
         elif $t.status == "completed" then "done"
         else ($t.status // "") end) as $age
      | ($t.cwd // "" | if . != "" and . != $lead then split("/") | last else "" end) as $wt
      | [ (if $type != "" then $type else null end),
          $label,
          (if $model != "" then sgr($c_dim) + $model + reset else null end),
          (if $pct != null then sgr($pc) + (($t.tokenCount // 0) | human) + " (\($pct)%)" + reset else null end),
          (if $s != null and $s.misses > 0 then sgr($c_warn) + "\($s.misses) miss" + reset else null end),
          $age,
          (if $wt != "" then sgr($c_dim) + $wt + reset else null end) ]
      | map(select(. != null and . != "")) | join(" · ")
      | {id: $t.id, content: .}'
  done < <(jq -r '.tasks[]? | "\(.id // "")\u001f\(tojson)"' <<<"$input" 2>/dev/null)
}

main() {
  local input
  input="$(cat 2>/dev/null)"
  jq -e '.tasks | type == "array"' <<<"$input" >/dev/null 2>&1 || return 0
  render_rows "$input" 2>/dev/null
  return 0
}

main
exit 0
