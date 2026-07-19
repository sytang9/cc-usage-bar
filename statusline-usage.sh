#!/usr/bin/env bash
# statusline-usage.sh — Claude Code multi-line statusLine usage bar.
#
# Claude Code pipes a JSON blob (session/model/rate-limit info) to this
# script's stdin on every render; whatever is printed to stdout becomes the
# status rows shown above the prompt. Contract: NEVER exit non-zero, NEVER
# print nothing — either render the 2 usage rows or fall back to one safe
# line. The whole body below is wrapped in a guard that enforces this.

set -uo pipefail

readonly SEGMENTS=8
readonly PCT_OK_MAX=59      # < 60 -> ok
readonly PCT_WARN_MAX=85    # 60..85 inclusive -> warn; > 85 -> crit
readonly COLOR_OK=108       # sage
readonly COLOR_WARN=179     # amber
readonly COLOR_CRIT=167     # red
readonly COLOR_DIM=245      # percentages / reset countdowns / row1 text
readonly COLOR_TRACK=240    # empty capsule segments + wall caps
readonly COLOR_EMAIL=250    # row1 email (slightly brighter than the rest)
readonly COLOR_LABEL_5H=110  # soft blue
readonly COLOR_LABEL_WK=176  # soft magenta
readonly COLOR_LABEL_CTX=246 # grey
readonly SEC_PER_MIN=60
readonly SEC_PER_HOUR=3600
readonly SEC_PER_DAY=86400
readonly RESET="\033[0m"

# Capsule / test-tube meter glyphs: wall caps bracket a fixed-width run of
# fill/empty segments.
readonly GLYPH_WALL_L="▕"
readonly GLYPH_WALL_R="▏"
readonly GLYPH_FILL="▰"
readonly GLYPH_EMPTY="▱"

# color_for <pct> -> echoes the 256-color SGR numeric code for that pct.
color_for() {
  local pct="$1"
  if (( pct > PCT_WARN_MAX )); then
    echo "$COLOR_CRIT"
  elif (( pct > PCT_OK_MAX )); then
    echo "$COLOR_WARN"
  else
    echo "$COLOR_OK"
  fi
}

