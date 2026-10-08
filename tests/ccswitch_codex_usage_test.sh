#!/usr/bin/env bash
# Test harness for the read-only Codex row in `ccswitch usage`.
#
# Same conventions as ccswitch_usage_test.sh: plain bash, sandboxed HOME and
# CODEX_HOME under mktemp -d, and a fake `curl` early on PATH. The stub answers
# the Codex endpoint from files a case writes first, answers the Claude usage
# endpoint with a fixed 200, and counts every call so a case can prove a
# request was (or was not) made. No real credentials, no network.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/ccswitch"
REAL_FIXTURE="$SCRIPT_DIR/fixtures/codex_wham_weekly_only.json"

FAIL_COUNT=0
PASS_COUNT=0

# Every byte of output, every cache file and every curl argv across the suite,
# so the security case can scan all of them for the planted secrets at once.
ALL_OUTPUT_LOG="$(mktemp "${TMPDIR:-/tmp}/ccswitch-codex-test-out.XXXXXX")"
ALL_CACHE_LOG="$(mktemp "${TMPDIR:-/tmp}/ccswitch-codex-test-cache.XXXXXX")"
ALL_ARGV_LOG="$(mktemp "${TMPDIR:-/tmp}/ccswitch-codex-test-argv.XXXXXX")"
STUB_BIN="$(mktemp -d "${TMPDIR:-/tmp}/ccswitch-codex-test-stubbin.XXXXXX")"

CODEX_ACCOUNT_SECRET="CODEX_ACCT_SECRET_0001"
CODEX_SUB_SECRET="CODEX_SUB_SECRET_0002"
# Every Codex access token a case builds is recorded here for the leak scan.
CODEX_TOKENS=()

pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

write_curl_stub() {
  cat >"$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
# Fake curl. Follows ccswitch's --config indirection to read the headers, so it
# sees the same request a real server would without the token touching argv.
set -uo pipefail
: "${CURL_STUB_DIR:?CURL_STUB_DIR must be set for the curl stub}"
url="" config_file="" prev=""
for a in "$@"; do
  [[ "$prev" == "--config" ]] && config_file="$a"
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
mkdir -p "$CURL_STUB_DIR/calls"
printf '%q ' "$0" "$@" >>"$CURL_STUB_DIR/calls/argv.log"
printf '\n' >>"$CURL_STUB_DIR/calls/argv.log"

if [[ "$url" == "https://chatgpt.com/backend-api/wham/usage" ]]; then
  echo x >>"$CURL_STUB_DIR/calls/wham_count"
  # Record whether each required header arrived with the expected value,
  # never the value itself.
  grep -qF "Authorization: Bearer $(cat "$CURL_STUB_DIR/expect_token" 2>/dev/null)\"" "$config_file" \
    && echo auth_ok >>"$CURL_STUB_DIR/calls/headers"
  grep -qF "ChatGPT-Account-Id: $(cat "$CURL_STUB_DIR/expect_account" 2>/dev/null)\"" "$config_file" \
    && echo account_ok >>"$CURL_STUB_DIR/calls/headers"
  grep -q 'User-Agent: codex_cli_rs/' "$config_file" \
    && echo ua_ok >>"$CURL_STUB_DIR/calls/headers"
  grep -qE '^max-time = [0-9]+$' "$config_file" \
    && echo maxtime_ok >>"$CURL_STUB_DIR/calls/headers"
  status="$(cat "$CURL_STUB_DIR/wham.status" 2>/dev/null)"
  body="$(cat "$CURL_STUB_DIR/wham.body" 2>/dev/null)"
  [[ -z "$body" ]] && body='{}'
  printf '%s\n%s' "$body" "${status:-500}"
elif [[ "$url" == *"/api/oauth/usage" ]]; then
  echo x >>"$CURL_STUB_DIR/calls/claude_count"
  cat "$CURL_STUB_DIR/claude.body"
  printf '\n200'
else
  echo x >>"$CURL_STUB_DIR/calls/other_count"
  printf '{}\n500'
fi
STUB
  chmod +x "$STUB_BIN/curl"
}

# new_env -> a sandbox dir holding home/, codex/ and ctl/ (stub control).
new_env() {
  local env
  env="$(mktemp -d "${TMPDIR:-/tmp}/ccswitch-codex-test-env.XXXXXX")"
  mkdir -p "$env/home" "$env/codex" "$env/ctl/calls"
  : >"$env/ctl/calls/wham_count"
  : >"$env/ctl/calls/claude_count"
  : >"$env/ctl/calls/other_count"
  : >"$env/ctl/calls/headers"
  echo "$env"
}

