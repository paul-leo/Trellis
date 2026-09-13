#!/usr/bin/env bash
# Real package-install check for the `trellis` CLI bin entry — same
# rationale as scripts/verify-sdk-export.sh, applied to `bin` instead of
# `exports`: a source-relative `tsx src/cli.ts` run (what `npm run dev`
# does) can't catch a `bin` entry that's broken once actually installed
# (missing shebang after build, a relative import that only resolves
# under tsx, etc.). Packs the real tarball, installs it into a throwaway
# scratch project, and runs the installed `trellis` binary against a
# scratch $HOME — never this developer's real dotfiles.
set -euo pipefail

cd "$(dirname "$0")/.."
npm run build >/dev/null
npm pack >/dev/null

SCRATCH="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$SCRATCH" "$FAKE_HOME"; rm -f agent-trellis-*.tgz' EXIT

mkdir -p "$FAKE_HOME/.trellis"
echo "# instructions" > "$FAKE_HOME/.trellis/agents.md"

cp agent-trellis-*.tgz "$SCRATCH/"
cd "$SCRATCH"
npm init -y >/dev/null 2>&1
npm install ./agent-trellis-*.tgz >/dev/null 2>&1

echo "=== trellis --help ==="
./node_modules/.bin/trellis --help

echo "=== trellis doctor (against a scratch, empty-agent HOME) ==="
HOME="$FAKE_HOME" ./node_modules/.bin/trellis doctor

echo "=== trellis init (against a fresh scratch HOME) ==="
FRESH_HOME="$(mktemp -d)"
trap 'rm -rf "$SCRATCH" "$FAKE_HOME" "$FRESH_HOME"; rm -f agent-trellis-*.tgz' EXIT
HOME="$FRESH_HOME" ./node_modules/.bin/trellis init

echo "=== trellis migrate --from claude-code (agent not present, expect clean refusal) ==="
HOME="$FRESH_HOME" ./node_modules/.bin/trellis migrate --from claude-code || true

echo "=== trellis onboard --json (zero agents present, expect install hints) ==="
ONBOARD_HOME="$(mktemp -d)"
trap 'rm -rf "$SCRATCH" "$FAKE_HOME" "$FRESH_HOME" "$ONBOARD_HOME"; rm -f agent-trellis-*.tgz' EXIT
HOME="$ONBOARD_HOME" ./node_modules/.bin/trellis onboard --json

echo "=== trellis onboard --agent/--manage against a real present agent (trellis-managed-agents) ==="
MANAGED_HOME="$(mktemp -d)"
trap 'rm -rf "$SCRATCH" "$FAKE_HOME" "$FRESH_HOME" "$ONBOARD_HOME" "$MANAGED_HOME"; rm -f agent-trellis-*.tgz' EXIT
echo "{}" > "$MANAGED_HOME/.claude.json"
HOME="$MANAGED_HOME" ./node_modules/.bin/trellis onboard --agent claude-code --manage claude-code
grep -q "agents: \[claude-code\]" "$MANAGED_HOME/.trellis/managed.yaml"

echo "=== trellis rollback undoes the real write onboard just made (trellis-backup-rollback) ==="
test -d "$MANAGED_HOME/.trellis/backups" || { echo "FAIL: no backup run directory created by the real onboard run"; exit 1; }
HOME="$MANAGED_HOME" ./node_modules/.bin/trellis rollback
test -L "$MANAGED_HOME/.claude/CLAUDE.md" && { echo "FAIL: rollback should have removed the symlink onboard created"; exit 1; }

echo "OK: the installed trellis binary runs doctor/init/migrate/onboard/rollback without crashing"
