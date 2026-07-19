#!/usr/bin/env bash
# Test harness for ccswitch
# Self-contained bash; no external test framework. Sandboxes HOME, no network,
# never touches the real ~/.claude.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/ccswitch"

FAIL_COUNT=0
PASS_COUNT=0

# Accumulates every byte of stdout+stderr the target ever printed during this
# run, so the security case can grep the whole suite for leaked secrets.
ALL_OUTPUT_LOG="$(mktemp "${TMPDIR:-/tmp}/ccswitch-test-alloutput.XXXXXX")"

SECRET_A="SECRET_TOKEN_A"
SECRET_B="SECRET_TOKEN_B"

pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

make_sandbox() {
  mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-ccswitch-test.XXXXXX"
}

# write_claude_json <home_dir> <email> <org> <uuid>
# Includes an unrelated top-level key so tests can confirm `switch` preserves
# the rest of .claude.json rather than clobbering it.
write_claude_json() {
  local home_dir="$1" email="$2" org="$3" uuid="$4"
  jq -n --arg email "$email" --arg org "$org" --arg uuid "$uuid" \
    '{unrelatedTopLevelKey: "preserve-me", oauthAccount: {emailAddress: $email, organizationName: $org, accountUuid: $uuid}}' \
    >"$home_dir/.claude.json"
}

# write_credentials <home_dir> <refresh_token> <access_token>
write_credentials() {
  local home_dir="$1" refresh="$2" access="$3"
  mkdir -p "$home_dir/.claude"
  jq -n --arg refresh "$refresh" --arg access "$access" \
    '{claudeAiOauth: {accessToken: $access, refreshToken: $refresh, expiresAt: 1, refreshTokenExpiresAt: 1, scopes: ["user:inference"], subscriptionType: "pro", rateLimitTier: "default_claude_ai"}}' \
    >"$home_dir/.claude/.credentials.json"
  chmod 600 "$home_dir/.claude/.credentials.json"
}

# run_cc <home_dir> <stdin_text_or_empty> <args...>
# Sets OUT and EXIT_CODE; appends OUT to the running security log.
run_cc() {
  local home_dir="$1" stdin_text="$2"
  shift 2
  OUT="$(HOME="$home_dir" bash "$TARGET" "$@" <<<"$stdin_text" 2>&1)"
  EXIT_CODE=$?
  printf '%s\n' "$OUT" >>"$ALL_OUTPUT_LOG"
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null
}