# b64url <text> -> unpadded base64url, the JWT segment encoding.
b64url() {
  printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='
}

# make_jwt <exp_epoch> -> an unsigned JWT-shaped string carrying that exp.
make_jwt() {
  local header payload
  header="$(b64url '{"alg":"none","typ":"JWT"}')"
  payload="$(b64url "$(jq -cn --argjson exp "$1" --arg sub "$CODEX_SUB_SECRET" '{exp: $exp, sub: $sub}')")"
  printf '%s.%s.SIG_%s' "$header" "$payload" "$1"
}

# setup_claude <env> <five_pct> <week_pct>: one saved, active Claude account
# whose usage GET answers 200, so the table renders exactly as it does today.
setup_claude() {
  local env="$1" five="$2" week="$3" exp_ms reset_iso
  exp_ms=$(( ($(date +%s) + 3600) * 1000 ))
  mkdir -p "$env/home/.claude/accounts/work"
  jq -cn --argjson exp "$exp_ms" \
    '{claudeAiOauth: {accessToken: "TOK_CLAUDE_WORK", refreshToken: "REFRESH_CLAUDE_WORK", expiresAt: $exp}}' \
    >"$env/home/.claude/.credentials.json"
  cp "$env/home/.claude/.credentials.json" "$env/home/.claude/accounts/work/credentials.json"
  jq -cn '{oauthAccount: {accountUuid: "UUID_WORK"}}' >"$env/home/.claude.json"
  jq -cn '{accountUuid: "UUID_WORK"}' >"$env/home/.claude/accounts/work/oauthAccount.json"
  chmod 700 "$env/home/.claude/accounts/work"
  chmod 600 "$env/home/.claude/.credentials.json" "$env/home/.claude/accounts/work/"*.json
  # Mid-bucket reset (10 days + 30 min renders "10d 0h" for the next 30 min),
  # so runs compared byte for byte in case6 cannot straddle a countdown tick.
  reset_iso="$(date -u -d "@$(( $(date +%s) + 865800 ))" +"%Y-%m-%dT%H:%M:%S.000000+00:00")"
  jq -cn --argjson f "$five" --argjson w "$week" --arg r "$reset_iso" \
    '{five_hour: {utilization: $f, resets_at: $r}, seven_day: {utilization: $w, resets_at: $r}}' \
    >"$env/ctl/claude.body"
}

# write_codex_auth <env> <auth_mode> <exp_epoch>: a Codex CLI auth.json.
write_codex_auth() {
  local env="$1" mode="$2" exp="$3" token
  token="$(make_jwt "$exp")"
  CODEX_TOKENS+=("$token")
  printf '%s' "$token" >"$env/ctl/expect_token"
  printf '%s' "$CODEX_ACCOUNT_SECRET" >"$env/ctl/expect_account"
  jq -cn --arg mode "$mode" --arg at "$token" --arg acct "$CODEX_ACCOUNT_SECRET" \
    '{auth_mode: $mode, OPENAI_API_KEY: null, last_refresh: "2026-10-01T00:00:00Z",
      tokens: {access_token: $at, account_id: $acct, id_token: "ID_TOKEN_X", refresh_token: "CODEX_REFRESH_SECRET"}}' \
    >"$env/codex/auth.json"
  chmod 600 "$env/codex/auth.json"
}

set_wham() {
  local env="$1" status="$2" body="$3"
  printf '%s' "$status" >"$env/ctl/wham.status"
  printf '%s' "$body" >"$env/ctl/wham.body"
}

future() { echo $(( $(date +%s) + $1 )); }

# window <used_pct> <window_seconds> <reset_at> -> one rate_limit window object.
window() {
  jq -cn --argjson u "$1" --argjson w "$2" --argjson r "$3" \
    '{used_percent: $u, limit_window_seconds: $w, reset_after_seconds: 100, reset_at: $r}'
}

# wham_body <primary_json|null> <secondary_json|null>
wham_body() {
  jq -cn --argjson p "$1" --argjson s "$2" \
    '{plan_type: "plus", rate_limit: {allowed: true, limit_reached: false, primary_window: $p, secondary_window: $s}}'
}

