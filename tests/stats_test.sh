#!/usr/bin/env bash
# stats_test.sh -- unit tests for the Stats view engine (vscode/stats.js).
# Runs tests/stats_test.js under node with TZ pinned to UTC+8, so local days and UTC days differ.
# The tests write only synthetic transcripts in a temp dir; they never read ~/.claude.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not found (needed to test the Stats engine)"
  exit 1
fi

TZ=Etc/GMT-8 node "$SCRIPT_DIR/stats_test.js"
