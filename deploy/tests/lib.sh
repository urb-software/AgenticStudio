#!/usr/bin/env bash
# Shared helpers for the deploy tests (sourced; CI job deploy:server).
# shellcheck disable=SC2317 # helpers used by the sourcing scripts

TEST_FAILURES=0

ok() { printf 'ok    %s\n' "$*"; }
not_ok() {
  TEST_FAILURES=$((TEST_FAILURES + 1))
  printf 'NOT OK %s\n' "$*"
}
section() { printf '\n=== %s\n' "$*"; }

# expect_fail <description> <expected text> <command...>: the command exits non-zero and its
# output contains the text.
expect_fail() {
  local description="$1" text="$2" output status
  shift 2
  output="$("$@" 2>&1)"
  status=$?
  printf '%s\n' "$output" | sed 's/^/      | /'
  if [ "$status" -ne 0 ] && grep -qF -- "$text" <<<"$output"; then
    ok "$description (exit $status)"
  else
    not_ok "$description (exit $status, expected non-zero with '$text')"
  fi
}

# expect_line <description> <output> <regex>: some line of the output matches.
expect_line() {
  if grep -Eq -- "$3" <<<"$2"; then ok "$1"; else not_ok "$1 (no line matching '$3')"; fi
}

# expect_stat <path> <owner:group> <mode>
expect_stat() {
  local actual
  actual="$(stat -c '%U:%G %a' "$1" 2>/dev/null)"
  if [ "$actual" = "$2 $3" ]; then ok "$1 is $2 $3"; else not_ok "$1 is '${actual:-missing}', expected '$2 $3'"; fi
}

expect_true() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$description"; else not_ok "$description"; fi
}

expect_false() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then not_ok "$description"; else ok "$description"; fi
}

finish() {
  echo
  if [ "$TEST_FAILURES" -gt 0 ]; then
    echo "FAILED: $TEST_FAILURES assertion(s)"
    exit 1
  fi
  echo "ALL PASSED"
}
