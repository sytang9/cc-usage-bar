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

  # case11: help / -h / --help print the guide; 'help' is reserved as a label
  run_cc "$home_dir" "" help
  local help_out="$OUT" help_exit="$EXIT_CODE"
  run_cc "$home_dir" "" -h
  local h_out="$OUT"
  run_cc "$home_dir" "" --help
  local hh_out="$OUT"
  run_cc "$home_dir" "" save help
  local save_help_exit="$EXIT_CODE"
  if [[ "$help_exit" -eq 0 ]] \
    && grep -q "COMMANDS" <<<"$help_out" \
    && grep -q "ccswitch save <label>" <<<"$help_out" \
    && grep -q "GETTING STARTED" <<<"$help_out" \
    && grep -q "COMMANDS" <<<"$h_out" \
    && grep -q "COMMANDS" <<<"$hh_out" \
    && [[ "$save_help_exit" -ne 0 ]]; then
    pass "case11 help/-h/--help print guide; 'help' rejected as a label"
  else
    fail "case11 help command (help_exit=$help_exit save_help_exit=$save_help_exit)"
  fi

  # --- Case 12: save-on-leave. Claude Code rotates the ACTIVE account's live
  # refresh token behind ccswitch's back; when you switch away, that account's
  # snapshot must capture the rotated live token, or it shows a false
  # "re-login" the moment it is no longer active. Set A active + saved, save a
  # second account B, rotate A's LIVE refresh token in place, switch to B, and
  # confirm A's snapshot now holds the rotated token (mode 600). ------------
  local m_home
  m_home="$(make_sandbox)"
  write_claude_json "$m_home" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$m_home" "REFRESH_A" "$SECRET_A"
  run_cc "$m_home" "" save active-a
  write_claude_json "$m_home" "b@y.com" "OrgB" "uuid-b"
  write_credentials "$m_home" "REFRESH_B" "$SECRET_B"
  run_cc "$m_home" "" save other-b
  # A is active again; simulate Claude Code rotating A's live refresh token.
  write_claude_json "$m_home" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$m_home" "REFRESH_A_ROTATED" "$SECRET_A"
  run_cc "$m_home" "" other-b   # switch AWAY from A -> mirror A's live creds into its snapshot
  local a_snap_refresh a_snap_file
  a_snap_file="$m_home/.claude/accounts/active-a/credentials.json"
  a_snap_refresh="$(jq -r '.claudeAiOauth.refreshToken' "$a_snap_file" 2>/dev/null)"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$a_snap_refresh" == "REFRESH_A_ROTATED" ]] \
    && [[ "$(file_mode "$a_snap_file")" == "600" ]]; then
    pass "case12 switch-away mirrors the departing active account's rotated live token into its snapshot (mode 600)"
  else
    fail "case12 save-on-leave mirror (exit=$EXIT_CODE a_snap_refresh=$a_snap_refresh): $OUT"
  fi
  rm -rf "$m_home"

  # --- Case 13: MCP OAuth grants survive an account switch. .credentials.json
  # holds two unrelated things: claudeAiOauth (which Claude account you are) and
  # mcpOAuth/<server> (grants for MCP servers like Atlassian). The MCP grant
  # belongs to the human and the machine, not to the Claude account, so a switch
  # must swap the former and keep the latter. Overwriting wholesale silently
  # logs you out of every MCP server on every switch. Save A and B, add a live
  # MCP grant, switch to B, and confirm the grant is still there. -----------
  local n_home
  n_home="$(make_sandbox)"
  write_claude_json "$n_home" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$n_home" "REFRESH_A" "$SECRET_A"
  run_cc "$n_home" "" save acct-a
  write_claude_json "$n_home" "b@y.com" "OrgB" "uuid-b"
  write_credentials "$n_home" "REFRESH_B" "$SECRET_B"
  run_cc "$n_home" "" save acct-b
  # Authenticate an MCP server while B is active; the grant lands in LIVE creds
  # and in no snapshot, exactly as a real `/mcp` authentication does.
  local n_live="$n_home/.claude/.credentials.json"
  local n_tmp
  n_tmp="$(mktemp)"
  jq '.mcpOAuth = {"atlassian|deadbeef": {"accessToken": "MCP_GRANT_KEPT"}}' \
    "$n_live" >"$n_tmp" && mv "$n_tmp" "$n_live" && chmod 600 "$n_live"
  run_cc "$n_home" "" acct-a   # switch accounts
  local kept_grant switched_refresh
  kept_grant="$(jq -r '.mcpOAuth["atlassian|deadbeef"].accessToken // "GONE"' "$n_live" 2>/dev/null)"
  switched_refresh="$(jq -r '.claudeAiOauth.refreshToken' "$n_live" 2>/dev/null)"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$kept_grant" == "MCP_GRANT_KEPT" ]] \
    && [[ "$switched_refresh" == "REFRESH_A" ]] \
    && [[ "$(file_mode "$n_live")" == "600" ]]; then
    pass "case13 MCP OAuth grants survive an account switch while claudeAiOauth swaps (mode 600)"
  else
    fail "case13 mcpOAuth preservation (exit=$EXIT_CODE grant=$kept_grant refresh=$switched_refresh): $OUT"
  fi
  rm -rf "$n_home"

  # --- Case 14: a corrupt snapshot must NOT destroy ~/.claude.json -----------
  # jq failing mid-switch used to leave an EMPTY .claude.json behind (the write
  # was `jq ... >"$tmp"; mv "$tmp" "$dest"` with no status check), while
  # ccswitch still printed "Switched to ..." and exited 0. .claude.json holds
  # project history, mcpServers and onboarding state, so that is total config
  # loss on a switch to one bad account.
  local home14 corrupt_dir before14
  home14="$(make_sandbox)"
  write_claude_json "$home14" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$home14" "REFRESH_A" "$SECRET_A"
  run_cc "$home14" "" save good
  corrupt_dir="$home14/.claude/accounts/broken"
  mkdir -p "$corrupt_dir"
  chmod 700 "$corrupt_dir"
  jq -n '{claudeAiOauth: {accessToken: "X", refreshToken: "Y", expiresAt: 1}}' >"$corrupt_dir/credentials.json"
  # Truncated file -- exactly what an interrupted or disk-full `save` leaves.
  printf '{"accountUuid": "uuid-bro' >"$corrupt_dir/oauthAccount.json"
  before14="$(cat "$home14/.claude.json")"

  run_cc "$home14" "" broken

  local after14 still_valid14 preserved14
  after14="$(cat "$home14/.claude.json")"
  still_valid14="$(jq -e . "$home14/.claude.json" >/dev/null 2>&1 && echo yes || echo no)"
  preserved14="$(jq -r '.unrelatedTopLevelKey // empty' "$home14/.claude.json" 2>/dev/null)"

  if [[ "$EXIT_CODE" -ne 0 ]] \
    && [[ "$still_valid14" == "yes" ]] \
    && [[ "$after14" == "$before14" ]] \
    && [[ "$preserved14" == "preserve-me" ]] \
    && ! printf '%s' "$OUT" | grep -q "Switched to"; then
    pass "case14 switch to a corrupt snapshot fails loudly and leaves .claude.json byte-identical"
  else
    fail "case14 corrupt snapshot damaged .claude.json (exit=$EXIT_CODE valid=$still_valid14 preserved=$preserved14): $OUT"
  fi

  rm -rf "$home14"

  # --- Case 15: a healthy switch backs up .claude.json ----------------------
  # .credentials.json has always been backed up before being overwritten;
  # .claude.json was not, so there was nothing to recover from.
  local home15
  home15="$(make_sandbox)"
  write_claude_json "$home15" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$home15" "REFRESH_A" "$SECRET_A"
  run_cc "$home15" "" save first
  write_claude_json "$home15" "b@y.com" "OrgB" "uuid-b"
  write_credentials "$home15" "REFRESH_B" "$SECRET_B"
  run_cc "$home15" "" save second
  run_cc "$home15" "" first

  local bak15 bak_email15 live_email15
  bak15="$home15/.claude.json.bak"
  bak_email15="$(jq -r '.oauthAccount.emailAddress // empty' "$bak15" 2>/dev/null)"
  # Not enough to check the .bak holds the PRE-switch identity -- confirm the
  # switch actually landed the TARGET identity in the live .claude.json too,
  # or a broken write that left .bak correct but .claude.json untouched would
  # pass this case anyway.
  live_email15="$(jq -r '.oauthAccount.emailAddress // empty' "$home15/.claude.json" 2>/dev/null)"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -f "$bak15" ]] \
    && [[ "$bak_email15" == "b@y.com" ]] \
    && [[ "$(file_mode "$bak15")" == "600" ]] \
    && [[ "$live_email15" == "a@x.com" ]]; then
    pass "case15 switch backs up .claude.json (pre-switch identity, mode 600) and updates it to the target identity"
  else
    fail "case15 .claude.json backup/update wrong (exit=$EXIT_CODE bak_email=$bak_email15 live_email=$live_email15 mode=$(file_mode "$bak15")): $OUT"
  fi

  rm -rf "$home15"

  # --- Case 16: a 0-byte oauthAccount.json must NOT pass the switch
  # pre-flight. `jq empty` exits 0 on a zero-byte file ("zero JSON documents"
  # is valid JSON to jq), so a bare `jq empty` check lets a 0-byte snapshot
  # through. This is not hypothetical: the OLD unchecked `cmd_save` wrote
  # `jq '.oauthAccount // {}' >"$tmp"` with no status check, so a failed,
  # killed, or disk-full save produced exactly a 0-byte oauthAccount.json --
  # corruption that is already sitting in real users' ~/.claude/accounts/*.
  # A 0-byte oauthAccount.json passing the pre-flight means
  # `jq --slurpfile oauth <empty-file> '.oauthAccount = $oauth[0]'` happily
  # writes `"oauthAccount": null` into .claude.json while ccswitch prints
  # "Switched to ..." and exits 0 -- silent identity loss.
  local home16
  home16="$(make_sandbox)"
  write_claude_json "$home16" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$home16" "REFRESH_A" "$SECRET_A"
  run_cc "$home16" "" save good16
  : >"$home16/.claude/accounts/good16/oauthAccount.json"   # 0-byte, planted after a healthy save

  local before16
  before16="$(cat "$home16/.claude.json")"

  run_cc "$home16" "" good16

  local after16 after_oauth16
  after16="$(cat "$home16/.claude.json")"
  after_oauth16="$(jq -r '.oauthAccount // "MISSING"' "$home16/.claude.json" 2>/dev/null)"

  if [[ "$EXIT_CODE" -ne 0 ]] \
    && [[ "$after16" == "$before16" ]] \
    && [[ "$after_oauth16" != "null" ]] \
    && [[ "$after_oauth16" != "MISSING" ]] \
    && ! printf '%s' "$OUT" | grep -q "Switched to"; then
    pass "case16 a 0-byte oauthAccount.json fails the switch pre-flight and leaves .claude.json's oauthAccount intact (not null)"
  else
    fail "case16 0-byte oauthAccount.json not rejected (exit=$EXIT_CODE oauth=$after_oauth16): $OUT"
  fi

  rm -rf "$home16"

  # --- Case 17: dotfiles beside the accounts are not accounts ---------------
  # The emptiness check used `ls -A`, which counts the dot-files ccswitch keeps
  # in the accounts dir (.no-refresh, .refresh-backoff), while the loop globbed
  # */ with no nullglob and no -d guard -- so an unmatched glob reached
  # basename and printed a phantom account literally named '*'.
  local home17
  home17="$(make_sandbox)"
  write_claude_json "$home17" "a@x.com" "OrgA" "uuid-a"
  write_credentials "$home17" "REFRESH_A" "$SECRET_A"

  run_cc "$home17" "" refresh-pause
  run_cc "$home17" "" list

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -q "no saved accounts" \
    && ! printf '%s' "$OUT" | grep -q '\*'; then
    pass "case17 list ignores dot-files in the accounts dir (no phantom '*' account)"
  else
    fail "case17 phantom account from dot-file (exit=$EXIT_CODE): $OUT"
  fi

  # A stray regular file must not become an account either (.DS_Store on macOS).
  : >"$home17/.claude/accounts/.DS_Store"
  run_cc "$home17" "" save real
  run_cc "$home17" "" list

  local label_lines17
  label_lines17="$(printf '%s\n' "$OUT" | grep -c 'real$')"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$label_lines17" -eq 1 ]] \
    && ! printf '%s' "$OUT" | grep -q 'DS_Store' \
    && [[ "$(printf '%s\n' "$OUT" | grep -c .)" -eq 1 ]]; then
    pass "case17b list shows exactly the one real account beside a stray file"
  else
    fail "case17b stray file leaked into list (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home17"

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