main() {
  if [[ ! -x "$TARGET" ]]; then
    echo "FAIL: target script not found or not executable: $TARGET"
    exit 1
  fi

  local home_dir
  home_dir="$(make_sandbox)"

  write_claude_json "$home_dir" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$home_dir" "REFRESH_A" "$SECRET_A"

  # --- Bonus: no accounts saved yet -> friendly message ---------------------
  run_cc "$home_dir" "" list
  if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$OUT" | grep -q "no saved accounts"; then
    pass "case0 no saved accounts prints friendly message"
  else
    fail "case0 no saved accounts message (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 1: save work ------------------------------------------------------
  run_cc "$home_dir" "" save work

  local accounts_dir="$home_dir/.claude/accounts"
  local work_dir="$accounts_dir/work"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -f "$work_dir/credentials.json" ]] \
    && [[ -f "$work_dir/oauthAccount.json" ]] \
    && [[ "$(file_mode "$accounts_dir")" == "700" ]] \
    && [[ "$(file_mode "$work_dir")" == "700" ]] \
    && [[ "$(file_mode "$work_dir/credentials.json")" == "600" ]] \
    && [[ "$(file_mode "$work_dir/oauthAccount.json")" == "600" ]]; then
    pass "case1 save work creates files with correct modes"
  else
    fail "case1 save work (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 2: list shows work as active -------------------------------------
  run_cc "$home_dir" "" list
  if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$OUT" | grep -qx '\* work'; then
    pass "case2 list marks work as active"
  else
    fail "case2 list active marker (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 3: mutate to identity B, save personal, list shows both ---------
  write_claude_json "$home_dir" "b@y.com" "OrgB" "uuid-b"
  write_credentials "$home_dir" "REFRESH_B" "$SECRET_B"

  run_cc "$home_dir" "" save personal
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail "case3 save personal failed (exit=$EXIT_CODE): $OUT"
  else
    run_cc "$home_dir" "" list
    if [[ "$EXIT_CODE" -eq 0 ]] \
      && printf '%s' "$OUT" | grep -qx '\* personal' \
      && printf '%s' "$OUT" | grep -qx '  work'; then
      pass "case3 list shows both accounts, star on personal"
    else
      fail "case3 list after second save (exit=$EXIT_CODE): $OUT"
    fi
  fi

  # --- Case 3b: active-account identity is anchored on accountUuid, NOT on
  # refreshToken (which rotates on every refresh). Rotate the live
  # refreshToken in place -- .claude.json's oauthAccount (still uuid-b) is
  # untouched -- and confirm `list` still marks 'personal' active. Before
  # the accountUuid-anchoring fix, this would have flipped to no active
  # account at all (refreshToken equality would no longer match).
  write_credentials "$home_dir" "REFRESH_B_ROTATED" "$SECRET_B"

  run_cc "$home_dir" "" list
  if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$OUT" | grep -qx '\* personal'; then
    pass "case3b list active marker survives a rotated live refreshToken (anchored on accountUuid)"
  else
    fail "case3b active marker not accountUuid-anchored (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 4: switch to work -------------------------------------------------
  run_cc "$home_dir" "" work

  local live_refresh live_email backup_file live_credentials_file
  live_credentials_file="$home_dir/.claude/.credentials.json"
  live_refresh="$(jq -r '.claudeAiOauth.refreshToken' "$live_credentials_file" 2>/dev/null)"
  live_email="$(jq -r '.oauthAccount.emailAddress' "$home_dir/.claude.json" 2>/dev/null)"
  backup_file="$home_dir/.claude/.credentials.json.bak"
  local preserved_key
  preserved_key="$(jq -r '.unrelatedTopLevelKey' "$home_dir/.claude.json" 2>/dev/null)"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$live_refresh" == "REFRESH_A" ]] \
    && [[ -f "$backup_file" ]] \
    && [[ "$live_email" == "a@x.com" ]] \
    && [[ "$preserved_key" == "preserve-me" ]] \
    && [[ "$(file_mode "$backup_file")" == "600" ]] \
    && [[ "$(file_mode "$live_credentials_file")" == "600" ]]; then
    pass "case4 switch work restores credentials, oauthAccount, writes .bak, preserves rest of .claude.json, both files mode 600"
  else
    fail "case4 switch work (exit=$EXIT_CODE live_refresh=$live_refresh live_email=$live_email preserved=$preserved_key bak_exists=$([[ -f "$backup_file" ]] && echo yes || echo no) bak_mode=$(file_mode "$backup_file") live_mode=$(file_mode "$live_credentials_file")): $OUT"
  fi

  # --- Case 5: switch --relaunch invokes CCSWITCH_CLAUDE_CMD -----------------
  local marker relaunch_stub
  marker="$home_dir/relaunch-marker"
  relaunch_stub="$home_dir/fake-claude.sh"
  cat >"$relaunch_stub" <<EOF