# render_capsule <pct> -> echoes a colored capsule meter: wall caps + 8
# segments, filled left-to-right, semantically colored by this meter's own
# pct via color_for. Empty segments and both wall caps are dim grey.
render_capsule() {
  local pct="$1"
  local color
  color="$(color_for "$pct")"

  # Clamp pct into [0, 100] defensively; bad input renders an empty capsule
  # rather than corrupting arithmetic below.
  if ! [[ "$pct" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
    pct=0
  fi
  awk -v p="$pct" 'BEGIN { exit !(p < 0) }' && pct=0
  awk -v p="$pct" 'BEGIN { exit !(p > 100) }' && pct=100

  local filled
  filled="$(awk -v p="$pct" -v n="$SEGMENTS" 'BEGIN {
    v = (p / 100.0) * n
    printf "%d", (v - int(v) >= 0.5) ? int(v) + 1 : int(v)
  }')"
  (( filled < 0 )) && filled=0
  (( filled > SEGMENTS )) && filled=$SEGMENTS

  local empty=$(( SEGMENTS - filled ))

  local fill_str="" empty_str="" i
  for (( i = 0; i < filled; i++ )); do
    fill_str+="$GLYPH_FILL"
  done
  for (( i = 0; i < empty; i++ )); do
    empty_str+="$GLYPH_EMPTY"
  done

  printf '\033[38;5;%sm%s\033[38;5;%sm%s\033[38;5;%sm%s\033[38;5;%sm%s%b' \
    "$COLOR_TRACK" "$GLYPH_WALL_L" \
    "$color" "$fill_str" \
    "$COLOR_TRACK" "$empty_str" \
    "$COLOR_TRACK" "$GLYPH_WALL_R" \
    "$RESET"
}

# fmt_reset <epoch_seconds> -> echoes a short human countdown to that epoch.
fmt_reset() {
  local epoch="$1"
  if ! [[ "$epoch" =~ ^[0-9]+$ ]]; then
    echo "0m"
    return
  fi

  local now delta
  now="$(date +%s)"
  delta=$(( epoch - now ))

  if (( delta <= 0 )); then
    echo "0m"
    return
  fi

  if (( delta < SEC_PER_HOUR )); then
    echo "$(( delta / SEC_PER_MIN ))m"
  elif (( delta < SEC_PER_DAY )); then
    local h=$(( delta / SEC_PER_HOUR ))
    local m=$(( (delta % SEC_PER_HOUR) / SEC_PER_MIN ))
    echo "${h}h ${m}m"
  else
    local d=$(( delta / SEC_PER_DAY ))
    local h=$(( (delta % SEC_PER_DAY) / SEC_PER_HOUR ))
    echo "${d}d ${h}h"
  fi
}

# round_pct <number> -> echoes the nearest integer, defaulting to 0 for
# anything that isn't a plain number (missing field, null, garbage).
round_pct() {
  local val="$1"
  if ! [[ "$val" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
    echo 0
    return
  fi
  awk -v v="$val" 'BEGIN { printf "%d", (v < 0) ? 0 : v + 0.5 }'
}

# tint <color> <text> -> echoes text wrapped in the given 256-color SGR code.
tint() {
  local color="$1" text="$2"
  printf '\033[38;5;%sm%s%b' "$color" "$text" "$RESET"
}

# dim <text> -> tint at the standard dim-grey (percentages / reset text /
# row1 org-model-effort text).
dim() {
  tint "$COLOR_DIM" "$1"
}

main() {
  command -v jq >/dev/null 2>&1 || {
    echo "cc-usage-bar: jq not installed"
    return 0
  }

  local input
  input="$(cat)"

  # Validate JSON up front; jq errors from here on would otherwise be
  # swallowed piecemeal and could produce partial/garbled output.
  echo "$input" | jq -e . >/dev/null 2>&1 || {
    echo "cc-usage-bar: unavailable"
    return 0
  }

  local model_name effort_level ctx_pct
  model_name="$(echo "$input" | jq -r '.model.display_name // empty')"
  effort_level="$(echo "$input" | jq -r '.effort.level // empty')"
  ctx_pct="$(echo "$input" | jq -r '.context_window.used_percentage // empty')"

  local has_limits
  has_limits="$(echo "$input" | jq -r 'if (.rate_limits // null) == null then "0" else "1" end')"

  local five_hour_pct five_hour_reset week_pct week_reset
  if [[ "$has_limits" == "1" ]]; then
    five_hour_pct="$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')"
    five_hour_reset="$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')"
    week_pct="$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')"
    week_reset="$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')"
  fi

  # Account identity: a SEPARATE file from stdin, read defensively. Never
  # touch .credentials.json / any token — only .oauthAccount from this file.
  local account_file="$HOME/.claude.json"
  local email="" org=""
  if [[ -r "$account_file" ]]; then
    local account_json
    account_json="$(cat "$account_file" 2>/dev/null)"
    if echo "$account_json" | jq -e . >/dev/null 2>&1; then
      email="$(echo "$account_json" | jq -r '.oauthAccount.emailAddress // empty')"
      org="$(echo "$account_json" | jq -r '.oauthAccount.organizationName // empty')"
    fi
  fi

  # --- Row 1: identity + model/effort --------------------------------------
  local row1="  "
  if [[ -n "$email" || -n "$org" ]]; then
    local id_part=""
    [[ -n "$org" ]] && id_part+="$(dim "$org")"
    [[ -n "$org" && -n "$email" ]] && id_part+="$(dim " · ")"
    [[ -n "$email" ]] && id_part+="$(tint "$COLOR_EMAIL" "$email")"
    row1+="$id_part"
    row1+="    "
  fi

  if [[ -n "$model_name" ]]; then
    if [[ -n "$effort_level" ]]; then
      row1+="$(dim "${model_name} · ${effort_level}")"
    else
      row1+="$(dim "${model_name}")"
    fi
  fi

  # --- Row 2: 5H / WEEK / CTX capsule meters -------------------------------
  # Groups separated by a dim middot with wide padding; items within a group
  # keep a single even space, so proximity reads as grouping.
  local row2="" GROUP_SEP
  GROUP_SEP="   $(dim "·")   "
  if [[ "$has_limits" == "1" ]]; then
    local five_int week_int
    five_int="$(round_pct "$five_hour_pct")"
    week_int="$(round_pct "$week_pct")"
    row2+="$(tint "$COLOR_LABEL_5H" "5H") $(render_capsule "$five_int") $(dim "$(printf '%3d%%' "$five_int")") $(dim "↻ $(fmt_reset "$five_hour_reset")")"
    row2+="$GROUP_SEP"
    row2+="$(tint "$COLOR_LABEL_WK" "WK") $(render_capsule "$week_int") $(dim "$(printf '%3d%%' "$week_int")") $(dim "↻ $(fmt_reset "$week_reset")")"
  else
    row2+="$(tint "$COLOR_LABEL_5H" "5H") $(dim "—")"
    row2+="$GROUP_SEP"
    row2+="$(tint "$COLOR_LABEL_WK" "WK") $(dim "—")"
  fi

  if [[ -n "$ctx_pct" ]]; then
    local ctx_int
    ctx_int="$(round_pct "$ctx_pct")"
    row2+="$GROUP_SEP"
    row2+="$(tint "$COLOR_LABEL_CTX" "CTX") $(render_capsule "$ctx_int") $(dim "$(printf '%3d%%' "$ctx_int")")"
  fi

  printf '%s\n%s\n' "$row1" "$row2"
}

# `set -u` makes bash hard-exit the *entire process* on an unbound variable
# in non-interactive mode (this is not caught by a plain `main || fallback`
# at the top level — the interpreter exits before the `||` ever runs).
# Running main inside a command substitution confines that hard-exit to the
# subshell, so the parent script survives and can fall back cleanly for
# every failure mode: bad JSON, missing field, unset var, or a jq error.
output="$(main 2>/dev/null)"
status=$?

if [[ "$status" -eq 0 && -n "$output" ]]; then
  printf '%s\n' "$output"
else
  echo "cc-usage-bar: unavailable"
fi

exit 0
