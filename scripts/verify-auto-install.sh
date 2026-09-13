#!/usr/bin/env bash
# Real network install check for `src/lib/installAgent.ts`'s
# `confirmAndInstall` — every existing test (test/unit/installAgent.test.ts)
# injects a fake `runInstall`, so the actual `npm install -g <pkg>` this
# code runs for real has never been exercised end to end. Runs the real
# project code (not a hand-typed npm command) for claude-code, codex, and
# pi, each redirected via NPM_CONFIG_PREFIX to its own throwaway global
# prefix — never this machine's real global npm state — and confirms the
# resulting binary actually runs. Kiro has no npm package
# (`confirmAndInstall` refuses it before ever reaching this code) and is
# not exercised here. Manual, network-dependent, never invoked by `npm
# test` or CI — same convention as scripts/verify-cli-install.sh and
# scripts/sandbox.sh --real.
#
# Usage: scripts/verify-auto-install.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

check() {
  local agent="$1" version_flag="$2" bin_name="$3"
  local prefix script_dir script
  prefix="$(mktemp -d)"
  script_dir="$(mktemp -d)"
  script="$script_dir/verify.mts"
  trap 'rm -rf "$script_dir"' RETURN

  cat > "$script" <<EOF
import { confirmAndInstall } from "$ROOT/src/lib/installAgent.js";
const result = await confirmAndInstall("$agent", { confirm: async () => true });
if (!result.installed) throw new Error("$agent: confirmAndInstall reported installed=false");
EOF

  echo "=== $agent: npm install -g (isolated prefix) ==="
  NPM_CONFIG_PREFIX="$prefix" npx tsx "$script"

  if [ ! -x "$prefix/bin/$bin_name" ]; then
    echo "FAIL: $prefix/bin/$bin_name was not created"
    rm -rf "$prefix"
    exit 1
  fi
  "$prefix/bin/$bin_name" "$version_flag"
  rm -rf "$prefix"
  echo
}

check codex --version codex
check claude-code --version claude
check pi --version pi

echo "OK: confirmAndInstall's real npm install path produces a working binary for claude-code, codex, and pi"