# run_cc <env> <codex_home_mode: set|unset> <stdin> <args...>
# "unset" leaves CODEX_HOME out of the environment, so ccswitch falls back to
# $HOME/.codex -- the sandbox home, which has none.
run_cc() {
  local env="$1" codex_mode="$2" stdin_text="$3"
  shift 3
  local -a extra_env=(-u CODEX_HOME)
  [[ "$codex_mode" == "set" ]] && extra_env=(CODEX_HOME="$env/codex")
  OUT="$(env "${extra_env[@]}" PATH="$STUB_BIN:$PATH" HOME="$env/home" CURL_STUB_DIR="$env/ctl" \
    CCSWITCH_REFRESH_CMD=/bin/false bash "$TARGET" usage "$@" <<<"$stdin_text" 2>&1)"
  EXIT_CODE=$?
  printf '%s\n' "$OUT" >>"$ALL_OUTPUT_LOG"
  cat "$env/ctl/calls/argv.log" >>"$ALL_ARGV_LOG" 2>/dev/null || true
  cat "$env/codex/.usage-cache" >>"$ALL_CACHE_LOG" 2>/dev/null || true
  PLAIN="$(printf '%s' "$OUT" | sed 's/\x1b\[[0-9;]*m//g')"
}

count() { wc -l <"$1/ctl/calls/$2" | tr -d '[:space:]'; }
cache_get() { jq -c "$2" "$1/codex/.usage-cache" 2>/dev/null; }
codex_line() { printf '%s\n' "$PLAIN" | grep -E '^  codex ' ; }

