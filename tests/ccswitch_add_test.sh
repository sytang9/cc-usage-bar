#!/usr/bin/env bash
# Test harness for `ccswitch add`. Fake HOME, fake `claude` on PATH; never
# runs a real login and never touches the real ~/.claude*.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$(cd "$SCRIPT_DIR/.." && pwd)/ccswitch"

FAIL_COUNT=0
PASS_COUNT=0
pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
file_mode() { stat -c '%a' "$1" 2>/dev/null; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ccswitch-add-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
HOME_DIR="$ROOT/home"
BIN="$ROOT/bin"
SCRATCH="$ROOT/tmp" # TMPDIR for ccswitch, so leftover temp dirs are visible
mkdir -p "$HOME_DIR/.claude" "$BIN" "$SCRATCH"

# Fake claude. FAKE_MODE: ok | fail | nocreds | noaccount.
cat >"$BIN/claude" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >"$FAKE_ARGS"
echo "$CLAUDE_CONFIG_DIR" >"$FAKE_DIR"
env | grep -E '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=' >"$FAKE_DIR.env"
if [[ "${FAKE_MODE:-ok}" == "hang" ]]; then sleep 30; exit 1; fi
stat -c %a "$CLAUDE_CONFIG_DIR" >"$FAKE_DIR.mode"
[[ "${FAKE_MODE:-ok}" == "fail" ]] && exit 1
d="$CLAUDE_CONFIG_DIR"
if [[ "$FAKE_MODE" != "nocreds" ]]; then
  tok=NEW_REFRESH
  [[ "$FAKE_MODE" == "emptytoken" ]] && tok=""
  echo '{"claudeAiOauth":{"accessToken":"NEW_ACCESS","refreshToken":"'"$tok"'"}}' >"$d/.credentials.json"
  chmod 644 "$d/.credentials.json"
fi
if [[ "$FAKE_MODE" == "emptyacct" ]]; then
  echo '{"oauthAccount":{}}' >"$d/.claude.json"
elif [[ "$FAKE_MODE" == "noaccount" ]]; then
  echo '{"other":1}' >"$d/.claude.json"
else
  # FAKE_UUID picks the identity; the default is unique per login, so tests do not collide.
  echo '{"other":1,"oauthAccount":{"emailAddress":"new@x.com","accountUuid":"'"${FAKE_UUID:-uuid-$$}"'"}}' >"$d/.claude.json"
fi
exit 0
FAKE
chmod +x "$BIN/claude"

# jq shim: fails a call whose arguments include $FAKE_JQ_FAIL_ON (an interrupted write), else runs the real jq.
JQBIN="$ROOT/jqbin"
mkdir -p "$JQBIN"
REAL_JQ="$(command -v jq)"
cat >"$JQBIN/jq" <<FAKE
#!/usr/bin/env bash
if [[ -n "\${FAKE_JQ_FAIL_ON:-}" ]]; then
  for a in "\$@"; do [[ "\$a" == "\$FAKE_JQ_FAIL_ON" ]] && exit 1; done
fi
exec "$REAL_JQ" "\$@"
FAKE
chmod +x "$JQBIN/jq"

echo '{"oauthAccount":{"emailAddress":"live@x.com","accountUuid":"uuid-live"}}' >"$HOME_DIR/.claude.json"
echo '{"claudeAiOauth":{"refreshToken":"LIVE_REFRESH"}}' >"$HOME_DIR/.claude/.credentials.json"
chmod 600 "$HOME_DIR/.claude/.credentials.json"
LIVE_SUM="$(cat "$HOME_DIR/.claude.json" "$HOME_DIR/.claude/.credentials.json" | sha256sum)"
ACC="$HOME_DIR/.claude/accounts"

# run_add <mode> <stdin> <args...> -> OUT, EXIT_CODE
run_add() {
  local mode="$1" input="$2"
  shift 2
  rm -f "$ROOT/args" "$ROOT/dir" "$ROOT/dir.mode"
  OUT="$(HOME="$HOME_DIR" PATH="$JQBIN:$BIN:$PATH" TMPDIR="$SCRATCH" FAKE_MODE="$mode" \
    FAKE_ARGS="$ROOT/args" FAKE_DIR="$ROOT/dir" FAKE_UUID="${FAKE_UUID:-}" FAKE_JQ_FAIL_ON="${FAKE_JQ_FAIL_ON:-}" \
    CCSWITCH_SNAPSHOT_LOCK_WAIT_SECONDS="${CCSWITCH_SNAPSHOT_LOCK_WAIT_SECONDS:-60}" \
    bash "$TARGET" "$@" <<<"$input" 2>&1)"
  EXIT_CODE=$?
}
no_temp_left() { [[ -z "$(ls -A "$SCRATCH")" ]] && [[ ! -d "$(cat "$ROOT/dir" 2>/dev/null)" ]]; }
live_unchanged() { [[ "$(cat "$HOME_DIR/.claude.json" "$HOME_DIR/.claude/.credentials.json" | sha256sum)" == "$LIVE_SUM" ]]; }

# 1. success
run_add ok "" add work --email a@b.com
if [[ $EXIT_CODE -eq 0 ]] \
  && [[ "$(jq -r .claudeAiOauth.refreshToken "$ACC/work/credentials.json")" == "NEW_REFRESH" ]] \
  && [[ "$(jq -r .emailAddress "$ACC/work/oauthAccount.json")" == "new@x.com" ]] \
  && [[ "$(file_mode "$ACC/work/credentials.json")" == "600" ]] \
  && [[ "$(file_mode "$ACC/work/oauthAccount.json")" == "600" ]] \
  && [[ "$(file_mode "$ACC/work")" == "700" ]] \
  && grep -q "Saved account 'work'. Switch with: ccswitch work" <<<"$OUT"; then
  pass "add saves credentials + oauthAccount with right content and modes"
else fail "add success (exit=$EXIT_CODE): $OUT"; fi

# 2. live files untouched, no switch
if live_unchanged; then pass "live ~/.claude.json and credentials byte-identical"; else fail "live files changed"; fi

# 3. temp dir gone after success
if no_temp_left; then pass "temp dir removed after success"; else fail "temp dir left after success"; fi

# 4. extra args reach claude auth login
if [[ "$(cat "$ROOT/args")" == "auth login --email a@b.com" ]]; then pass "extra args reach claude auth login"; else fail "args: $(cat "$ROOT/args")"; fi

# 5. login failure
run_add fail "" add bad
if [[ $EXIT_CODE -ne 0 ]] && [[ ! -e "$ACC/bad" ]] && grep -q "login failed" <<<"$OUT" && no_temp_left && live_unchanged; then
  pass "login failure saves nothing, exits non-zero, cleans temp"
else fail "login failure (exit=$EXIT_CODE): $OUT"; fi

# 6. missing credentials
run_add nocreds "" add nocred
if [[ $EXIT_CODE -ne 0 ]] && [[ ! -e "$ACC/nocred" ]] && grep -q "no Claude credentials" <<<"$OUT" && no_temp_left; then
  pass "missing .credentials.json errors, nothing saved"
else fail "missing creds (exit=$EXIT_CODE): $OUT"; fi

# 7. missing oauthAccount: warn, save credentials with empty identity
run_add noaccount "" add noacct
if [[ $EXIT_CODE -eq 0 ]] && grep -q "Warning: login did not record account details" <<<"$OUT" \
  && [[ "$(jq -c . "$ACC/noacct/oauthAccount.json")" == "{}" ]] \
  && [[ "$(jq -r .claudeAiOauth.refreshToken "$ACC/noacct/credentials.json")" == "NEW_REFRESH" ]] && no_temp_left; then
  pass "missing oauthAccount warns and saves credentials with {}"
else fail "missing oauthAccount (exit=$EXIT_CODE): $OUT"; fi

# 7b. empty refreshToken and empty oauthAccount object
run_add emptytoken "" add et
if [[ $EXIT_CODE -ne 0 ]] && [[ ! -e "$ACC/et" ]]; then pass "empty refreshToken rejected, nothing saved"; else fail "empty token (exit=$EXIT_CODE): $OUT"; fi
run_add emptyacct "" add ea
if [[ $EXIT_CODE -eq 0 ]] && grep -q "Warning" <<<"$OUT"; then pass "empty oauthAccount object treated as missing"; else fail "empty acct (exit=$EXIT_CODE): $OUT"; fi

# 7c. login dir is private (mode 700)
run_add ok "" add modechk
if [[ "$(cat "$ROOT/dir.mode")" == "700" ]]; then pass "login temp dir has mode 700"; else fail "login dir mode $(cat "$ROOT/dir.mode")"; fi

# 8. reserved label
run_add ok "" add add
if [[ $EXIT_CODE -ne 0 ]] && grep -q "reserved word" <<<"$OUT" && [[ ! -e "$ROOT/args" ]]; then
  pass "'add' rejected as a label (claude not run)"
else fail "reserved add (exit=$EXIT_CODE): $OUT"; fi

# 9. overwrite prompt: 'n' keeps old, claude not run
run_add ok "n" add work
if [[ $EXIT_CODE -eq 0 ]] && grep -q "Aborted" <<<"$OUT" && [[ ! -e "$ROOT/args" ]]; then
  pass "existing label asks before overwrite; 'n' aborts before login"
else fail "overwrite prompt (exit=$EXIT_CODE): $OUT"; fi

# 10. claude missing from PATH
OUT="$(HOME="$HOME_DIR" PATH="/usr/bin:/bin" TMPDIR="$SCRATCH" bash -c 'hash -r; command -v claude >/dev/null && exit 99; exec bash "$0" add x' "$TARGET" 2>&1)"
EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]] && grep -q "'claude' is not on PATH" <<<"$OUT"; then pass "missing claude gives clear error"; else fail "no claude (exit=$EXIT_CODE): $OUT"; fi

