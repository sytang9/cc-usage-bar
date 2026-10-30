#!/usr/bin/env bash
# Test harness for `ccswitch schedule`. Fake HOME and a stub `crontab` backed by
# a temp file. The real crontab is never read or written: every run puts the
# stub first on PATH, and the "no crontab" case uses a PATH without one.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$(cd "$SCRIPT_DIR/.." && pwd)/ccswitch"

FAIL_COUNT=0
PASS_COUNT=0
pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ccswitch-schedule-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
HOME_DIR="$ROOT/home"
BIN="$ROOT/bin"
CRON="$ROOT/crontab.txt"
mkdir -p "$HOME_DIR/.claude" "$BIN"

# Stub crontab: -l prints the file (exit 1 + message when absent, like cron),
# - reads the new crontab from stdin.
cat >"$BIN/crontab" <<STUB
#!/usr/bin/env bash
case "\$1" in
  -l) [[ -e "$ROOT/cron.denied" ]] && { echo "crontab: permission denied" >&2; exit 1; }; [[ -f "$CRON" ]] || { echo "no crontab for test" >&2; exit 1; }; cat "$CRON" ;;
  -) cat >"$CRON" ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$BIN/crontab"

# Stub curl: every usage GET answers 200 with fixed numbers.
cat >"$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf '{"five_hour":{"utilization":12,"resets_at":"2099-01-01T00:00:00.000000+00:00"},"seven_day":{"utilization":34,"resets_at":"2099-01-02T00:00:00.000000+00:00"}}\n200'
STUB
chmod +x "$BIN/curl"
ln -s "$(command -v jq)" "$BIN/jq" # so the stub dir comes first in the cron PATH (jq is resolved first)

cc() { HOME="$HOME_DIR" PATH="$BIN:$PATH" bash "$TARGET" "$@"; }
marked() { grep -c '# ccswitch-schedule$' "$CRON" 2>/dev/null; }

rm -f "$CRON"

# 1. on adds exactly one marked line and reports it
OUT="$(cc schedule on 2>&1)"; RC=$?
LINE="$(grep '# ccswitch-schedule$' "$CRON")"
if [[ $RC -eq 0 && "$(marked)" == 1 && "$LINE" == "*/10 * * * * PATH='"*"' '$TARGET' schedule tick 10 # ccswitch-schedule" ]]; then
  pass "on adds one marked line (every 10)"
else fail "on (rc=$RC): $OUT / $LINE"; fi

# 2. the PATH in the line starts with the stub dir (jq and curl are found there) and ends with the standard dirs
if [[ "$LINE" == *"PATH='$BIN:"* && "$LINE" == *":/usr/local/bin"* && "$LINE" == *":/bin' "* ]]; then
  pass "line PATH has the dirs of curl and jq"
else fail "PATH in line: $LINE"; fi

# 3. on twice = one line; --every changes it; 60 maps to hourly
cc schedule on >/dev/null 2>&1; N1="$(marked)"
cc schedule on --every 15 >/dev/null 2>&1
if [[ "$N1" == 1 && "$(marked)" == 1 ]] && grep -q '^\*/15 \* \* \* \* PATH=' "$CRON"; then
  pass "on twice keeps one line; --every 15 replaces it"
else fail "idempotent/every: $(cat "$CRON")"; fi
cc schedule on --every 60 >/dev/null 2>&1
if grep -q '^0 \* \* \* \* PATH=' "$CRON" && [[ "$(cc schedule status --json)" == '{"on":true,"every":60}' ]]; then
  pass "--every 60 writes an hourly line and status reads 60"
else fail "every 60: $(cat "$CRON")"; fi

# 4. bad --every
BAD=0
for v in 4 61 abc ""; do cc schedule on --every "$v" >/dev/null 2>&1 && BAD=1; done
cc schedule on --every >/dev/null 2>&1 && BAD=1
if [[ $BAD -eq 0 ]]; then pass "--every outside 5..60 or not a number is refused"; else fail "bad --every accepted"; fi

# 5. other lines untouched, byte for byte, in order
printf '%s\n' '# my comment' '0 3 * * * /usr/bin/backup --all # nightly' 'MAILTO=""' >"$CRON"
cp "$CRON" "$ROOT/before"
cc schedule on >/dev/null 2>&1
if [[ "$(head -n 3 "$CRON")" == "$(cat "$ROOT/before")" && "$(marked)" == 1 && "$(wc -l <"$CRON")" == 4 ]]; then
  pass "on keeps every other line byte-for-byte"
else fail "other lines: $(cat "$CRON")"; fi

# 6. off removes only ours
cc schedule off >/dev/null 2>&1
if [[ "$(marked)" == 0 ]] && cmp -s "$CRON" "$ROOT/before"; then pass "off removes only the marked line"; else fail "off: $(cat "$CRON")"; fi