# --- Case 1: the real endpoint response (weekly window only, in primary) ----
case1_weekly_only_real_fixture() {
  local env keys mode
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  set_wham "$env" 200 "$(cat "$REAL_FIXTURE")"
  run_cc "$env" set "" --no-switch

  keys="$(jq -c 'keys' "$env/codex/.usage-cache" 2>/dev/null)"
  mode="$(stat -c '%a' "$env/codex/.usage-cache" 2>/dev/null)"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$(cache_get "$env" .seven_day_pct)" == "0" ]] \
    && [[ "$(cache_get "$env" .five_hour_pct)" == "null" ]] \
    && [[ "$(cache_get "$env" .seven_day_reset_epoch)" == "1791885739" ]] \
    && [[ "$(cache_get "$env" .five_hour_reset_epoch)" == "null" ]] \
    && [[ "$(cache_get "$env" .rate_limited_until)" == "null" ]] \
    && [[ "$(cache_get "$env" .plan_type)" == '"prolite"' ]] \
    && [[ "$(cache_get "$env" '.fetched_at | type')" == '"number"' ]] \
    && [[ "$keys" == '["fetched_at","five_hour_pct","five_hour_reset_epoch","plan_type","rate_limited_until","seven_day_pct","seven_day_reset_epoch"]' ]] \
    && [[ "$mode" == "600" ]] \
    && [[ "$(printf '%s\n' "$PLAIN" | tail -n1)" == "  codex "* ]] \
    && codex_line | grep -qE '^  codex +— +·+ +0% ' \
    && [[ "$(count "$env" wham_count)" == "1" ]]; then
    pass "case1 weekly-only real fixture -> seven_day_pct 0, five_hour null, codex row last"
  else
    fail "case1 weekly-only real fixture (exit=$EXIT_CODE keys=$keys mode=$mode cache=$(cat "$env/codex/.usage-cache" 2>/dev/null))"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 2: windows map by length, not by slot name ------------------------
case2_swapped_slots() {
  local env r5 r7
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  r5="$(future 7200)"; r7="$(future 300000)"
  # Weekly in primary, 5-hour in secondary: the reverse of the old layout.
  set_wham "$env" 200 "$(wham_body "$(window 7 604800 "$r7")" "$(window 42 18000 "$r5")")"
  run_cc "$env" set "" --no-switch

  if [[ "$(cache_get "$env" .five_hour_pct)" == "42" ]] \
    && [[ "$(cache_get "$env" .seven_day_pct)" == "7" ]] \
    && [[ "$(cache_get "$env" .five_hour_reset_epoch)" == "$r5" ]] \
    && [[ "$(cache_get "$env" .seven_day_reset_epoch)" == "$r7" ]] \
    && codex_line | grep -qE ' 42% .* 7% '; then
    pass "case2 swapped primary/secondary slots map by limit_window_seconds"
  else
    fail "case2 swapped slots (cache=$(cat "$env/codex/.usage-cache" 2>/dev/null))"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 2b: an unknown window length is ignored ---------------------------
case2b_unknown_window_ignored() {
  local env r7
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  r7="$(future 300000)"
  set_wham "$env" 200 "$(wham_body "$(window 55 86400 "$r7")" "$(window 9 604800 "$r7")")"
  run_cc "$env" set "" --no-switch

  if [[ "$(cache_get "$env" .five_hour_pct)" == "null" ]] \
    && [[ "$(cache_get "$env" .seven_day_pct)" == "9" ]]; then
    pass "case2b a window of unknown length is ignored"
  else
    fail "case2b unknown window (cache=$(cat "$env/codex/.usage-cache" 2>/dev/null))"
  fi
  rm -rf "$env"
}

# --- Case 3: 429 sets rate_limited_until and keeps the last good numbers ----
case3_rate_limited() {
  local env now rl
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  now="$(date +%s)"
  # A stale (past-TTL) good cache, so the run has a reason to call the endpoint.
  jq -cn --argjson fa "$((now - 5000))" \
    '{fetched_at: $fa, five_hour_pct: 31, seven_day_pct: 12, five_hour_reset_epoch: null, seven_day_reset_epoch: null, rate_limited_until: null, plan_type: "plus"}' \
    >"$env/codex/.usage-cache"
  set_wham "$env" 429 '{"error":"rate limited"}'
  run_cc "$env" set "" --no-switch
  rl="$(cache_get "$env" .rate_limited_until)"

  # A second run inside the backoff window must not call the endpoint again.
  run_cc "$env" set "" --no-switch --refresh

  if [[ "$rl" =~ ^[0-9]+$ ]] && (( rl > now )) \
    && [[ "$(cache_get "$env" .five_hour_pct)" == "31" ]] \
    && [[ "$(cache_get "$env" .fetched_at)" == "$((now - 5000))" ]] \
    && codex_line | grep -qE ' 31% .* 12% ' \
    && [[ "$(count "$env" wham_count)" == "1" ]] \
    && [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "case3 429 sets rate_limited_until, keeps cached numbers, honors backoff"
  else
    fail "case3 429 (rl=$rl calls=$(count "$env" wham_count) cache=$(cat "$env/codex/.usage-cache" 2>/dev/null))"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 3b: 429 with no prior cache still records the backoff -------------
case3b_rate_limited_no_cache() {
  local env rl
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  set_wham "$env" 429 '{}'
  run_cc "$env" set "" --no-switch
  rl="$(cache_get "$env" .rate_limited_until)"

  if [[ "$rl" =~ ^[0-9]+$ ]] \
    && [[ "$(cache_get "$env" '.fetched_at | type')" == '"number"' ]] \
    && [[ "$(cache_get "$env" .seven_day_pct)" == "null" ]] \
    && codex_line | grep -q 'rate-limited'; then
    pass "case3b 429 with no prior cache records rate_limited_until and shows rate-limited"
  else
    fail "case3b 429 no cache (cache=$(cat "$env/codex/.usage-cache" 2>/dev/null))"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 4: 401 never overwrites the cache and never refreshes --------------
case4_unauthorized_keeps_cache() {
  local env before after auth_before auth_after
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  jq -cn '{fetched_at: 1000, five_hour_pct: 5, seven_day_pct: 6, five_hour_reset_epoch: null, seven_day_reset_epoch: null, rate_limited_until: null, plan_type: "plus"}' \
    >"$env/codex/.usage-cache"
  before="$(cat "$env/codex/.usage-cache")"
  auth_before="$(sha256sum <"$env/codex/auth.json")"
  set_wham "$env" 401 '{"error":"unauthorized"}'
  run_cc "$env" set "" --no-switch
  after="$(cat "$env/codex/.usage-cache")"
  auth_after="$(sha256sum <"$env/codex/auth.json")"

  if [[ "$before" == "$after" ]] && [[ "$auth_before" == "$auth_after" ]] \
    && codex_line | grep -q 'expired' \
    && [[ "$(count "$env" other_count)" == "0" ]] \
    && [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "case4 401 leaves cache and auth.json untouched, row shows expired"
  else
    fail "case4 401 (after=$after other=$(count "$env" other_count))"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 5: an expired JWT never reaches the network ------------------------
case5_expired_jwt_no_call() {
  local env
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(( $(date +%s) - 100 ))"
  set_wham "$env" 200 "$(cat "$REAL_FIXTURE")"
  run_cc "$env" set "" --no-switch

  if [[ "$(count "$env" wham_count)" == "0" ]] \
    && [[ "$(count "$env" other_count)" == "0" ]] \
    && [[ ! -e "$env/codex/.usage-cache" ]] \
    && codex_line | grep -q 'expired' \
    && [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "case5 expired JWT -> no curl call, no cache, row shows expired"
  else
    fail "case5 expired JWT (wham=$(count "$env" wham_count))"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 6: no auth.json / API-key mode -> no row, unchanged behavior --------
case6_no_codex_auth_unchanged() {
  local env base_out base_exit apikey_out apikey_exit
  env="$(new_env)"
  setup_claude "$env" 10 20

  # Baseline: CODEX_HOME unset and no ~/.codex at all.
  run_cc "$env" unset "" --no-switch
  base_out="$PLAIN"; base_exit="$EXIT_CODE"

  # CODEX_HOME set but empty dir (no auth.json).
  run_cc "$env" set "" --no-switch
  local empty_out="$PLAIN" empty_exit="$EXIT_CODE"

  # API-key mode auth.json.
  write_codex_auth "$env" apikey "$(future 864000)"
  set_wham "$env" 200 "$(cat "$REAL_FIXTURE")"
  run_cc "$env" set "" --no-switch
  apikey_out="$PLAIN"; apikey_exit="$EXIT_CODE"

  if [[ "$base_exit" -eq 0 ]] && [[ "$empty_exit" -eq 0 ]] && [[ "$apikey_exit" -eq 0 ]] \
    && [[ "$base_out" == "$empty_out" ]] && [[ "$base_out" == "$apikey_out" ]] \
    && ! printf '%s' "$base_out" | grep -q 'codex' \
    && printf '%s' "$base_out" | grep -q 'work' \
    && [[ "$(count "$env" wham_count)" == "0" ]] \
    && [[ ! -e "$env/codex/.usage-cache" ]] \
    && [[ ! -e "$env/home/.codex" ]]; then
    pass "case6 no auth.json / api-key mode -> no codex row, output and exit unchanged"
  else
    fail "case6 no codex auth (wham=$(count "$env" wham_count))"
    printf '%s\n---\n%s\n---\n%s\n' "$base_out" "$empty_out" "$apikey_out"
  fi
  rm -rf "$env"
}

# --- Case 7: headers arrive, via the config file only -------------------------
case7_headers_via_config() {
  local env headers
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  set_wham "$env" 200 "$(cat "$REAL_FIXTURE")"
  run_cc "$env" set "" --no-switch
  headers="$(sort "$env/ctl/calls/headers" | tr '\n' ' ')"

  if [[ "$headers" == "account_ok auth_ok maxtime_ok ua_ok " ]]; then
    pass "case7 Authorization, ChatGPT-Account-Id, User-Agent and a max-time sent"
  else
    fail "case7 headers (got: $headers)"
  fi
  rm -rf "$env"
}

# --- Case 8: TTL cache, headroom and the switch prompt ignore codex ----------
case8_cache_headroom_switch() {
  local env creds_before creds_after r5
  env="$(new_env)"
  # The Claude account is nearly full; codex is idle. Headroom must still name
  # the Claude account, because codex is not a switch target.
  setup_claude "$env" 90 95
  write_codex_auth "$env" chatgpt "$(future 864000)"
  r5="$(future 7200)"
  set_wham "$env" 200 "$(wham_body "$(window 0 18000 "$r5")" "$(window 0 604800 "$r5")")"
  run_cc "$env" set "" --no-switch
  run_cc "$env" set "" --no-switch
  local after_two
  after_two="$(count "$env" wham_count)"
  local headroom_line
  headroom_line="$(printf '%s\n' "$PLAIN" | grep 'most headroom')"

  creds_before="$(sha256sum <"$env/home/.claude/.credentials.json")"
  run_cc "$env" set "codex" --refresh
  creds_after="$(sha256sum <"$env/home/.claude/.credentials.json")"

  if [[ "$after_two" == "1" ]] \
    && [[ "$(count "$env" wham_count)" == "2" ]] \
    && [[ "$headroom_line" == *"work"* ]] && [[ "$headroom_line" != *"codex"* ]] \
    && printf '%s' "$PLAIN" | grep -q "no saved account named 'codex'" \
    && [[ "$creds_before" == "$creds_after" ]] \
    && [[ ! -d "$env/home/.claude/accounts/codex" ]]; then
    pass "case8 TTL cache reused, --refresh re-polls, codex never headroom or switch target"
  else
    fail "case8 (after_two=$after_two total=$(count "$env" wham_count) headroom='$headroom_line')"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 9: a non-JSON 200 or a 500 leaves a dash row and the cache alone ----
case9_bad_response_dash() {
  local env
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  set_wham "$env" 200 'not json'
  run_cc "$env" set "" --no-switch
  local garbage_line
  garbage_line="$(codex_line)"
  set_wham "$env" 500 '{}'
  run_cc "$env" set "" --no-switch

  if [[ ! -e "$env/codex/.usage-cache" ]] \
    && [[ "$garbage_line" =~ ^\ \ codex\ +—\ +—\  ]] \
    && codex_line | grep -qE '^  codex +— +— ' \
    && [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "case9 unparseable 200 / 500 -> dash row, no cache write"
  else
    fail "case9 bad response"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 11: a 403 is not an expired login (Cloudflare, UA, account) -------
case11_forbidden_is_not_expired() {
  local env before after
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  jq -cn '{fetched_at: 1000, five_hour_pct: 5, seven_day_pct: 6, five_hour_reset_epoch: null, seven_day_reset_epoch: null, rate_limited_until: null, plan_type: "plus"}' \
    >"$env/codex/.usage-cache"
  before="$(cat "$env/codex/.usage-cache")"
  set_wham "$env" 403 '<html>Just a moment...</html>'
  run_cc "$env" set "" --no-switch
  after="$(cat "$env/codex/.usage-cache")"

  if [[ "$before" == "$after" ]] \
    && ! codex_line | grep -q 'expired' \
    && codex_line | grep -qE '^  codex +— +— ' \
    && [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "case11 403 -> dash row, not expired, cache untouched"
  else
    fail "case11 403 (after=$after)"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

# --- Case 12: a 200 with no known window is schema drift, not a success ------
case12_no_known_window_not_cached() {
  local env r
  env="$(new_env)"
  setup_claude "$env" 10 20
  write_codex_auth "$env" chatgpt "$(future 864000)"
  r="$(future 7200)"
  set_wham "$env" 200 "$(wham_body "$(window 42 18060 "$r")" "$(window 7 604860 "$r")")"
  run_cc "$env" set "" --no-switch

  if [[ ! -e "$env/codex/.usage-cache" ]] \
    && codex_line | grep -qE '^  codex +— +— ' \
    && [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "case12 200 with no known window -> dash row, not cached as a success"
  else
    fail "case12 no known window (cache=$(cat "$env/codex/.usage-cache" 2>/dev/null))"
    printf '%s\n' "$PLAIN"
  fi
  rm -rf "$env"
}

main() {
  write_curl_stub

  case1_weekly_only_real_fixture
  case2_swapped_slots
  case2b_unknown_window_ignored
  case3_rate_limited
  case3b_rate_limited_no_cache
  case4_unauthorized_keeps_cache
  case5_expired_jwt_no_call
  case6_no_codex_auth_unchanged
  case7_headers_via_config
  case8_cache_headroom_switch
  case9_bad_response_dash
  case11_forbidden_is_not_expired
  case12_no_known_window_not_cached

  # Security, LAST so every case above has logged its output first: no Codex
  # access token, account id or JWT subject may appear in any output, any
  # cache file, or any curl argv.
  local secret leaked=0
  for secret in "${CODEX_TOKENS[@]}" "$CODEX_ACCOUNT_SECRET" "$CODEX_SUB_SECRET" CODEX_REFRESH_SECRET; do
    if grep -qF "$secret" "$ALL_OUTPUT_LOG" "$ALL_CACHE_LOG" "$ALL_ARGV_LOG"; then
      leaked=1
      echo "  leaked: a Codex secret appeared in output, cache or argv"
    fi
  done
  if [[ "$leaked" -eq 0 ]] && [[ "${#CODEX_TOKENS[@]}" -gt 0 ]] && [[ -s "$ALL_ARGV_LOG" ]]; then
    pass "case10 no Codex token or account id in output, cache or curl argv"
  else
    fail "case10 SECURITY LEAK or empty logs"
  fi

  rm -rf "$STUB_BIN" "$ALL_OUTPUT_LOG" "$ALL_CACHE_LOG" "$ALL_ARGV_LOG"

  echo
  echo "----------------------------------------"
  echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"
  [[ "$FAIL_COUNT" -gt 0 ]] && exit 1
  exit 0
}

main "$@"
