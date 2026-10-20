#!/usr/bin/env bash
# vscode_extension_test.sh -- unit tests for the VS Code sidebar (vscode/extension.js).
# Runs tests/vscode_extension_test.js under node in a sandboxed HOME; never touches the real ~/.claude.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not found (needed to test the VS Code extension)"
  exit 1
fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-vscode-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/.claude"
HOME="$SANDBOX" node "$SCRIPT_DIR/vscode_extension_test.js"
