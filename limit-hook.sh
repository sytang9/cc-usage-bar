#!/usr/bin/env bash
# limit-hook.sh -- Claude Code StopFailure hook (install.sh adds it with the
# matcher "rate_limit"). Claude Code runs it when a turn ends on an API error;
# on a rate limit it writes the time to ~/.claude/accounts/.limit-hit. The VS
# Code sidebar watches that file: it fetches live usage at once and can
# auto-switch, instead of waiting for its next 5-minute fetch.
#
# A rate_limit can also be a capacity cut, not the account's usage limit, so
# this only says "look now". The sidebar's live usage numbers decide.
#
# Contract: fast, writes nothing else, never fails the session (always exit 0).
set -u

input="$(cat 2>/dev/null)"  # read all of stdin, so Claude Code never gets EPIPE

# The matcher already filters on the error; this check covers a settings.json
# entry without it. Without jq, trust the matcher.
if command -v jq >/dev/null 2>&1; then
  error="$(printf '%s' "$input" | jq -r '.error // empty' 2>/dev/null)"
  [[ -z "$error" || "$error" == "rate_limit" ]] || exit 0
fi

dir="$HOME/.claude/accounts"
[[ -d "$dir" ]] || exit 0  # no ccswitch accounts: nothing to switch to

tmp="$dir/.limit-hit.$$.tmp"
if printf '{"t":%s}\n' "$(date +%s)" >"$tmp" 2>/dev/null; then
  mv -f "$tmp" "$dir/.limit-hit" 2>/dev/null || rm -f "$tmp"
fi
exit 0