# 7. off when absent is fine and writes nothing
cp "$CRON" "$ROOT/before2"
OUT="$(cc schedule off 2>&1)"; RC=$?
if [[ $RC -eq 0 ]] && cmp -s "$CRON" "$ROOT/before2"; then pass "off when absent exits 0, crontab unchanged"; else fail "off absent (rc=$RC)"; fi
rm -f "$CRON"
OUT="$(cc schedule off 2>&1)"; RC=$?
if [[ $RC -eq 0 && ! -e "$CRON" ]]; then pass "off with no crontab at all exits 0"; else fail "off no crontab (rc=$RC)"; fi

# 8. status text and json
J="$(cc schedule status --json)"
cc schedule on --every 20 >/dev/null 2>&1
echo "2026-10-30 10:00:00 usage exited 1" >"$HOME_DIR/.claude/ccswitch-schedule.log"
S="$(cc schedule status)"; JON="$(cc schedule status --json)"
if [[ "$J" == '{"on":false,"every":null}' && "$JON" == '{"on":true,"every":20}' \
  && "$S" == *"schedule: on"* && "$S" == *"every: 20 min"* && "$S" == *"line: */20 "* && "$S" == *"log: 2026-10-30 10:00:00 usage exited 1"* ]]; then
  pass "status and status --json report on/off, interval, line, last log line"
else fail "status: $J / $JON / $S"; fi
cc schedule off >/dev/null 2>&1
if [[ "$(cc schedule status)" == "schedule: off" && "$(cc schedule)" == "schedule: off" ]]; then pass "status when off (and the bare command)"; else fail "status off"; fi

# 9. no crontab binary -> clear error, exit 2
rm -f "$CRON"
NOCRON="$ROOT/nocron"; mkdir -p "$NOCRON"
for t in bash env dirname basename mktemp rm chmod cat grep head tail wc date jq; do
  p="$(command -v "$t")" && ln -sf "$p" "$NOCRON/$t"
done
OUT="$(HOME="$HOME_DIR" PATH="$NOCRON" bash "$TARGET" schedule on 2>&1)"; RC=$?
if [[ $RC -eq 2 && "$OUT" == *"no 'crontab' command"* && ! -e "$CRON" ]]; then pass "no crontab binary: clear error, exit 2"; else fail "no crontab (rc=$RC): $OUT"; fi
HOME="$HOME_DIR" PATH="$NOCRON" bash "$TARGET" schedule status --json >/dev/null 2>&1; RC=$?
if [[ $RC -eq 2 ]]; then pass "status --json without crontab exits 2"; else fail "status no crontab rc=$RC"; fi

# 10. reserved word
OUT="$(cc save schedule 2>&1)"; RC=$?
if [[ $RC -ne 0 && "$OUT" == *"'schedule' is a reserved word"* ]]; then pass "'schedule' is a reserved label"; else fail "reserved (rc=$RC): $OUT"; fi

# 11. unknown subcommand, version
cc schedule bogus >/dev/null 2>&1; RC=$?
if [[ $RC -eq 1 && "$(cc version)" == "ccswitch 1.3.0" ]]; then pass "unknown schedule command exits 1; version 1.3.0"; else fail "bogus rc=$RC"; fi

