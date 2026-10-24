#!/usr/bin/env bash
# vscode_extension_test.sh -- unit tests for the VS Code sidebar (vscode/extension.js).
# Runs each test file under node in its own sandboxed HOME; never touches the real ~/.claude.
# Every file requires tests/vscode/harness.js first, which refuses to run unless this wrapper marks the sandbox
# (CCUB_TEST_SANDBOX=1, HOME under $TMPDIR, CODEX_HOME inside HOME).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_FILES=("$SCRIPT_DIR/vscode_extension_test.js")
for f in "$SCRIPT_DIR"/vscode/*.js; do
  [[ "$(basename "$f")" == harness.js ]] || TEST_FILES+=("$f")
done

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not found (needed to test the VS Code extension)"
  exit 1
fi

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-vscode-test.XXXXXX")"
PROBE="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-vscode-probe.XXXXXX")"
mkdir -p "$PROBE-other"
trap 'rm -rf "$SANDBOX" "$PROBE" "$PROBE-other"' EXIT

# The guard: a probe HOME (a throwaway dir) without the marker, with the marker but HOME outside TMPDIR,
# or with CODEX_HOME outside that HOME, must make every test file exit 2 and write nothing.
guard_failed=0
probe() {  # probe <name> <env...>
  local name="$1"; shift
  local f rc bad=""
  for f in "${TEST_FILES[@]}"; do
    env "$@" node "$f" >/dev/null 2>&1
    rc=$?
    [[ "$rc" -eq 2 ]] || bad+=" $(basename "$f")(exit=$rc)"
  done
  if [[ -z "$bad" ]] && [[ -z "$(ls -A "$PROBE")" ]]; then
    echo "PASS: guard refuses $name"
  else
    echo "FAIL: guard did not refuse $name (${bad:+files:$bad; }wrote: $(ls -A "$PROBE" | tr '\n' ' '))"
    guard_failed=1
  fi
}
probe "a run without the sandbox marker" HOME="$PROBE" CCUB_TEST_SANDBOX=
probe "a HOME outside TMPDIR" HOME="$PROBE" CCUB_TEST_SANDBOX=1 TMPDIR="$PROBE-other"
probe "a CODEX_HOME outside the sandbox HOME" HOME="$PROBE" CODEX_HOME="$PROBE-other" CCUB_TEST_SANDBOX=1

# One fresh sandbox HOME per file, so no file depends on what another left behind.
rc=0 total_pass=0 total_fail=0
for f in "${TEST_FILES[@]}"; do
  name="$(basename "$f" .js)"
  home="$SANDBOX/$name"
  mkdir -p "$home/.claude"
  echo "--- $name"
  out="$(HOME="$home" CODEX_HOME="$home/.codex" CCUB_TEST_SANDBOX=1 node "$f" 2>&1)" || rc=1
  printf '%s\n' "$out"
  total_pass=$((total_pass + $(grep -c '^PASS: ' <<<"$out")))
  total_fail=$((total_fail + $(grep -c '^FAIL: ' <<<"$out")))
done
echo "========================================"
echo "TOTAL Passed: $total_pass  Failed: $total_fail  (${#TEST_FILES[@]} files)"
[[ "$guard_failed" -eq 0 ]] || exit 1
exit "$rc"
