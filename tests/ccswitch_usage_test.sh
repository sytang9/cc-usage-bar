#!/usr/bin/env bash
# Test harness for `ccswitch usage`.
#
# Self-contained bash; no external test framework, no real network. A fake
# `curl` is placed early on PATH and answers purely from files an individual
# test case writes first -- keyed off the request URL (usage vs token
# endpoint) and, for the usage endpoint, the bearer token; for the token
# endpoint, the refresh_token in the POST body. This lets each case dial in
# exactly the HTTP status + body it wants without touching a real network.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/ccswitch"

FAIL_COUNT=0
PASS_COUNT=0

# Accumulates every byte of stdout+stderr across every case, so the security
# case can grep the whole suite for leaked secrets in one place.
ALL_OUTPUT_LOG="$(mktemp "${TMPDIR:-/tmp}/ccswitch-usage-test-alloutput.XXXXXX")"

# Accumulates every argv the stub curl was ever invoked with (see
# write_curl_stub's argv.log), across every case's own (short-lived,
# per-case) CURL_STUB_DIR. This is what proves tokens never travel as a
# literal curl argv argument -- the actual /proc/<pid>/cmdline exposure the
# --config / -d @file switch in ccswitch defends against.
ALL_ARGV_LOG="$(mktemp "${TMPDIR:-/tmp}/ccswitch-usage-test-allargv.XXXXXX")"

# One shared stub-curl bin dir for the whole suite; each case gets its own
# CURL_STUB_DIR (control dir) so cache/counter files never leak between cases.
STUB_BIN="$(mktemp -d "${TMPDIR:-/tmp}/ccswitch-usage-test-stubbin.XXXXXX")"

# Distinctive secrets planted in fixtures across every case below. None of
# these -- nor any other accessToken/refreshToken this suite ever writes --
# may appear in any captured output.
SECRET_TOKENS=(
  TOK_ACTIVE_5H80 TOK_OTHER_5H20 TOK_GOOD TOK_BAD TOK_C_OLD TOK_C_NEW
  TOK_D_OLD REFRESH_ACTIVE REFRESH_OTHER REFRESH_GOOD REFRESH_BAD
  REFRESH_C REFRESH_C_ROTATED REFRESH_D TOK_CACHE REFRESH_CACHE
  TOK_SWITCHA TOK_SWITCHB REFRESH_SWITCHA REFRESH_SWITCHB
  TOK_GARBAGE TOK_PARTNER REFRESH_GARBAGE REFRESH_PARTNER
  TOK_RATELIMIT REFRESH_RATELIMIT
)

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
# Fake curl for ccswitch_usage_test.sh. Answers from files under
# $CURL_STUB_DIR, keyed by request URL + (bearer token | refresh_token).
# Mirrors the real curl invocations' `-w '\n%{http_code}'` convention:
# prints "<body>\n<status>" with no trailing newline after status.
#
# ccswitch keeps secrets OUT of argv (see fetch_usage_raw/refresh_token):
# the bearer token travels via a --config file, the refresh body via
# `-d @file`. This stub follows those same indirections rather than
# expecting the secret to be a literal argv string.
set -uo pipefail

url="" token="" body_data="" config_file="" prev=""
for a in "$@"; do
  if [[ "$prev" == "--config" ]]; then
    config_file="$a"
  fi
  if [[ "$prev" == "-d" ]]; then
    case "$a" in
      @*) body_data="$(cat "${a#@}" 2>/dev/null)" ;;
      *) body_data="$a" ;;
    esac
  fi
  case "$a" in
    http*) url="$a" ;;
  esac
  prev="$a"
done

if [[ -n "$config_file" ]]; then
  token="$(grep -o 'Authorization: Bearer [^"]*' "$config_file" 2>/dev/null | head -1)"
  token="${token#Authorization: Bearer }"
fi

: "${CURL_STUB_DIR:?CURL_STUB_DIR must be set for the curl stub}"
mkdir -p "$CURL_STUB_DIR/calls"

