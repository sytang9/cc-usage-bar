#!/usr/bin/env bash
# vscode_extension_test.sh -- unit tests for the VS Code sidebar (vscode/extension.js).
# Runs tests/vscode_extension_test.js under node in a sandboxed HOME; never touches the real ~/.claude.
# The .js refuses to run unless this wrapper marks the sandbox (CCUB_TEST_SANDBOX=1, HOME under $TMPDIR).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_JS="$SCRIPT_DIR/vscode_extension_test.js"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not found (needed to test the VS Code extension)"
  exit 1
fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-vscode-test.XXXXXX")"
PROBE="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-vscode-probe.XXXXXX")"
mkdir -p "$PROBE-other"
trap 'rm -rf "$SANDBOX" "$PROBE" "$PROBE-other"' EXIT
mkdir -p "$SANDBOX/.claude"

# The guard: a probe HOME (a throwaway dir) without the marker, and with the marker but HOME outside
# TMPDIR, must both exit 2 and write nothing.
guard_failed=0
probe() {  # probe <name> <env...>
  local name="$1"; shift
  env "$@" node "$TEST_JS" >/dev/null 2>&1
  local rc=$?
  if [[ "$rc" -eq 2 ]] && [[ -z "$(ls -A "$PROBE")" ]]; then
    echo "PASS: guard refuses $name"
  else
    echo "FAIL: guard did not refuse $name (exit=$rc, wrote: $(ls -A "$PROBE" | tr '\n' ' '))"
    guard_failed=1
  fi
}
probe "a run without the sandbox marker" HOME="$PROBE" CCUB_TEST_SANDBOX=
probe "a HOME outside TMPDIR" HOME="$PROBE" CCUB_TEST_SANDBOX=1 TMPDIR="$PROBE-other"

HOME="$SANDBOX" CCUB_TEST_SANDBOX=1 node "$TEST_JS"
rc=$?
[[ "$guard_failed" -eq 0 ]] || exit 1
exit "$rc"
