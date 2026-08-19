#!/usr/bin/env bash
# Test harness for install.sh
# Self-contained bash; no external test framework. Sandboxes HOME per case;
# never touches the real ~/.claude. Runs install.sh straight out of this
# repo checkout, so it copies the repo's real statusline-usage.sh/ccswitch.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/install.sh"

FAIL_COUNT=0
PASS_COUNT=0

pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "FAIL: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

make_sandbox() {
  mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-install-test.XXXXXX"
}

# run_install <home_dir> <stdin_text> <args...> -> sets OUT, EXIT_CODE.
# Pins SHELL=/bin/bash so every case targets $HOME/.bashrc consistently,
# regardless of the shell actually running this test suite.
run_install() {
  local home_dir="$1" stdin_text="$2"
  shift 2
  OUT="$(HOME="$home_dir" SHELL=/bin/bash bash "$TARGET" "$@" <<<"$stdin_text" 2>&1)"
  EXIT_CODE=$?
}

main() {
  if [[ ! -f "$TARGET" ]]; then
    echo "FAIL: target script not found: $TARGET"
    exit 1
  fi

  # --- Case 1: main run, decline the ccw prompt -------------------------------
  local home1
  home1="$(make_sandbox)"
  run_install "$home1" "n"

  local cc_dir="$home1/.claude"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -x "$cc_dir/statusline-usage.sh" ]] \
    && [[ -x "$cc_dir/ccswitch" ]]; then
    pass "case1 scripts copied and executable in \$HOME/.claude"
  else
    fail "case1 scripts not copied/executable (exit=$EXIT_CODE): $OUT"
  fi

  local settings_file="$cc_dir/settings.json"
  local command_val interval_val
  command_val="$(jq -r '.statusLine.command // empty' "$settings_file" 2>/dev/null)"
  interval_val="$(jq -r '.statusLine.refreshInterval // empty' "$settings_file" 2>/dev/null)"
  if [[ "$command_val" == "~/.claude/statusline-usage.sh" ]] && [[ "$interval_val" == "5" ]]; then
    pass "case2 settings.json created with correct statusLine command + refreshInterval 5"
  else
    fail "case2 settings.json statusLine wrong (command=$command_val interval=$interval_val): $OUT"
  fi

  if grep -qF 'ccw()' "$home1/.bashrc" 2>/dev/null; then
    fail "case3 ccw function appended despite declining the prompt"
  else
    pass "case3 ccw function NOT appended when prompt declined"
  fi

  rm -rf "$home1"

  # --- Case 4: pre-existing settings.json is merged, not clobbered, and backed up
  local home2
  home2="$(make_sandbox)"
  mkdir -p "$home2/.claude"
  jq -n '{unrelatedTopLevelKey: "preserve-me"}' >"$home2/.claude/settings.json"

  run_install "$home2" "n"

  local settings2="$home2/.claude/settings.json"
  local backup2="$home2/.claude/settings.json.bak"
  local preserved new_command backup_preserved
  preserved="$(jq -r '.unrelatedTopLevelKey // empty' "$settings2" 2>/dev/null)"
  new_command="$(jq -r '.statusLine.command // empty' "$settings2" 2>/dev/null)"
  backup_preserved="$(jq -r '.unrelatedTopLevelKey // empty' "$backup2" 2>/dev/null)"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$preserved" == "preserve-me" ]] \
    && [[ "$new_command" == "~/.claude/statusline-usage.sh" ]] \
    && [[ -f "$backup2" ]] \
    && [[ "$backup_preserved" == "preserve-me" ]]; then
    pass "case4 pre-existing settings.json merged (statusLine added, unrelated key preserved) and backed up"
  else
    fail "case4 merge/backup failed (exit=$EXIT_CODE preserved=$preserved command=$new_command backup_exists=$([[ -f "$backup2" ]] && echo yes || echo no)): $OUT"
  fi

  rm -rf "$home2"

  # --- Case 5: --print-only writes nothing ------------------------------------
  local home3
  home3="$(make_sandbox)"
  run_install "$home3" "" --print-only

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -qF 'statusline-usage.sh' \
    && printf '%s' "$OUT" | grep -qF 'refreshInterval' \
    && printf '%s' "$OUT" | grep -qF 'ccw()' \
    && [[ ! -e "$home3/.claude" ]]; then
    pass "case5 --print-only prints settings snippet + ccw function and creates nothing"
  else
    fail "case5 --print-only side effects or missing output (exit=$EXIT_CODE, .claude exists=$([[ -e "$home3/.claude" ]] && echo yes || echo no)): $OUT"
  fi

  rm -rf "$home3"

  # --- Case 6: accepting the ccw prompt appends the function exactly once,
  # and re-running never duplicates it (grep guard) -----------------------
  local home4
  home4="$(make_sandbox)"
  run_install "$home4" "y"

  local rc4="$home4/.bashrc"
  local count1
  count1="$(grep -cF 'ccw()' "$rc4" 2>/dev/null || true)"
  count1="${count1:-0}"

  if [[ "$EXIT_CODE" -eq 0 ]] && [[ "$count1" -eq 1 ]]; then
    pass "case6a ccw function appended to rc after accepting the prompt"
  else
    fail "case6a ccw function not appended exactly once (exit=$EXIT_CODE count=$count1): $OUT"
  fi

  run_install "$home4" "y"
  local count2
  count2="$(grep -cF 'ccw()' "$rc4" 2>/dev/null || true)"
  count2="${count2:-0}"

  if [[ "$EXIT_CODE" -eq 0 ]] && [[ "$count2" -eq 1 ]]; then
    pass "case6b re-running install.sh does not duplicate the ccw function"
  else
    fail "case6b ccw function duplicated on re-run (count=$count2): $OUT"
  fi

  rm -rf "$home4"

  # --- Case 7 (bonus): missing jq is a hard error with an install hint -------
  local home5 fake_bin tool tool_path
  home5="$(make_sandbox)"
  fake_bin="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-install-test-bin.XXXXXX")"
  for tool in bash mkdir cp chmod mktemp mv grep cat dirname ln readlink; do
    tool_path="$(command -v "$tool" 2>/dev/null || true)"
    [[ -n "$tool_path" ]] && ln -sf "$tool_path" "$fake_bin/$tool"
  done

  OUT="$(HOME="$home5" SHELL=/bin/bash PATH="$fake_bin" bash "$TARGET" <<<"" 2>&1)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -ne 0 ]] \
    && printf '%s' "$OUT" | grep -qi 'jq' \
    && [[ ! -e "$home5/.claude" ]]; then
    pass "case7 missing jq is a hard error mentioning jq, nothing installed"
  else
    fail "case7 missing jq not handled as a hard error (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home5" "$fake_bin"

  # --- Case 8 (bonus): missing curl is a non-fatal warning, install proceeds -
  local home6 fake_bin2
  home6="$(make_sandbox)"
  fake_bin2="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-install-test-bin2.XXXXXX")"
  for tool in bash mkdir cp chmod mktemp mv grep cat dirname ln readlink jq; do
    tool_path="$(command -v "$tool" 2>/dev/null || true)"
    [[ -n "$tool_path" ]] && ln -sf "$tool_path" "$fake_bin2/$tool"
  done

  OUT="$(HOME="$home6" SHELL=/bin/bash PATH="$fake_bin2" bash "$TARGET" <<<"n" 2>&1)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -qi 'curl' \
    && [[ -x "$home6/.claude/statusline-usage.sh" ]]; then
    pass "case8 missing curl only warns (non-fatal), install still completes"
  else
    fail "case8 missing curl not handled as non-fatal (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home6" "$fake_bin2"

  # --- Case 9: ccswitch is symlinked onto PATH (~/.local/bin), idempotently ---
  local home7
  home7="$(make_sandbox)"
  run_install "$home7" "n"
  local link7="$home7/.local/bin/ccswitch"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -L "$link7" ]] \
    && [[ "$(readlink "$link7")" == "$home7/.claude/ccswitch" ]] \
    && [[ -x "$link7" ]]; then
    pass "case9 ccswitch symlinked into ~/.local/bin -> installed script"
  else
    fail "case9 ccswitch not symlinked onto PATH (exit=$EXIT_CODE, link=$([[ -L "$link7" ]] && echo yes || echo no)): $OUT"
  fi

  run_install "$home7" "n"
  if [[ -L "$link7" ]] && [[ "$(readlink "$link7")" == "$home7/.claude/ccswitch" ]]; then
    pass "case9b re-run keeps a single valid ccswitch symlink (idempotent)"
  else
    fail "case9b symlink broken on re-run"
  fi

  rm -rf "$home7"

  # --- Case 10: re-running the installer must not destroy the FIRST backup ---
  # The backup exists to answer "what did my settings.json look like before
  # cc-usage-bar?". Copying unconditionally meant run 2 overwrote it with the
  # post-install file, so the original statusLine was gone for good.
  local home10 settings10 backup10
  home10="$(make_sandbox)"
  mkdir -p "$home10/.claude"
  settings10="$home10/.claude/settings.json"
  backup10="$home10/.claude/settings.json.bak"
  jq -n '{statusLine: {type: "command", command: "/my/previous/bar.sh"}, theme: "dark"}' >"$settings10"

  run_install "$home10" "n"
  run_install "$home10" "n"

  local bak_command10 live_command10 bak_theme10
  bak_command10="$(jq -r '.statusLine.command // empty' "$backup10" 2>/dev/null)"
  live_command10="$(jq -r '.statusLine.command // empty' "$settings10" 2>/dev/null)"
  bak_theme10="$(jq -r '.theme // empty' "$backup10" 2>/dev/null)"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ "$bak_command10" == "/my/previous/bar.sh" ]] \
    && [[ "$bak_theme10" == "dark" ]] \
    && [[ "$live_command10" == "~/.claude/statusline-usage.sh" ]]; then
    pass "case10 re-running the installer preserves the pre-install settings.json backup"
  else
    fail "case10 backup clobbered on re-run (bak_command=$bak_command10 live_command=$live_command10): $OUT"
  fi

  rm -rf "$home10"

  # --- Case 11: uninstall reverses the install and spares the accounts ------
  local home11
  home11="$(make_sandbox)"
  mkdir -p "$home11/.claude"
  jq -n '{theme: "dark"}' >"$home11/.claude/settings.json"

  run_install "$home11" "y"

  # Enrolled account + a live credential file the uninstaller must not touch.
  mkdir -p "$home11/.claude/accounts/work"
  chmod 700 "$home11/.claude/accounts/work"
  jq -n '{claudeAiOauth: {accessToken: "KEEP_ME", refreshToken: "KEEP_ME_TOO"}}' \
    >"$home11/.claude/accounts/work/credentials.json"

  OUT="$(HOME="$home11" SHELL=/bin/bash bash "$REPO_DIR/uninstall.sh" <<<"" 2>&1)"
  EXIT_CODE=$?

  local statusline_key11 theme11 link11
  statusline_key11="$(jq -r 'has("statusLine")' "$home11/.claude/settings.json" 2>/dev/null)"
  theme11="$(jq -r '.theme // empty' "$home11/.claude/settings.json" 2>/dev/null)"
  link11="$home11/.local/bin/ccswitch"

  # NOTE: uninstall.sh deletes ~/.claude/ccswitch (the symlink target) before
  # unlinking $link11 itself, so a *dangling* symlink left behind by a bug
  # still reads `-e` false (it follows the link to a target that's now gone).
  # Checking `-L` too closes that hole: a surviving symlink, dangling or not,
  # must fail this assertion.
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ ! -e "$home11/.claude/statusline-usage.sh" ]] \
    && [[ ! -e "$home11/.claude/ccswitch" ]] \
    && [[ ! -e "$link11" ]] \
    && [[ ! -L "$link11" ]] \
    && [[ "$statusline_key11" == "false" ]] \
    && [[ "$theme11" == "dark" ]] \
    && [[ -f "$home11/.claude/accounts/work/credentials.json" ]] \
    && [[ "$(jq -r '.claudeAiOauth.accessToken' "$home11/.claude/accounts/work/credentials.json")" == "KEEP_ME" ]]; then
    pass "case11 uninstall removes scripts/symlink/statusLine, keeps other settings and all saved accounts"
  else
    fail "case11 uninstall wrong (exit=$EXIT_CODE statusLine=$statusline_key11 theme=$theme11): $OUT"
  fi

  # The accounts dir is the one thing that needs an explicit opt-in.
  if printf '%s' "$OUT" | grep -q 'accounts'; then
    pass "case11b uninstall tells the user their saved accounts were left in place"
  else
    fail "case11b uninstall silent about saved accounts: $OUT"
  fi

  OUT="$(HOME="$home11" SHELL=/bin/bash bash "$REPO_DIR/uninstall.sh" --purge-accounts <<<"y" 2>&1)"
  EXIT_CODE=$?
  if [[ "$EXIT_CODE" -eq 0 ]] && [[ ! -d "$home11/.claude/accounts" ]]; then
    pass "case11c --purge-accounts removes saved accounts after confirmation"
  else
    fail "case11c --purge-accounts did not remove accounts (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home11"

  # --- Case 12: --purge-accounts alone is NOT enough -- only an affirmative
  # y/yes answer may delete accounts/. This pins the two properties that
  # actually stand between the user and unrecoverable credential loss: a
  # future refactor of confirm() or the arg-parsing loop must not slip past
  # either "n" or an empty/EOF answer and delete anything.
  local home12 creds12 token12
  home12="$(make_sandbox)"
  mkdir -p "$home12/.claude"
  jq -n '{theme: "dark"}' >"$home12/.claude/settings.json"
  run_install "$home12" "y"

  mkdir -p "$home12/.claude/accounts/work"
  chmod 700 "$home12/.claude/accounts/work"
  jq -n '{claudeAiOauth: {accessToken: "DO_NOT_DELETE_ME", refreshToken: "DO_NOT_DELETE_ME_TOO"}}' \
    >"$home12/.claude/accounts/work/credentials.json"
  creds12="$home12/.claude/accounts/work/credentials.json"

  # 12a: --purge-accounts + explicit "n"
  OUT="$(HOME="$home12" SHELL=/bin/bash bash "$REPO_DIR/uninstall.sh" --purge-accounts <<<"n" 2>&1)"
  EXIT_CODE=$?
  token12="$(jq -r '.claudeAiOauth.accessToken // empty' "$creds12" 2>/dev/null)"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -f "$creds12" ]] \
    && [[ "$token12" == "DO_NOT_DELETE_ME" ]]; then
    pass "case12a --purge-accounts with 'n' keeps the accounts dir and credential value intact"
  else
    fail "case12a --purge-accounts with 'n' lost/altered credentials (exit=$EXIT_CODE token='$token12'): $OUT"
  fi

  # 12b: --purge-accounts + empty answer (immediate EOF on stdin, as happens
  # when the uninstaller is run non-interactively without a "y"/"n" piped in).
  OUT="$(HOME="$home12" SHELL=/bin/bash bash "$REPO_DIR/uninstall.sh" --purge-accounts </dev/null 2>&1)"
  EXIT_CODE=$?
  token12="$(jq -r '.claudeAiOauth.accessToken // empty' "$creds12" 2>/dev/null)"
  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -f "$creds12" ]] \
    && [[ "$token12" == "DO_NOT_DELETE_ME" ]]; then
    pass "case12b --purge-accounts with empty/EOF answer keeps the accounts dir and credential value intact"
  else
    fail "case12b --purge-accounts with empty/EOF answer lost/altered credentials (exit=$EXIT_CODE token='$token12'): $OUT"
  fi

  rm -rf "$home12"

  # --- Case 13: an unknown flag is rejected before anything is touched ------
  local home13
  home13="$(make_sandbox)"
  mkdir -p "$home13/.claude"
  jq -n '{theme: "dark"}' >"$home13/.claude/settings.json"
  run_install "$home13" "y"

  mkdir -p "$home13/.claude/accounts/work"
  chmod 700 "$home13/.claude/accounts/work"
  jq -n '{claudeAiOauth: {accessToken: "DO_NOT_DELETE_ME"}}' \
    >"$home13/.claude/accounts/work/credentials.json"

  OUT="$(HOME="$home13" SHELL=/bin/bash bash "$REPO_DIR/uninstall.sh" --bogus <<<"" 2>&1)"
  EXIT_CODE=$?
  if [[ "$EXIT_CODE" -ne 0 ]] \
    && [[ -e "$home13/.claude/statusline-usage.sh" ]] \
    && [[ -e "$home13/.claude/ccswitch" ]] \
    && [[ -d "$home13/.claude/accounts" ]]; then
    pass "case13 unknown flag rejected (nonzero exit), nothing removed"
  else
    fail "case13 unknown flag not safely rejected (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home13"

  echo
  echo "----------------------------------------"
  echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