# Log every argv this stub was ever invoked with, so the suite can assert
# (from the OUTSIDE, on the real strings this process was launched with)
# that no secret ever traveled as a literal argv argument -- exactly the
# /proc/<pid>/cmdline exposure the --config / -d @file switch defends
# against. %q quotes each arg so embedded spaces/specials are visible as
# distinct tokens rather than merging together.
printf '%q ' "$0" "$@" >>"$CURL_STUB_DIR/calls/argv.log"
printf '\n' >>"$CURL_STUB_DIR/calls/argv.log"

respond_from() {
  local dir="$1" key="$2"
  local status body
  status="$(cat "$dir/${key}.status" 2>/dev/null)"
  body="$(cat "$dir/${key}.body" 2>/dev/null)"
  [[ -z "$status" ]] && status=500
  [[ -z "$body" ]] && body='{}'
  printf '%s\n%s' "$body" "$status"
}

if [[ "$url" == *"/api/oauth/usage" ]]; then
  echo x >>"$CURL_STUB_DIR/calls/usage_count"
  respond_from "$CURL_STUB_DIR/usage" "$token"
elif [[ "$url" == *"/oauth/token" ]]; then
  echo x >>"$CURL_STUB_DIR/calls/token_count"
  rt="$(printf '%s' "$body_data" | jq -r '.refresh_token // empty' 2>/dev/null)"
  respond_from "$CURL_STUB_DIR/token" "$rt"
else
  printf '{}\n500'
fi
STUB
  chmod +x "$STUB_BIN/curl"
}

new_home() {
  mktemp -d "${TMPDIR:-/tmp}/ccswitch-usage-test-home.XXXXXX"
}

new_ctl() {
  local ctl
  ctl="$(mktemp -d "${TMPDIR:-/tmp}/ccswitch-usage-test-ctl.XXXXXX")"
  mkdir -p "$ctl/usage" "$ctl/token" "$ctl/calls"
  echo "$ctl"
}

usage_call_count() {
  wc -l <"$1/calls/usage_count" 2>/dev/null || echo 0
}

token_call_count() {
  wc -l <"$1/calls/token_count" 2>/dev/null || echo 0
}

# run_cc <home> <ctl> <stdin_text> <args...>
run_cc() {
  local home="$1" ctl="$2" stdin_text="$3"
  shift 3
  OUT="$(PATH="$STUB_BIN:$PATH" HOME="$home" CURL_STUB_DIR="$ctl" bash "$TARGET" usage "$@" <<<"$stdin_text" 2>&1)"
  EXIT_CODE=$?
  printf '%s\n' "$OUT" >>"$ALL_OUTPUT_LOG"
  cat "$ctl/calls/argv.log" >>"$ALL_ARGV_LOG" 2>/dev/null || true
}

write_live_credentials() {
  local home="$1" refresh="$2" access="$3" expires_ms="$4"
  mkdir -p "$home/.claude"
  jq -cn --arg refresh "$refresh" --arg access "$access" --argjson exp "$expires_ms" \
    '{claudeAiOauth: {accessToken: $access, refreshToken: $refresh, expiresAt: $exp}}' \
    >"$home/.claude/.credentials.json"
  chmod 600 "$home/.claude/.credentials.json"
}

# write_claude_json <home> [account_uuid] -> the live .claude.json.
# Active-account detection is anchored on .oauthAccount.accountUuid (NOT
# refreshToken, which rotates), so any case that needs the '*' marker /
# is_active_account to fire must pass a uuid here that also appears in
# that account's oauthAccount.json snapshot (write_account_oauth below).
write_claude_json() {
  local home="$1" uuid="${2:-}"
  jq -cn --arg uuid "$uuid" '{oauthAccount: (if $uuid == "" then {} else {accountUuid: $uuid} end)}' \
    >"$home/.claude.json"
}

write_account_credentials() {
  local home="$1" label="$2" refresh="$3" access="$4" expires_ms="$5"
  mkdir -p "$home/.claude/accounts/$label"
  jq -cn --arg refresh "$refresh" --arg access "$access" --argjson exp "$expires_ms" \
    '{claudeAiOauth: {accessToken: $access, refreshToken: $refresh, expiresAt: $exp}}' \
    >"$home/.claude/accounts/$label/credentials.json"
  chmod 600 "$home/.claude/accounts/$label/credentials.json"
  chmod 700 "$home/.claude/accounts/$label"
}