# 11. auth env vars do not reach the login child
export CLAUDE_CODE_OAUTH_TOKEN=x ANTHROPIC_API_KEY=y ANTHROPIC_AUTH_TOKEN=z
run_add ok "" add envchk
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
if [[ $EXIT_CODE -eq 0 ]] && [[ -f "$ROOT/dir.env" ]] && [[ ! -s "$ROOT/dir.env" ]]; then
  pass "login child does not see CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN"
else fail "auth env leaked: $(cat "$ROOT/dir.env" 2>/dev/null)"; fi

# 12. existing label + y + failed login keeps the old account byte-identical
OLD_SUM="$(cat "$ACC/work/credentials.json" "$ACC/work/oauthAccount.json" | sha256sum)"
run_add fail "y" add work
if [[ $EXIT_CODE -ne 0 ]] && grep -q "login failed" <<<"$OUT" \
  && [[ "$(cat "$ACC/work/credentials.json" "$ACC/work/oauthAccount.json" | sha256sum)" == "$OLD_SUM" ]] && no_temp_left; then
  pass "overwrite 'y' + failed login keeps the old account unchanged"
else fail "kept account (exit=$EXIT_CODE): $OUT"; fi

# --- re-add over a label, duplicates, the refresh lock (review of #24) ---
pair_sum() { cat "$ACC/$1/credentials.json" "$ACC/$1/oauthAccount.json" | sha256sum; }
no_staging_left() { [[ -z "$(find "$ACC" -maxdepth 1 -name '.*' -type d ! -name '.refresh-lock' | head -n1)" ]]; }
uuid_of() { jq -r .accountUuid "$ACC/$1/oauthAccount.json"; }
rt_of() { jq -r .claudeAiOauth.refreshToken "$ACC/$1/credentials.json"; }

