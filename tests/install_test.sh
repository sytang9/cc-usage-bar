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

  echo
  echo "----------------------------------------"
  echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