# write_account_oauth <home> <label> <account_uuid> -> the saved
# oauthAccount.json snapshot cmd_save would normally produce. Only the
# accountUuid field matters for active-account detection.
write_account_oauth() {
  local home="$1" label="$2" uuid="$3"
  mkdir -p "$home/.claude/accounts/$label"
  jq -cn --arg uuid "$uuid" '{accountUuid: $uuid}' \
    >"$home/.claude/accounts/$label/oauthAccount.json"
  chmod 600 "$home/.claude/accounts/$label/oauthAccount.json"
}

set_usage_response() {
  local ctl="$1" token="$2" status="$3" body="$4"
  printf '%s' "$status" >"$ctl/usage/${token}.status"
  printf '%s' "$body" >"$ctl/usage/${token}.body"
}

set_token_response() {
  local ctl="$1" refresh="$2" status="$3" body="$4"
  printf '%s' "$status" >"$ctl/token/${refresh}.status"
  printf '%s' "$body" >"$ctl/token/${refresh}.body"
}

usage_body() {
  local five="$1" week="$2"
  local reset_epoch reset_iso
  reset_epoch=$(( $(date +%s) + 3600 ))
  reset_iso="$(date -u -d "@$reset_epoch" +"%Y-%m-%dT%H:%M:%S.000000+00:00")"
  jq -cn --argjson five "$five" --argjson week "$week" --arg reset "$reset_iso" \
    '{five_hour: {utilization: $five, resets_at: $reset}, seven_day: {utilization: $week, resets_at: $reset}}'
}

# usage_body_5hnull <five> <week> -> like usage_body but five_hour.resets_at is
# null, exactly as the real API returns it when 5-hour usage is 0%. The weekly
# reset stays present. Used to prove such a row still renders (regression: it
# used to be discarded entirely).
usage_body_5hnull() {
  local five="$1" week="$2" reset_epoch reset_iso
  reset_epoch=$(( $(date +%s) + 7200 ))
  reset_iso="$(date -u -d "@$reset_epoch" +"%Y-%m-%dT%H:%M:%S.000000+00:00")"
  jq -cn --argjson five "$five" --argjson week "$week" --arg reset "$reset_iso" \
    '{five_hour: {utilization: $five, resets_at: null}, seven_day: {utilization: $week, resets_at: $reset}}'
}

# refresh_success_body <new_access> [new_refresh] -> a realistic refresh
# response: real refresh tokens rotate, so this always includes a
# refresh_token field (tests assert it gets persisted back).
refresh_success_body() {
  local new_access="$1" new_refresh="${2:-REFRESH_C_ROTATED}"
  jq -cn --arg at "$new_access" --arg rt "$new_refresh" \
    '{access_token: $at, expires_in: 28800, refresh_token: $rt, token_type: "Bearer"}'
}

future_ms() {
  echo $(( ($(date +%s) + 3600) * 1000 ))
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null
}

