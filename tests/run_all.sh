#!/usr/bin/env bash
# run_all.sh -- run every test suite in this directory, aggregate the results.
# Exits non-zero if ANY suite fails, so CI and pre-commit hooks can gate on it.
# Each suite is self-contained (sandboxed HOME, stubbed network) and safe to run
# in any order; they are run in a fixed order purely so output is comparable
# between runs.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SUITES=(
  statusline_test.sh
  subagent_statusline_test.sh
  ccswitch_test.sh
  ccswitch_usage_test.sh
  install_test.sh
)

FAILED_SUITES=()

for suite in "${SUITES[@]}"; do
  echo "=============================================="
  echo "RUN: $suite"
  echo "=============================================="
  if bash "$SCRIPT_DIR/$suite"; then
    echo "SUITE OK: $suite"
  else
    echo "SUITE FAILED: $suite"
    FAILED_SUITES+=("$suite")
  fi
  echo
done

echo "=============================================="
if [[ "${#FAILED_SUITES[@]}" -eq 0 ]]; then
  echo "ALL SUITES PASSED (${#SUITES[@]} suites)"
  exit 0
fi
echo "FAILED SUITES (${#FAILED_SUITES[@]}/${#SUITES[@]}): ${FAILED_SUITES[*]}"
exit 1