# 12. the generated line really runs: cron's minimal env, stub curl, one saved account
ACC="$HOME_DIR/.claude/accounts/work"
mkdir -p "$ACC"; chmod 700 "$ACC"
jq -cn '{claudeAiOauth:{accessToken:"AT",refreshToken:"RT",expiresAt:99999999999999}}' >"$ACC/credentials.json"
echo '{"accountUuid":"u1"}' >"$ACC/oauthAccount.json"
chmod 600 "$ACC"/*.json
cc schedule on >/dev/null 2>&1
CMD="$(grep '# ccswitch-schedule$' "$CRON" | sed -e 's/^\*\/10 \* \* \* \* //' -e 's/ # ccswitch-schedule$//')"
env -i HOME="$HOME_DIR" sh -c "$CMD"; RC=$?
HIST="$ACC/.usage-history.jsonl"
if [[ $RC -eq 0 && -s "$HIST" && "$(tail -n 1 "$HIST" | jq -r '.p5')" == 12 ]]; then
  pass "the cron command runs under env -i and appends a history sample"
else fail "cron command (rc=$RC): $CMD / $(cat "$HIST" 2>/dev/null)"; fi

# 13. the tick skips when the cache is newer than every*60-60 s (VS Code just fetched), and samples past that,
# so a cron run a few seconds early is not lost
N0="$(wc -l <"$HIST")"
env -i HOME="$HOME_DIR" sh -c "$CMD"
N1="$(wc -l <"$HIST")"
CACHE="$ACC/.usage-cache"
jq --argjson t "$(( $(date +%s) - 530 ))" '.fetched_at = $t' "$CACHE" >"$CACHE.t" && mv "$CACHE.t" "$CACHE"
env -i HOME="$HOME_DIR" sh -c "$CMD"
N2="$(wc -l <"$HIST")"
jq --argjson t "$(( $(date +%s) - 545 ))" '.fetched_at = $t' "$CACHE" >"$CACHE.t" && mv "$CACHE.t" "$CACHE"
env -i HOME="$HOME_DIR" sh -c "$CMD"
N3="$(wc -l <"$HIST")"
if [[ "$N1" == "$N0" && "$N2" == "$N0" && "$N3" -gt "$N0" ]]; then
  pass "tick skips a cache under every*60-60 s old (530 s), fetches one over it (545 s)"
else fail "tick cache rule: $N0 $N1 $N2 $N3"; fi

# 14. the log is bounded
LOG="$HOME_DIR/.claude/ccswitch-schedule.log"
seq 1 500 >"$LOG"
env -i HOME="$HOME_DIR" sh -c "$CMD"
if [[ "$(wc -l <"$LOG")" -le 200 && "$(tail -n 1 "$LOG")" == 500 ]]; then pass "log trimmed to the last 200 lines"; else fail "log lines: $(wc -l <"$LOG")"; fi

# 15. S-1: a crontab that cannot be read is never replaced
printf '%s\n' '0 3 * * * /usr/bin/backup' >"$CRON"; cp "$CRON" "$ROOT/before3"
touch "$ROOT/cron.denied"
OUT="$(cc schedule on 2>&1)"; RC=$?
OUT2="$(cc schedule off 2>&1)"; RC2=$?
rm -f "$ROOT/cron.denied"
if [[ $RC -eq 2 && $RC2 -eq 2 && "$OUT" == *"cannot read your crontab"* && "$OUT" == *"permission denied"* && "$OUT2" == *"cannot read your crontab"* ]] && cmp -s "$CRON" "$ROOT/before3"; then
  pass "crontab -l fails (not 'no crontab'): exit 2, the crontab is left alone"
else fail "unreadable crontab (rc=$RC/$RC2): $OUT / $(cat "$CRON")"; fi

# 16. S-2: a PATH dir with ' or % is left out of the line (it would break cron's quoting)
WEIRD="$ROOT/we%ird'dir"; mkdir -p "$WEIRD"
ln -s "$(command -v node || command -v jq)" "$WEIRD/node"
rm -f "$CRON"
OUT="$(HOME="$HOME_DIR" PATH="$WEIRD:$BIN:$PATH" bash "$TARGET" schedule on 2>&1)"; RC=$?
LINE="$(grep '# ccswitch-schedule$' "$CRON")"
PATHPART="${LINE#*PATH=\'}"; PATHPART="${PATHPART%%\' *}"
if [[ $RC -eq 0 && "$PATHPART" != *%* && "$PATHPART" != *"'"* && "$PATHPART" == "$BIN:"* ]]; then
  pass "a PATH dir with a quote or percent is skipped"
else fail "weird PATH dir (rc=$RC): $LINE"; fi

# 17. S-3: --every with a leading zero is read as decimal; the line and status --json stay valid
for v in 08 010 015; do
  cc schedule on --every "$v" >/dev/null 2>&1; RC=$?
  want=$((10#$v)); J="$(cc schedule status --json)"
  if [[ $RC -eq 0 && "$J" == "{\"on\":true,\"every\":$want}" ]] && grep -q "^\*/$want \* \* \* \* PATH=.* schedule tick $want # ccswitch" "$CRON" && jq -e . <<<"$J" >/dev/null; then
    pass "--every $v is $want min (valid JSON)"
  else fail "--every $v (rc=$RC): $J / $(cat "$CRON")"; fi
done

# 18. a ccswitch path with ' or % is refused (cron cannot run it)
BADDIR="$ROOT/bad%dir"; mkdir -p "$BADDIR"; cp "$TARGET" "$BADDIR/ccswitch"
OUT="$(HOME="$HOME_DIR" PATH="$BIN:$PATH" bash "$BADDIR/ccswitch" schedule on 2>&1)"; RC=$?
if [[ $RC -eq 1 && "$OUT" == *"cannot run it"* ]]; then pass "a ccswitch path with '%' is refused"; else fail "bad path (rc=$RC): $OUT"; fi

echo
echo "schedule tests: $PASS_COUNT passed, $FAIL_COUNT failed"
[[ $FAIL_COUNT -eq 0 ]]
