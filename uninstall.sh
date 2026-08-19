#!/usr/bin/env bash
# uninstall.sh -- reverse install.sh: remove the two installed scripts, the
# ~/.local/bin symlink, and the statusLine entry it added to settings.json.
#
# What this deliberately does NOT do: touch $HOME/.claude/accounts/. That
# directory holds live OAuth credentials for every account you enrolled, and
# they are not recoverable from anywhere else -- losing them means logging into
# each account again. Pass --purge-accounts (and confirm) if you really want
# them gone.
#
# Safe to re-run: every step is a no-op when the thing is already absent.
set -uo pipefail

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
BIN_DIR="$HOME/.local/bin"
ACCOUNTS_DIR="$CLAUDE_DIR/accounts"

OUR_STATUSLINE_COMMAND="~/.claude/statusline-usage.sh"
CCW_FUNCTION='ccw() { ~/.claude/ccswitch "$@" --relaunch; }'

PURGE_ACCOUNTS=0
PRINT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --purge-accounts) PURGE_ACCOUNTS=1 ;;
    --print-only) PRINT_ONLY=1 ;;
    *)
      echo "Error: unknown option '$arg'." >&2
      echo "Usage: uninstall.sh [--purge-accounts] [--print-only]" >&2
      exit 1
      ;;
  esac
done

# check_jq: install.sh stays standalone on purpose, so this small guard is
# duplicated here rather than shared. Without it, a missing jq makes
# remove_statusline silently give up (see its own jq -e check below) *after*
# remove_scripts has already deleted the scripts -- leaving a stale
# statusLine entry pointing at nothing, while the run still reports success.
# Fail loudly before touching anything instead.
check_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not found on PATH." >&2
    echo "Install it first, e.g.: 'sudo apt install jq' (Debian/Ubuntu), 'brew install jq' (macOS)." >&2
    exit 1
  fi
}

confirm() {
  local prompt="$1" answer
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

remove_scripts() {
  local f
  for f in "$CLAUDE_DIR/statusline-usage.sh" "$CLAUDE_DIR/ccswitch"; do
    if [[ -e "$f" ]]; then
      if rm -f "$f"; then
        echo "Removed: $f"
      else
        echo "Error: failed to remove $f" >&2
      fi
    else
      echo "Already absent: $f"
    fi
  done
}

# remove_symlink: only unlink $BIN_DIR/ccswitch when it is OUR symlink. A user
# who replaced it with their own script or a link elsewhere keeps it.
remove_symlink() {
  local link="$BIN_DIR/ccswitch"
  if [[ ! -L "$link" ]]; then
    [[ -e "$link" ]] && echo "Left alone (not a symlink): $link"
    return 0
  fi
  local target
  target="$(readlink "$link")"
  if [[ "$target" == "$CLAUDE_DIR/ccswitch" ]]; then
    if rm -f "$link"; then
      echo "Removed symlink: $link"
    else
      echo "Error: failed to remove symlink $link" >&2
    fi
  else
    echo "Left alone (points elsewhere: $target): $link"
  fi
}

# remove_statusline: delete the statusLine key ONLY when it is still ours, so a
# statusLine the user has since pointed at their own script survives. Every
# other key is preserved.
remove_statusline() {
  [[ -f "$SETTINGS_FILE" ]] || { echo "No $SETTINGS_FILE to clean."; return 0; }

  if ! jq -e . "$SETTINGS_FILE" >/dev/null 2>&1; then
    echo "Warning: $SETTINGS_FILE is not valid JSON; leaving it untouched." >&2
    return 0
  fi

  local current
  current="$(jq -r '.statusLine.command // empty' "$SETTINGS_FILE" 2>/dev/null)"
  if [[ -z "$current" ]]; then
    echo "No statusLine entry to remove."
    return 0
  fi
  if [[ "$current" != "$OUR_STATUSLINE_COMMAND" ]]; then
    echo "statusLine does not point at cc-usage-bar (command='$current') -- leaving it."
    return 0
  fi

  local tmp
  tmp="$(mktemp "$CLAUDE_DIR/.cc-usage-bar-uninstall.XXXXXX")"
  if jq 'del(.statusLine)' "$SETTINGS_FILE" >"$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
    mv "$tmp" "$SETTINGS_FILE"
    echo "Removed the statusLine entry from $SETTINGS_FILE (other keys untouched)"
  else
    rm -f "$tmp"
    echo "Error: failed to rewrite $SETTINGS_FILE; it is unchanged." >&2
    exit 1
  fi
}

report_ccw_function() {
  local rc_file
  case "${SHELL:-}" in
    */zsh) rc_file="$HOME/.zshrc" ;;
    *) rc_file="$HOME/.bashrc" ;;
  esac
  if [[ -f "$rc_file" ]] && grep -qF "$CCW_FUNCTION" "$rc_file" 2>/dev/null; then
    echo
    echo "Note: the 'ccw' shell function is still in $rc_file. Editing your rc file"
    echo "for you is not something an uninstaller should do -- remove these two lines:"
    echo "  # cc-usage-bar: ccswitch switch-and-relaunch shorthand"
    echo "  $CCW_FUNCTION"
  fi
}

handle_accounts() {
  [[ -d "$ACCOUNTS_DIR" ]] || return 0

  if [[ "$PURGE_ACCOUNTS" != "1" ]]; then
    echo
    echo "Left in place: $ACCOUNTS_DIR (your saved accounts)"
    echo "These are live OAuth credentials and are not recoverable from anywhere else."
    echo "To delete them too: ./uninstall.sh --purge-accounts"
    return 0
  fi

  echo
  if confirm "Permanently delete every saved account under $ACCOUNTS_DIR?"; then
    rm -rf "$ACCOUNTS_DIR"
    echo "Deleted $ACCOUNTS_DIR."
  else
    echo "Kept $ACCOUNTS_DIR."
  fi
}

main() {
  if [[ "$PRINT_ONLY" == "1" ]]; then
    echo "Would remove:"
    echo "  $CLAUDE_DIR/statusline-usage.sh"
    echo "  $CLAUDE_DIR/ccswitch"
    echo "  $BIN_DIR/ccswitch (only if it symlinks to the above)"
    echo "  the .statusLine key in $SETTINGS_FILE (only if it points at cc-usage-bar)"
    if [[ "$PURGE_ACCOUNTS" == "1" ]]; then
      echo "Would DELETE (after interactive confirmation): $ACCOUNTS_DIR"
    else
      echo "Would KEEP: $ACCOUNTS_DIR"
    fi
    echo "Would KEEP: the ccw function in your shell rc."
    exit 0
  fi

  check_jq

  remove_scripts
  remove_symlink
  remove_statusline
  handle_accounts
  report_ccw_function

  echo
  if [[ -e "$SETTINGS_FILE.bak" ]]; then
    echo "Note: $SETTINGS_FILE.bak (your pre-install settings.json) was kept -- remove it by hand if you don't need it."
  fi
  echo "Done. Restart Claude Code to drop the status line."
}

main "$@"