main() {
  if [[ ! -x "$TARGET" ]]; then
    echo "FAIL: target script not found or not executable: $TARGET"
    exit 1
  fi

  write_curl_stub

  # =========================================================================
  # Case 1: two saved accounts, both 200 -> table renders both, percentages
  # present, '*' on active, most-headroom marker on the lower-5h row.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home" "UUID_ACTIVE"
    write_live_credentials "$home" "REFRESH_ACTIVE" "TOK_ACTIVE_5H80" "$(future_ms)"
    write_account_credentials "$home" "acct_active" "REFRESH_ACTIVE" "TOK_ACTIVE_5H80" "$(future_ms)"
    write_account_oauth "$home" "acct_active" "UUID_ACTIVE"
    write_account_credentials "$home" "acct_other" "REFRESH_OTHER" "TOK_OTHER_5H20" "$(future_ms)"
    write_account_oauth "$home" "acct_other" "UUID_OTHER"

    set_usage_response "$ctl" "TOK_ACTIVE_5H80" 200 "$(usage_body 80 50)"
    set_usage_response "$ctl" "TOK_OTHER_5H20" 200 "$(usage_body 20 10)"

    run_cc "$home" "$ctl" "" --no-switch

    local active_line other_line
    active_line="$(printf '%s' "$OUT" | grep "acct_active")"
    other_line="$(printf '%s' "$OUT" | grep "acct_other")"

    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$active_line" | grep -q '\* acct_active' \
      && printf '%s' "$active_line" | grep -q '80%' \
      && printf '%s' "$other_line" | grep -q '20%' \
      && printf '%s' "$other_line" | grep -q 'most headroom' \
      && ! printf '%s' "$active_line" | grep -q 'most headroom'; then
      pass "case1 two accounts render, active marked, most-headroom on lower-5h row"
    else
      fail "case1 (exit=$EXIT_CODE): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 2: one account non-2xx -> its row shows em-dash, the other renders.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_good" "REFRESH_GOOD" "TOK_GOOD" "$(future_ms)"
    write_account_credentials "$home" "acct_bad" "REFRESH_BAD" "TOK_BAD" "$(future_ms)"

    set_usage_response "$ctl" "TOK_GOOD" 200 "$(usage_body 33 44)"
    set_usage_response "$ctl" "TOK_BAD" 503 '{"error":"server error"}'

    run_cc "$home" "$ctl" "" --no-switch

    local good_line bad_line
    good_line="$(printf '%s' "$OUT" | grep "acct_good")"
    bad_line="$(printf '%s' "$OUT" | grep "acct_bad")"

    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$good_line" | grep -q '33%' \
      && printf '%s' "$bad_line" | grep -q $'\xe2\x80\x94'; then
      pass "case2 non-2xx row shows em-dash, other account still renders"
    else
      fail "case2 (exit=$EXIT_CODE): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 2b: HTTP 200 but a schema-mismatched body (parse_usage fails) -> that
  # account's row degrades to the dash placeholder, the other still renders.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_partner" "REFRESH_PARTNER" "TOK_PARTNER" "$(future_ms)"
    write_account_credentials "$home" "acct_garbage" "REFRESH_GARBAGE" "TOK_GARBAGE" "$(future_ms)"

    set_usage_response "$ctl" "TOK_PARTNER" 200 "$(usage_body 41 22)"
    set_usage_response "$ctl" "TOK_GARBAGE" 200 '{"garbage":true}'

    run_cc "$home" "$ctl" "" --no-switch

    local partner_line garbage_line
    partner_line="$(printf '%s' "$OUT" | grep "acct_partner")"
    garbage_line="$(printf '%s' "$OUT" | grep "acct_garbage")"

    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$partner_line" | grep -q '41%' \
      && printf '%s' "$garbage_line" | grep -q $'\xe2\x80\x94'; then
      pass "case2b 200-with-schema-mismatch degrades to dash, other account still renders"
    else
      fail "case2b (exit=$EXIT_CODE): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 2c: HTTP 429 -> row degrades to dash and the backoff is recorded;
  # a second call (even with --refresh) within the 120s window must not
  # re-hit the usage stub.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_ratelimit" "REFRESH_RATELIMIT" "TOK_RATELIMIT" "$(future_ms)"
    set_usage_response "$ctl" "TOK_RATELIMIT" 429 '{"error":"rate limited"}'

    run_cc "$home" "$ctl" "" --no-switch
    local count_after_first line_after_first
    count_after_first="$(usage_call_count "$ctl")"
    line_after_first="$(printf '%s' "$OUT" | grep "acct_ratelimit")"

    run_cc "$home" "$ctl" "" --refresh --no-switch
    local count_after_refresh
    count_after_refresh="$(usage_call_count "$ctl")"

    if [[ "$count_after_first" -eq 1 ]] \
      && printf '%s' "$line_after_first" | grep -q $'\xe2\x80\x94' \
      && [[ "$count_after_refresh" -eq 1 ]]; then
      pass "case2c 429 degrades to dash and records a backoff that even --refresh honors"
    else
      fail "case2c (count_after_first=$count_after_first count_after_refresh=$count_after_refresh): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 3: expired accessToken + successful refresh -> stored credentials.json
  # accessToken updated, row renders normally. acct_c is ALSO the active
  # account (matching accountUuid), so this simultaneously proves: (a) the
  # rotated refresh_token from the response is persisted back into the
  # snapshot, and (b) active-account detection survives that rotation
  # because it is keyed on accountUuid, not on refreshToken equality.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home" "UUID_C"
    write_live_credentials "$home" "REFRESH_C" "TOK_C_OLD" 1
    write_account_credentials "$home" "acct_c" "REFRESH_C" "TOK_C_OLD" 1
    write_account_oauth "$home" "acct_c" "UUID_C"

    set_token_response "$ctl" "REFRESH_C" 200 "$(refresh_success_body "TOK_C_NEW" "REFRESH_C_ROTATED")"
    set_usage_response "$ctl" "TOK_C_NEW" 200 "$(usage_body 15 5)"

    run_cc "$home" "$ctl" "" --no-switch

    local stored_access stored_refresh
    stored_access="$(jq -r '.claudeAiOauth.accessToken' "$home/.claude/accounts/acct_c/credentials.json" 2>/dev/null)"
    stored_refresh="$(jq -r '.claudeAiOauth.refreshToken' "$home/.claude/accounts/acct_c/credentials.json" 2>/dev/null)"
    local acct_c_line
    acct_c_line="$(printf '%s' "$OUT" | grep "acct_c")"

    if [[ "$EXIT_CODE" -eq 0 ]] \
      && [[ "$stored_access" == "TOK_C_NEW" ]] \
      && [[ "$stored_refresh" == "REFRESH_C_ROTATED" ]] \
      && printf '%s' "$acct_c_line" | grep -q '15%' \
      && printf '%s' "$acct_c_line" | grep -q '\* acct_c'; then
      pass "case3 expired token refreshed: accessToken+rotated refreshToken persisted, row renders, still marked active (accountUuid) after rotation"
    else
      fail "case3 (exit=$EXIT_CODE stored_access=$stored_access stored_refresh=$stored_refresh): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 4: refresh stub returns failure -> row shows "re-login".
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_d" "REFRESH_D" "TOK_D_OLD" 1

    set_token_response "$ctl" "REFRESH_D" 401 '{"error":"invalid_grant"}'

    run_cc "$home" "$ctl" "" --no-switch

    local stored_access
    stored_access="$(jq -r '.claudeAiOauth.accessToken' "$home/.claude/accounts/acct_d/credentials.json" 2>/dev/null)"

    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$OUT" | grep -q 're-login' \
      && [[ "$stored_access" == "TOK_D_OLD" ]]; then
      pass "case4 refresh failure shows re-login, stored accessToken left untouched"
    else
      fail "case4 (exit=$EXIT_CODE stored_access=$stored_access): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 5: cache -- second call within TTL does not re-hit the usage stub;
  # --refresh bypasses the cache and does re-hit it.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_cache" "REFRESH_CACHE" "TOK_CACHE" "$(future_ms)"
    set_usage_response "$ctl" "TOK_CACHE" 200 "$(usage_body 42 24)"

    run_cc "$home" "$ctl" "" --no-switch
    local count_after_first
    count_after_first="$(usage_call_count "$ctl")"

    run_cc "$home" "$ctl" "" --no-switch
    local count_after_second
    count_after_second="$(usage_call_count "$ctl")"

    run_cc "$home" "$ctl" "" --refresh --no-switch
    local count_after_refresh
    count_after_refresh="$(usage_call_count "$ctl")"

    if [[ "$count_after_first" -eq 1 ]] \
      && [[ "$count_after_second" -eq 1 ]] \
      && [[ "$count_after_refresh" -eq 2 ]]; then
      pass "case5 cache TTL suppresses re-fetch, --refresh forces a re-fetch"
    else
      fail "case5 usage-call counts: first=$count_after_first second=$count_after_second refresh=$count_after_refresh"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 6: --no-switch prints the table and never prompts.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_only" "REFRESH_CACHE2" "TOK_CACHE2" "$(future_ms)"
    set_usage_response "$ctl" "TOK_CACHE2" 200 "$(usage_body 5 5)"

    run_cc "$home" "$ctl" "" --no-switch

    if [[ "$EXIT_CODE" -eq 0 ]] && ! printf '%s' "$OUT" | grep -q "switch to which"; then
      pass "case6 --no-switch prints table without prompting"
    else
      fail "case6 (exit=$EXIT_CODE): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Bonus 7a/7b: the interactive prompt (no --no-switch) actually switches on
  # a valid label and safely no-ops on an invalid one.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_live_credentials "$home" "REFRESH_SWITCHA" "TOK_SWITCHA" "$(future_ms)"
    write_account_credentials "$home" "switch_a" "REFRESH_SWITCHA" "TOK_SWITCHA" "$(future_ms)"
    write_account_credentials "$home" "switch_b" "REFRESH_SWITCHB" "TOK_SWITCHB" "$(future_ms)"
    set_usage_response "$ctl" "TOK_SWITCHA" 200 "$(usage_body 10 10)"
    set_usage_response "$ctl" "TOK_SWITCHB" 200 "$(usage_body 10 10)"

    run_cc "$home" "$ctl" "switch_b"
    local live_refresh_after
    live_refresh_after="$(jq -r '.claudeAiOauth.refreshToken' "$home/.claude/.credentials.json" 2>/dev/null)"

    if [[ "$EXIT_CODE" -eq 0 ]] && [[ "$live_refresh_after" == "REFRESH_SWITCHB" ]]; then
      pass "bonus7a prompt with valid label switches accounts"
    else
      fail "bonus7a (exit=$EXIT_CODE live_refresh=$live_refresh_after): $OUT"
    fi

    run_cc "$home" "$ctl" "not_a_real_label"
    local live_refresh_unchanged
    live_refresh_unchanged="$(jq -r '.claudeAiOauth.refreshToken' "$home/.claude/.credentials.json" 2>/dev/null)"

    if printf '%s' "$OUT" | grep -qi "error" && [[ "$live_refresh_unchanged" == "REFRESH_SWITCHB" ]]; then
      pass "bonus7b prompt with invalid label errors and changes nothing"
    else
      fail "bonus7b (exit=$EXIT_CODE live_refresh=$live_refresh_unchanged): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 8 (security): none of the fake secret tokens ever appear in any
  # captured output across the whole suite.
  # =========================================================================
  {
    local combined leaked=0 secret
    combined="$(cat "$ALL_OUTPUT_LOG")"
    for secret in "${SECRET_TOKENS[@]}"; do
      if printf '%s' "$combined" | grep -q "$secret"; then
        leaked=1
        echo "  leaked secret: $secret"
      fi
    done
    if [[ "$leaked" -eq 0 ]]; then
      pass "case8 no secret token ever appears in captured output"
    else
      fail "case8 SECURITY LEAK: a secret token appeared in output"
    fi
  }

  # =========================================================================
  # Case 9 (security): none of the fake secret tokens ever appear as a
  # literal curl argv argument across the whole suite. This is the specific
  # property fetch_usage_raw's --config file and refresh_token's -d @file
  # exist to guarantee (argv is readable via /proc/<pid>/cmdline on a
  # shared host; the config/body FILE contents are not argv and are not
  # checked here -- only what curl was actually invoked with).
  # =========================================================================
  {
    local combined_argv leaked=0 secret
    combined_argv="$(cat "$ALL_ARGV_LOG")"
    for secret in "${SECRET_TOKENS[@]}"; do
      if printf '%s' "$combined_argv" | grep -q "$secret"; then
        leaked=1
        echo "  leaked secret in curl argv: $secret"
      fi
    done
    if [[ "$leaked" -eq 0 ]]; then
      pass "case9 no secret token ever appears in curl argv"
    else
      fail "case9 SECURITY LEAK: a secret token appeared in curl argv"
    fi
  }

  # =========================================================================
  # Case 10: a 200 body with five_hour.resets_at = null (5h usage 0%) still
  # renders the row -- weekly is valid and must show -- rather than being
  # discarded. RESET(wk) column present; the 5h reset cell shows the em dash.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_zero5h" "REFRESH_Z" "TOK_ZERO5H" "$(future_ms)"

    set_usage_response "$ctl" "TOK_ZERO5H" 200 "$(usage_body_5hnull 0 100)"

    run_cc "$home" "$ctl" "" --no-switch

    local zline
    zline="$(printf '%s' "$OUT" | grep 'acct_zero5h')"

    # A rendered meter always contains the track char '·'; a dashed-out row
    # never does -- so '·' proves the row rendered (ok state), not dashed.
    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$OUT" | grep -q 'RESET(wk)' \
      && printf '%s' "$zline" | grep -q '100%' \
      && printf '%s' "$zline" | grep -q '·' \
      && printf '%s' "$zline" | grep -q $'\xe2\x80\x94'; then
      pass "case10 null 5h reset still renders (weekly shown, RESET(wk) present, 5h reset dashed)"
    else
      fail "case10 (exit=$EXIT_CODE): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 11: "most headroom" accounts for BOTH limits. An account at 0% 5h but
  # 100% weekly has no real headroom and must NOT be flagged over an account
  # that is low on both.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_wkmax" "REFRESH_WM" "TOK_WM" "$(future_ms)"
    write_account_credentials "$home" "acct_free" "REFRESH_FR" "TOK_FR" "$(future_ms)"

    set_usage_response "$ctl" "TOK_WM" 200 "$(usage_body 0 100)"
    set_usage_response "$ctl" "TOK_FR" 200 "$(usage_body 5 10)"

    run_cc "$home" "$ctl" "" --no-switch

    local wmline frline
    wmline="$(printf '%s' "$OUT" | grep 'acct_wkmax')"
    frline="$(printf '%s' "$OUT" | grep 'acct_free')"

    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$frline" | grep -q 'most headroom' \
      && ! printf '%s' "$wmline" | grep -q 'most headroom'; then
      pass "case11 most-headroom accounts for weekly too (100%-weekly account not flagged)"
    else
      fail "case11 (exit=$EXIT_CODE): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 12: a 401 on a NON-expired token triggers a refresh + retry. The
  # access token looks valid (future expiry) so the time-based refresh never
  # fires, but the server rejects it (401). The tool should refresh once and
  # retry: the row renders and the snapshot's access token is updated.
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_stale" "REFRESH_STALE" "TOK_STALE" "$(future_ms)"

    set_usage_response "$ctl" "TOK_STALE" 401 '{"error":"unauthorized"}'
    set_token_response "$ctl" "REFRESH_STALE" 200 "$(refresh_success_body TOK_FRESH)"
    set_usage_response "$ctl" "TOK_FRESH" 200 "$(usage_body 30 40)"

    run_cc "$home" "$ctl" "" --no-switch

    local sline newtok
    sline="$(printf '%s' "$OUT" | grep 'acct_stale')"
    newtok="$(jq -r '.claudeAiOauth.accessToken' "$home/.claude/accounts/acct_stale/credentials.json" 2>/dev/null)"

    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$sline" | grep -q '30%' \
      && printf '%s' "$sline" | grep -q '40%' \
      && [[ "$newtok" == "TOK_FRESH" ]]; then
      pass "case12 401 on non-expired token refreshes + retries; row renders, snapshot token updated"
    else
      fail "case12 (exit=$EXIT_CODE newtok=$newtok): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  # =========================================================================
  # Case 12b: a 401 whose refresh ALSO fails -> re-login (not a silent dash).
  # =========================================================================
  {
    local home ctl
    home="$(new_home)"
    ctl="$(new_ctl)"

    write_claude_json "$home"
    write_account_credentials "$home" "acct_dead" "REFRESH_DEAD" "TOK_DEAD" "$(future_ms)"

    set_usage_response "$ctl" "TOK_DEAD" 401 '{"error":"unauthorized"}'
    set_token_response "$ctl" "REFRESH_DEAD" 400 '{"error":"invalid_grant"}'

    run_cc "$home" "$ctl" "" --no-switch

    local dline
    dline="$(printf '%s' "$OUT" | grep 'acct_dead')"

    if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$dline" | grep -q 're-login'; then
      pass "case12b 401 with a failed refresh shows re-login"
    else
      fail "case12b (exit=$EXIT_CODE): $OUT"
    fi

    rm -rf "$home" "$ctl"
  }

  rm -rf "$STUB_BIN" "$ALL_OUTPUT_LOG" "$ALL_ARGV_LOG"

  echo
  echo "----------------------------------------"
  echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
