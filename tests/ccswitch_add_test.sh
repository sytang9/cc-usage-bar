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
  echo '{"other":1,"oauthAccount":{"emailAddress":"new@x.com","accountUuid":"uuid-new"}}' >"$d/.claude.json"
fi
exit 0
FAKE
chmod +x "$BIN/claude"

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
  OUT="$(HOME="$HOME_DIR" PATH="$BIN:$PATH" TMPDIR="$SCRATCH" FAKE_MODE="$mode" \
    FAKE_ARGS="$ROOT/args" FAKE_DIR="$ROOT/dir" bash "$TARGET" "$@" <<<"$input" 2>&1)"
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

echo
echo "----------------------------------------"
echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