# 14. the account just logged in is already saved under another label: warn, name it, default no
WORK_UUID="$(uuid_of work)"
FAKE_UUID="$WORK_UUID" run_add ok "" add twin
# Non-zero, so the sidebar's Add account terminal (`&& exit`) stays open on "Aborted; nothing saved."
if [[ $EXIT_CODE -eq 1 ]] && grep -q "already saved as 'work'" <<<"$OUT" && grep -q "Aborted" <<<"$OUT" \
  && [[ ! -e "$ACC/twin" ]] && no_temp_left && no_staging_left; then
  pass "a login already saved under another label warns, names it, and saves nothing by default"
else fail "duplicate label (exit=$EXIT_CODE): $OUT"; fi
FAKE_UUID="$WORK_UUID" run_add ok "y" add twin
if [[ $EXIT_CODE -eq 0 ]] && [[ "$(uuid_of twin)" == "$WORK_UUID" ]]; then
  pass "answering y saves the second copy"
else fail "duplicate y (exit=$EXIT_CODE): $OUT"; fi
rm -rf "$ACC/twin"

# 15. the account just logged in is the live account (not saved anywhere): warn, default no
FAKE_UUID=uuid-live run_add ok "" add livecopy
if [[ $EXIT_CODE -eq 1 ]] && grep -q "logged in to now" <<<"$OUT" && grep -q "Aborted" <<<"$OUT" \
  && [[ ! -e "$ACC/livecopy" ]] && no_temp_left && live_unchanged; then
  pass "a login of the live account warns and saves nothing by default"
