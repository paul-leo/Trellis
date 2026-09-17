#!/usr/bin/env bash
# Runs the disposable Linux scenario matrix. Every case gets a fresh
# container-local HOME; no case shares state with another case or with the
# developer's real agent configuration.
set -euo pipefail

cd "$(dirname "$0")/.."

run_success() {
  local mode="$1"
  printf '\n=== sandbox scenario: %s ===\n' "$mode"
  scripts/sandbox.sh "--$mode"
}

run_success runtime
run_success migration
run_success management
run_success failure

printf '\n=== sandbox scenario: expected collision failure ===\n'
result_dir="$(mktemp -d)"
trap 'rm -rf "$result_dir"' EXIT
set +e
scripts/sandbox.sh trellis mcp sync --json >"$result_dir/stdout" 2>"$result_dir/stderr"
status=$?
set -e
test "$status" -eq 1
rg -q "sentry" "$result_dir/stdout" "$result_dir/stderr"
printf 'expected collision was reported with exit code 1\n'

printf '\nPASS: sandbox scenario matrix\n'