#!/usr/bin/env bash
touch "$marker"
EOF
  chmod +x "$relaunch_stub"

  OUT="$(HOME="$home_dir" CCSWITCH_CLAUDE_CMD="$relaunch_stub" bash "$TARGET" work --relaunch <<<"" 2>&1)"
  EXIT_CODE=$?
  printf '%s\n' "$OUT" >>"$ALL_OUTPUT_LOG"

  if [[ -f "$marker" ]]; then
    pass "case5 --relaunch invokes CCSWITCH_CLAUDE_CMD stub"
  else
    fail "case5 --relaunch did not invoke stub (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 6: delete personal, first decline then confirm -------------------
  run_cc "$home_dir" "n" delete personal
  if [[ -d "$accounts_dir/personal" ]]; then
    pass "case6a delete personal declined (n) leaves dir intact"
  else
    fail "case6a delete decline removed dir unexpectedly (exit=$EXIT_CODE): $OUT"
  fi

  run_cc "$home_dir" "y" delete personal
  if [[ "$EXIT_CODE" -eq 0 ]] && [[ ! -d "$accounts_dir/personal" ]]; then
    pass "case6b delete personal confirmed (y) removes dir"
  else
    fail "case6b delete confirm did not remove dir (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 7: error cases -----------------------------------------------------
  run_cc "$home_dir" "" nope
  if [[ "$EXIT_CODE" -ne 0 ]] && [[ -n "$OUT" ]]; then
    pass "case7a switching to missing label errors non-zero with message"
  else
    fail "case7a missing label switch (exit=$EXIT_CODE): $OUT"
  fi

  run_cc "$home_dir" "" save save
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    pass "case7b reserved word 'save' rejected as label"
  else
    fail "case7b reserved word not rejected (exit=$EXIT_CODE): $OUT"
  fi

  run_cc "$home_dir" "" save list
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    pass "case7c reserved word 'list' rejected as label"
  else
    fail "case7c reserved word 'list' not rejected (exit=$EXIT_CODE): $OUT"
  fi

  run_cc "$home_dir" "" save -foo
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    pass "case7d dash-prefixed label rejected"
  else
    fail "case7d dash-prefixed label not rejected (exit=$EXIT_CODE): $OUT"
  fi

  run_cc "$home_dir" "" save usage
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    pass "case7e reserved word 'usage' rejected as save label"
  else
    fail "case7e reserved word 'usage' not rejected (exit=$EXIT_CODE): $OUT"
  fi

  run_cc "$home_dir" "" save delete
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    pass "case7f reserved word 'delete' rejected as save label"
  else
    fail "case7f reserved word 'delete' not rejected (exit=$EXIT_CODE): $OUT"
  fi

  run_cc "$home_dir" "y" delete list
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    pass "case7g reserved word 'list' rejected as delete label"
  else
    fail "case7g reserved word 'list' not rejected by delete (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 8: security -- no token ever appears in any captured output -----
  local combined
  combined="$(cat "$ALL_OUTPUT_LOG")"
  if ! printf '%s' "$combined" | grep -q "$SECRET_A" && ! printf '%s' "$combined" | grep -q "$SECRET_B"; then
    pass "case8 no secret token ever appears in captured output"
  else
    fail "case8 SECURITY LEAK: a secret token appeared in output"
  fi

  # --- Case 9: bare `ccswitch` with zero args exercises the no-args branch --
  # (distinct from explicit `list`: this call passes NO subcommand at all)
  run_cc "$home_dir" ""
  if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$OUT" | grep -qx '\* work'; then
    pass "case9 bare ccswitch (zero args) lists accounts same as 'list'"
  else
    fail "case9 bare ccswitch zero-args (exit=$EXIT_CODE): $OUT"
  fi

  # --- Case 10: path traversal in a label must be rejected everywhere -------
  local traversal_label="../evil"
  local claude_dir="$home_dir/.claude"

  run_cc "$home_dir" "" save "$traversal_label"
  local save_traversal_exit="$EXIT_CODE"

  run_cc "$home_dir" "y" delete "$traversal_label"
  local delete_traversal_exit="$EXIT_CODE"

  if [[ "$save_traversal_exit" -ne 0 ]] \
    && [[ "$delete_traversal_exit" -ne 0 ]] \
    && [[ ! -e "$claude_dir/evil" ]] \
    && [[ ! -e "$home_dir/evil" ]] \
    && [[ ! -e "$accounts_dir/evil" ]] \
    && [[ ! -e "$accounts_dir/../evil" ]]; then
    pass "case10 path traversal label '../evil' rejected by save and delete, nothing created/removed outside accounts/"
  else
    fail "case10 path traversal not fully blocked (save_exit=$save_traversal_exit delete_exit=$delete_traversal_exit)"
  fi

  rm -rf "$home_dir" "$ALL_OUTPUT_LOG"

  echo
  echo "----------------------------------------"
  echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