else fail "duplicate live (exit=$EXIT_CODE): $OUT"; fi

# 16. an interrupted write (the identity file write fails) leaves the old pair byte-identical
OLD_SUM="$(pair_sum work)"
FAKE_UUID=uuid-other FAKE_JQ_FAIL_ON='.oauthAccount // {}' run_add ok "y" add work
if [[ $EXIT_CODE -ne 0 ]] && [[ "$(pair_sum work)" == "$OLD_SUM" ]] && no_temp_left && no_staging_left; then
  pass "a failed identity write keeps the old credentials + oauthAccount pair intact"
else fail "interrupted write (exit=$EXIT_CODE, sum same: $([[ "$(pair_sum work)" == "$OLD_SUM" ]] && echo y || echo n)): $OUT"; fi

# 17. a new identity over a label: the old account's marker, usage cache and history go
plant_dotfiles() {
  : >"$ACC/work/.refresh-inflight"
  echo '{"fetched_at":1}' >"$ACC/work/.usage-cache"
  echo '{"t":1}' >"$ACC/work/.usage-history.jsonl"
  "$REAL_JQ" ".claudeAiOauth.refreshToken = \"$1\"" "$ACC/work/credentials.json" >"$ROOT/c" && mv "$ROOT/c" "$ACC/work/credentials.json"
}
plant_dotfiles OLD_REFRESH
FAKE_UUID=uuid-other run_add ok "y" add work
if [[ $EXIT_CODE -eq 0 ]] && [[ "$(rt_of work)" == "NEW_REFRESH" ]] && [[ "$(uuid_of work)" == "uuid-other" ]] \
  && [[ ! -e "$ACC/work/.refresh-inflight" ]] && [[ ! -e "$ACC/work/.usage-cache" ]] && [[ ! -e "$ACC/work/.usage-history.jsonl" ]] \
  && [[ "$(file_mode "$ACC/work")" == "700" ]] && no_staging_left; then
  pass "a new identity drops the old .refresh-inflight, .usage-cache and .usage-history.jsonl"
else fail "identity change (exit=$EXIT_CODE): $(ls -A "$ACC/work") $OUT"; fi

