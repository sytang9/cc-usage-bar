#!/usr/bin/env bash
# ccswitch_sidebar_contract_test.sh -- the file and JSON format between ccswitch and the VS Code sidebar.
# Runs the REAL ./ccswitch in a sandboxed HOME (a stub curl stands in for the usage API), then
# tests/ccswitch_sidebar_contract_test.js reads what it wrote with vscode/extension.js's own readers:
#   .usage-cache          (write_usage_cache)    -> readSnapshot
#   .usage-history.jsonl  (append_usage_history) -> readHistory
#   `usage --json` stdout (usage_json_document)  -> parseUsageJson, mergeLogins, login_health
# The expected values come from the stub API's answers, so a field renamed on either side fails here.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/ccswitch"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not found (needed to run the sidebar's readers)"
  exit 1
fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-contract-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
HOME_DIR="$SANDBOX/home" STUB_BIN="$SANDBOX/bin" CTL="$SANDBOX/ctl"
mkdir -p "$HOME_DIR/.claude/accounts" "$STUB_BIN" "$CTL"

# Stub curl: answers the usage endpoint with $CTL/<bearer token>.body (status 200); anything else 500.
# The bearer token travels in a --config file, as fetch_usage_raw sends it.
cat >"$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
url="" config="" prev=""
for a in "$@"; do
  [[ "$prev" == "--config" ]] && config="$a"
  [[ "$a" == http* ]] && url="$a"
  prev="$a"
done
token="$(grep -o 'Authorization: Bearer [^"]*' "$config" 2>/dev/null | head -1)"
token="${token#Authorization: Bearer }"
if [[ "$url" == *"/api/oauth/usage" && -n "$token" && -f "$CTL/$token.body" ]]; then
  printf '%s\n200' "$(cat "$CTL/$token.body")"
else
  printf '{}\n500'
fi
STUB
# Stub refresh transport: every refresh is rejected, so an expired account is a dead login.
cat >"$STUB_BIN/refresh-helper" <<'STUB'
#!/usr/bin/env bash
printf '{"error":"invalid_grant"}\n400'
STUB
chmod +x "$STUB_BIN/curl" "$STUB_BIN/refresh-helper"

# save_account <label> <access> <expires_ms>: a saved account as `ccswitch save` leaves it.
save_account() {
  local dir="$HOME_DIR/.claude/accounts/$1"
  mkdir -p "$dir"
  jq -cn --arg a "$2" --arg r "REFRESH_$1" --argjson e "$3" \
    '{claudeAiOauth: {accessToken: $a, refreshToken: $r, expiresAt: $e}}' >"$dir/credentials.json"
  jq -cn --arg u "uuid-$1" '{accountUuid: $u}' >"$dir/oauthAccount.json"
  chmod 700 "$dir"
  chmod 600 "$dir/credentials.json" "$dir/oauthAccount.json"
}
future_ms=$((($(date +%s) + 3600) * 1000))
save_account alpha TOK_ALPHA "$future_ms"
save_account beta TOK_BETA "$future_ms"
save_account gamma TOK_GAMMA 1000  # expired, and the refresh is rejected -> re-login

iso() { date -u -d "@$1" +"%Y-%m-%dT%H:%M:%S.000000+00:00"; }
# answer <token> <p5> <p7> <r5|null> <r7>: the usage API's reply for one token; prints the expected
# history point {p5, p7, r5, r7} that ccswitch should store for it.
answer() {
  local r5iso=null
  [[ "$4" == null ]] || r5iso="\"$(iso "$4")\""
  jq -cn --argjson p5 "$2" --argjson p7 "$3" --argjson r5 "$r5iso" --arg r7 "$(iso "$5")" \
    '{five_hour: {utilization: $p5, resets_at: $r5}, seven_day: {utilization: $p7, resets_at: $r7}}' >"$CTL/$1.body"
  jq -cn --argjson p5 "$2" --argjson p7 "$3" --argjson r5 "$4" --argjson r7 "$5" '{p5: $p5, p7: $p7, r5: $r5, r7: $r7}'
}

# run_ccswitch <args...>: the real ccswitch against the sandbox; stdout to $SANDBOX/out, stderr to $SANDBOX/err.
run_ccswitch() {
  PATH="$STUB_BIN:$PATH" HOME="$HOME_DIR" CODEX_HOME="$HOME_DIR/.codex" CTL="$CTL" \
    CCSWITCH_REFRESH_CMD="$STUB_BIN/refresh-helper" bash "$TARGET" usage "$@" \
    </dev/null >"$SANDBOX/out" 2>"$SANDBOX/err"
}

base=$(($(date +%s) / 60 * 60 + 7200))
rc=0

# Run 1: the table (`usage`), one live fetch per live account.
a1="$(answer TOK_ALPHA 37.5 62 "$((base + 3600))" "$((base + 86400 * 3))")"
b1="$(answer TOK_BETA 0 12 null "$((base + 86400 * 5))")"
s1=$(date +%s)
run_ccswitch --no-switch || { echo "FAIL: ccswitch usage exited non-zero: $(head -3 "$SANDBOX/err")"; rc=1; }
e1=$(date +%s)

# Run 2: new numbers, `usage --json --refresh` (past the 10-min cache), as the sidebar's reload button runs it.
sleep 1  # run 2's fetched_at must differ from run 1's, or the windows below overlap
a2="$(answer TOK_ALPHA 41 63.25 "$((base + 3600))" "$((base + 86400 * 3))")"
b2="$(answer TOK_BETA 0 13 null "$((base + 86400 * 5))")"  # 5h at 0%: the API sends no 5h reset
s2=$(date +%s)
run_ccswitch --json --refresh || { echo "FAIL: ccswitch usage --json exited non-zero: $(head -3 "$SANDBOX/err")"; rc=1; }
e2=$(date +%s)
cp "$SANDBOX/out" "$SANDBOX/usage.json"

jq -n --argjson s1 "$s1" --argjson e1 "$e1" --argjson s2 "$s2" --argjson e2 "$e2" \
  --argjson a1 "$a1" --argjson a2 "$a2" --argjson b1 "$b1" --argjson b2 "$b2" \
  '{run1: {start: $s1, end: $e1}, run2: {start: $s2, end: $e2},
    accounts: {alpha: {run1: $a1, run2: $a2}, beta: {run1: $b1, run2: $b2}},
    labels: ["alpha", "beta", "gamma"], relogin: ["gamma"]}' >"$SANDBOX/expect.json"

# The reader's guard: without the sandbox marker it must refuse (exit 2) before reading anything.
HOME="$HOME_DIR" CODEX_HOME="$HOME_DIR/.codex" CCUB_TEST_SANDBOX='' \
  node "$SCRIPT_DIR/ccswitch_sidebar_contract_test.js" "$SANDBOX/expect.json" "$SANDBOX/usage.json" >/dev/null 2>&1
guard_rc=$?
if [[ "$guard_rc" -eq 2 ]]; then
  echo "PASS: guard refuses a run without the sandbox marker"
else
  echo "FAIL: guard did not refuse a run without the sandbox marker (exit=$guard_rc)"
  rc=1
fi

HOME="$HOME_DIR" CODEX_HOME="$HOME_DIR/.codex" CCUB_TEST_SANDBOX=1 \
  node "$SCRIPT_DIR/ccswitch_sidebar_contract_test.js" "$SANDBOX/expect.json" "$SANDBOX/usage.json" || rc=1
exit "$rc"
