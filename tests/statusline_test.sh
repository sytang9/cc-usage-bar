#!/usr/bin/env bash
# Test harness for statusline-usage.sh
# Self-contained bash; no external test framework. Sandboxes HOME per case.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_DIR/statusline-usage.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

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

# make_sandbox: create a fresh temp dir to use as HOME, echo its path
make_sandbox() {
  mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-test.XXXXXX"
}

# run_with_home <home_dir> <fixture_file> -> sets OUT, EXIT_CODE
run_script() {
  local home_dir="$1"
  local fixture="$2"
  OUT="$(HOME="$home_dir" bash "$TARGET" <"$fixture" 2>&1)"
  EXIT_CODE=$?
}

# --- Case 1: normal.json with full account identity -----------------------
case1() {
  local home_dir
  home_dir="$(make_sandbox)"
  mkdir -p "$home_dir/.claude"
  cp "$FIXTURES/claude_account.json" "$home_dir/.claude.json"

  run_script "$home_dir" "$FIXTURES/normal.json"

  local line_count
  line_count="$(printf '%s\n' "$OUT" | wc -l)"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -q "62" \
    && printf '%s' "$OUT" | grep -q "31" \
    && printf '%s' "$OUT" | grep -q "test-user@example.com" \
    && printf '%s' "$OUT" | grep -q "Opus" \
    && [[ "$line_count" -eq 3 ]]; then
    pass "case1 normal output has pcts, email, model, 3 lines"
  else
    fail "case1 normal output (exit=$EXIT_CODE lines=$line_count): $OUT"
  fi

  rm -rf "$home_dir"
}

# --- Case 2: high.json triggers crit color (256-color code 167) -----------
case2() {
  local home_dir
  home_dir="$(make_sandbox)"

  run_script "$home_dir" "$FIXTURES/high.json"

  if [[ "$EXIT_CODE" -eq 0 ]] && printf '%s' "$OUT" | grep -q $'\033\[38;5;167m'; then
    pass "case2 high pct shows crit color 167"
  else
    fail "case2 high pct crit color missing (exit=$EXIT_CODE): $(printf '%s' "$OUT" | cat -v)"
  fi

  rm -rf "$home_dir"
}

# --- Case 3: null_limits.json -> waiting message, exit 0, non-empty -------
case3() {
  local home_dir
  home_dir="$(make_sandbox)"

  run_script "$home_dir" "$FIXTURES/null_limits.json"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -q "waiting for first API call" \
    && [[ -n "$OUT" ]]; then
    pass "case3 null rate_limits shows waiting message, exit 0, non-empty"
  else
    fail "case3 null rate_limits (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir"
}

# --- Case 4: normal.json but no oauthAccount -> email omitted -------------
case4() {
  local home_dir
  home_dir="$(make_sandbox)"
  mkdir -p "$home_dir/.claude"
  echo '{}' >"$home_dir/.claude.json"

  run_script "$home_dir" "$FIXTURES/normal.json"

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && ! printf '%s' "$OUT" | grep -q "test-user@example.com" \
    && [[ -n "$OUT" ]]; then
    pass "case4 missing oauthAccount omits email, still prints rows"
  else
    fail "case4 missing oauthAccount (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir"
}

# --- Case 5: secret-leak guard ---------------------------------------------
case5() {
  local home_dir
  local fake_token="sk-ant-oat01-FAKESECRETTOKENVALUE1234567890"
  home_dir="$(make_sandbox)"
  mkdir -p "$home_dir/.claude"
  cp "$FIXTURES/claude_account.json" "$home_dir/.claude.json"
  printf '{"claudeAiOauth":{"accessToken":"%s"}}' "$fake_token" >"$home_dir/.claude/.credentials.json"
  chmod 600 "$home_dir/.claude/.credentials.json"

  run_script "$home_dir" "$FIXTURES/normal.json"

  if [[ "$EXIT_CODE" -eq 0 ]] && ! printf '%s' "$OUT" | grep -q "$fake_token"; then
    pass "case5 fake token never appears in output"
  else
    fail "case5 secret leak detected (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir"
}

# --- Bonus: no jq on PATH -> clean fallback line, exit 0 -------------------
case6() {
  local home_dir stub_dir bash_bin
  home_dir="$(make_sandbox)"
  stub_dir="$(mktemp -d "${TMPDIR:-/tmp}/cc-usage-bar-nopath.XXXXXX")"
  bash_bin="$(command -v bash)"

  # Keep bash itself reachable (needed to run the script at all, since the
  # shebang is `env bash`) via a symlink in an otherwise-empty stub dir, so
  # jq (which lives alongside bash in /usr/bin) is NOT on PATH.
  ln -s "$bash_bin" "$stub_dir/bash"
  OUT="$(HOME="$home_dir" PATH="$stub_dir" bash "$TARGET" <"$FIXTURES/normal.json" 2>&1)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && printf '%s' "$OUT" | grep -q "jq not installed" \
    && [[ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ]]; then
    pass "case6 missing jq prints single clean fallback line, exit 0"
  else
    fail "case6 missing jq handling (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir" "$stub_dir"
}

# --- Bonus: unbound variable inside main -> guard still catches it --------
# `set -u` makes bash hard-exit the whole *process* on an unbound variable
# reference in non-interactive mode -- this bypasses a naive `main || echo`
# guard entirely (the `||` never runs). The script must instead run main in
# a command substitution so the hard-exit is confined to a subshell. This
# test injects an unbound-variable reference into a scratch copy of the real
# script to prove that isolation mechanism actually works, rather than
# trusting that every current code path inside main happens to be bug-free.
case8() {
  local home_dir scratch_script
  home_dir="$(make_sandbox)"
  scratch_script="$(mktemp "${TMPDIR:-/tmp}/cc-usage-bar-unbound.XXXXXX.sh")"

  sed 's/local model_name effort_level ctx_pct/local model_name effort_level ctx_pct\n  echo "$THIS_VAR_IS_INTENTIONALLY_UNBOUND" >\/dev\/null/' \
    "$TARGET" >"$scratch_script"
  chmod +x "$scratch_script"

  OUT="$(HOME="$home_dir" bash "$scratch_script" <"$FIXTURES/normal.json" 2>/dev/null)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -eq 0 ]] \
    && [[ -n "$OUT" ]] \
    && [[ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ]]; then
    pass "case8 unbound variable inside main is caught by the guard"
  else
    fail "case8 unbound variable not caught (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir" "$scratch_script"
}

# --- Bonus: malformed JSON on stdin -> single fallback line, exit 0 -------
case7() {
  local home_dir
  home_dir="$(make_sandbox)"

  OUT="$(HOME="$home_dir" bash "$TARGET" <<<'{not valid json' 2>&1)"
  EXIT_CODE=$?

  if [[ "$EXIT_CODE" -eq 0 ]] && [[ -n "$OUT" ]] && [[ "$(printf '%s\n' "$OUT" | wc -l)" -eq 1 ]]; then
    pass "case7 malformed JSON yields single fallback line, exit 0"
  else
    fail "case7 malformed JSON handling (exit=$EXIT_CODE): $OUT"
  fi

  rm -rf "$home_dir"
}

main() {
  if [[ ! -x "$TARGET" ]]; then
    echo "FAIL: target script not found or not executable: $TARGET"
    exit 1
  fi

  case1
  case2
  case3
  case4
  case5
  case6
  case7
  case8

  echo
  echo "----------------------------------------"
  echo "Passed: $PASS_COUNT  Failed: $FAIL_COUNT"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