# 18. the same account re-saved keeps its usage cache and history; a stale marker never meets the new token
plant_dotfiles OLD_REFRESH
FAKE_UUID=uuid-other run_add ok "y" add work
if [[ $EXIT_CODE -eq 0 ]] && [[ "$(rt_of work)" == "NEW_REFRESH" ]] && [[ ! -e "$ACC/work/.refresh-inflight" ]] \
  && [[ -e "$ACC/work/.usage-cache" ]] && [[ -e "$ACC/work/.usage-history.jsonl" ]]; then
  pass "same account re-saved: cache and history kept, the stale marker gone (it cannot blank the new token)"
else fail "same identity (exit=$EXIT_CODE): $(ls -A "$ACC/work") $OUT"; fi
plant_dotfiles NEW_REFRESH
FAKE_UUID=uuid-other run_add ok "y" add work
if [[ $EXIT_CODE -eq 0 ]] && [[ -e "$ACC/work/.refresh-inflight" ]]; then
  pass "a marker for the very token that is saved again stays (that token's outcome is still unknown)"
else fail "same token marker (exit=$EXIT_CODE): $(ls -A "$ACC/work") $OUT"; fi
rm -f "$ACC/work/.refresh-inflight"

# 19. a usage run holding the refresh lock: add waits for it, and its write-back does not win
sleep 60 &
HOLDER=$!
mkdir "$ACC/.refresh-lock" && echo "$HOLDER" >"$ACC/.refresh-lock/pid"
rm -f "$ROOT/dir.mode"
HOME="$HOME_DIR" PATH="$BIN:$PATH" TMPDIR="$SCRATCH" FAKE_MODE=ok FAKE_UUID=uuid-lock \
  FAKE_ARGS="$ROOT/args" FAKE_DIR="$ROOT/dir" CCSWITCH_SNAPSHOT_LOCK_WAIT_SECONDS=30 \
  bash "$TARGET" add work <<<"y" >"$ROOT/lock.out" 2>&1 &
ADD_PID=$!
for _ in $(seq 1 100); do [[ -s "$ROOT/dir.mode" ]] && break; sleep 0.1; done
sleep 1.5
SWAPPED_EARLY=0
[[ "$(uuid_of work)" == "uuid-lock" ]] && SWAPPED_EARLY=1
echo '{"claudeAiOauth":{"accessToken":"USAGE_ACCESS","refreshToken":"USAGE_ROTATED"}}' >"$ACC/work/credentials.json"
rm -rf "$ACC/.refresh-lock"
wait "$ADD_PID"
ADD_EXIT=$?
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
if [[ $SWAPPED_EARLY -eq 0 ]] && [[ $ADD_EXIT -eq 0 ]] && [[ "$(rt_of work)" == "NEW_REFRESH" ]] \
  && [[ "$(uuid_of work)" == "uuid-lock" ]] && [[ ! -e "$ACC/.refresh-lock" ]] && no_staging_left; then
  pass "add waits for the refresh lock; a usage write-back under the lock does not overwrite the new login"
else fail "lock wait (early=$SWAPPED_EARLY exit=$ADD_EXIT): $(cat "$ROOT/lock.out")"; fi

# 20. the lock is never freed: add fails clearly and writes nothing
sleep 60 &
HOLDER=$!
mkdir "$ACC/.refresh-lock" && echo "$HOLDER" >"$ACC/.refresh-lock/pid"
OLD_SUM="$(pair_sum work)"
CCSWITCH_SNAPSHOT_LOCK_WAIT_SECONDS=1 FAKE_UUID=uuid-busy run_add ok "y" add work
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
if [[ $EXIT_CODE -ne 0 ]] && grep -q "another ccswitch" <<<"$OUT" && grep -q "log in again" <<<"$OUT" \
  && grep -q "Waiting for another ccswitch to finish refreshing" <<<"$OUT" && [[ "$(pair_sum work)" == "$OLD_SUM" ]] \
  && [[ -d "$ACC/.refresh-lock" ]] && no_temp_left && no_staging_left; then
  pass "a busy refresh lock: add fails with a clear message, the old pair intact, the other run's lock kept"
