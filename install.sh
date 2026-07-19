#!/usr/bin/env bash
# install.sh — installs cc-usage-bar (statusline-usage.sh + ccswitch) into
# $HOME/.claude, wires up the statusLine entry in $HOME/.claude/settings.json,
# and optionally adds a `ccw` shell shortcut.
#
# Safe to re-run: every step is idempotent. settings.json is backed up before
# it is ever touched; the ccw shell function is only appended once (grep
# guard). Nothing here requires network access.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

# Exact statusLine value the task requires — kept as one literal so the
# printed snippet and the value written into settings.json can never drift
# apart.
STATUSLINE_JSON='{"type":"command","command":"~/.claude/statusline-usage.sh","refreshInterval":5}'
SETTINGS_SNIPPET='{"statusLine": '"$STATUSLINE_JSON"'}'

CCW_FUNCTION='ccw() { ~/.claude/ccswitch "$@" --relaunch; }'

print_snippets() {
  echo "settings.json statusLine snippet (merged into \$HOME/.claude/settings.json):"
  if command -v jq >/dev/null 2>&1; then
    echo "$SETTINGS_SNIPPET" | jq .
  else
    echo "$SETTINGS_SNIPPET"
  fi
  echo
  echo "ccw shell function (add to your shell rc, e.g. ~/.bashrc or ~/.zshrc):"
  echo "$CCW_FUNCTION"
}

check_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not found on PATH." >&2
    echo "Install it first, e.g.: 'sudo apt install jq' (Debian/Ubuntu), 'brew install jq' (macOS)." >&2
    exit 1
  fi
}

check_curl() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "Warning: curl not found on PATH. Everything here works without it except" >&2
    echo "'ccswitch usage' (the all-account usage monitor), which needs curl to poll" >&2
    echo "the rate-limit endpoint. Install curl later if you want that feature." >&2
  fi
}

install_scripts() {
  mkdir -p "$CLAUDE_DIR"
  cp "$SCRIPT_DIR/statusline-usage.sh" "$CLAUDE_DIR/statusline-usage.sh"
  cp "$SCRIPT_DIR/ccswitch" "$CLAUDE_DIR/ccswitch"
  chmod +x "$CLAUDE_DIR/statusline-usage.sh" "$CLAUDE_DIR/ccswitch"
  echo "Installed: $CLAUDE_DIR/statusline-usage.sh"
  echo "Installed: $CLAUDE_DIR/ccswitch"
}

# configure_settings: merge the statusLine key into settings.json without
# disturbing any other key. Backs up the existing file first (once per run,
# always — even if this run turns out to be a no-op change).
configure_settings() {
  mkdir -p "$CLAUDE_DIR"

  if [[ -f "$SETTINGS_FILE" ]]; then
    if ! jq -e . "$SETTINGS_FILE" >/dev/null 2>&1; then
      echo "Error: $SETTINGS_FILE exists but is not valid JSON; refusing to modify it." >&2
      echo "Fix or remove it by hand, then re-run install.sh." >&2
      exit 1
    fi

    cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"

    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/cc-usage-bar-settings.XXXXXX")"
    jq --argjson sl "$STATUSLINE_JSON" '.statusLine = $sl' "$SETTINGS_FILE" >"$tmp"
    mv "$tmp" "$SETTINGS_FILE"

    echo "Backed up existing settings.json to $SETTINGS_FILE.bak"
    echo "Merged statusLine into $SETTINGS_FILE"
  else
    echo "$SETTINGS_SNIPPET" | jq . >"$SETTINGS_FILE"
    echo "Created $SETTINGS_FILE with the statusLine entry"
  fi
}

# rc_file_for_shell: pick ~/.zshrc when the user's login shell is zsh,
# otherwise default to ~/.bashrc.
rc_file_for_shell() {
  case "${SHELL:-}" in
    */zsh) echo "$HOME/.zshrc" ;;
    *) echo "$HOME/.bashrc" ;;
  esac
}

offer_ccw_function() {
  local rc_file
  rc_file="$(rc_file_for_shell)"

  if [[ -f "$rc_file" ]] && grep -qF "$CCW_FUNCTION" "$rc_file" 2>/dev/null; then
    echo "ccw() shell function already present in $rc_file -- skipping."
    return 0
  fi

  local answer
  read -r -p "Add a 'ccw' shell function (switch-and-relaunch shorthand) to $rc_file? [y/N] " answer
  case "$answer" in
    y | Y | yes | YES)
      {
        echo ""
        echo "# cc-usage-bar: ccswitch switch-and-relaunch shorthand"
        echo "$CCW_FUNCTION"
      } >>"$rc_file"
      echo "Added to $rc_file. Restart your shell (or 'source $rc_file') to use it."
      ;;
    *)
      echo "Skipped. You can add it later:"
      echo "  $CCW_FUNCTION"
      ;;
  esac
}

main() {
  if [[ "${1:-}" == "--print-only" ]]; then
    print_snippets
    exit 0
  fi

  check_jq
  check_curl

  install_scripts
  configure_settings

  echo
  print_snippets
  echo

  offer_ccw_function
}

main "$@"