else fail "lock busy (exit=$EXIT_CODE): $OUT"; fi
rm -rf "$ACC/.refresh-lock"

# 21. a signal between the two renames (old snapshot moved aside, new one not yet in):
# the trap puts the old snapshot back under the label. An mv shim sends INT to
# ccswitch right after the first rename.
MVBIN="$ROOT/mvbin"
mkdir -p "$MVBIN"
REAL_MV="$(command -v mv)"
cat >"$MVBIN/mv" <<FAKE
#!/usr/bin/env bash
"$REAL_MV" "\$@"; rc=\$?
[[ "\$1" == "$ACC/work" ]] && kill -INT "\$PPID"
exit "\$rc"
FAKE
chmod +x "$MVBIN/mv"
OLD_SUM="$(pair_sum work)"
OLD_LS="$(ls -A "$ACC/work")"
OUT="$(HOME="$HOME_DIR" PATH="$MVBIN:$BIN:$PATH" TMPDIR="$SCRATCH" FAKE_MODE=ok FAKE_UUID=uuid-mid \
  FAKE_ARGS="$ROOT/args" FAKE_DIR="$ROOT/dir" bash "$TARGET" add work <<<"y" 2>&1)"
EXIT_CODE=$?
if [[ $EXIT_CODE -eq 130 ]] && [[ "$(pair_sum work 2>/dev/null)" == "$OLD_SUM" ]] && [[ "$(ls -A "$ACC/work" 2>/dev/null)" == "$OLD_LS" ]] \
  && [[ ! -e "$ACC/.refresh-lock" ]] && no_temp_left && no_staging_left; then
  pass "a signal between the two renames restores the old snapshot under its label"
else fail "mid-swap signal (exit=$EXIT_CODE): $(ls -A "$ACC") $OUT"; fi

# 13. Ctrl-C during the login deletes the temp dir and saves nothing.
# A bare `&` job ignores SIGINT, so start in a new session with the default
# signal action and signal the whole group, as a terminal Ctrl-C does.
rm -f "$ROOT/dir" "$ROOT/dir.mode" "$ROOT/pid" "$ROOT/sig.out"
HOME="$HOME_DIR" PATH="$BIN:$PATH" TMPDIR="$SCRATCH" FAKE_MODE=hang \
  FAKE_ARGS="$ROOT/args" FAKE_DIR="$ROOT/dir" \
  setsid bash -c 'echo $$ >"$1"; shift; exec env --default-signal=INT,QUIT "$@"' _ "$ROOT/pid" \
  bash "$TARGET" add sigtest </dev/null >"$ROOT/sig.out" 2>&1 &
for _ in $(seq 1 100); do [[ -s "$ROOT/dir.mode" ]] && break; sleep 0.1; done
SIG_PID="$(cat "$ROOT/pid" 2>/dev/null)"
STARTED=0; [[ -d "$(cat "$ROOT/dir" 2>/dev/null)" ]] && STARTED=1
[[ -n "$SIG_PID" ]] && kill -INT -- "-$SIG_PID" 2>/dev/null
for _ in $(seq 1 100); do kill -0 "$SIG_PID" 2>/dev/null || break; sleep 0.1; done
if [[ $STARTED -eq 1 ]] && ! kill -0 "$SIG_PID" 2>/dev/null && [[ ! -e "$ACC/sigtest" ]] && no_temp_left; then
  pass "Ctrl-C during login deletes the temp dir and saves nothing"
else
  fail "SIGINT (started=$STARTED): $(cat "$ROOT/sig.out" 2>/dev/null)"
  [[ -n "$SIG_PID" ]] && kill -KILL -- "-$SIG_PID" 2>/dev/null
fi

echo
echo "----------------------------------------"
echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
