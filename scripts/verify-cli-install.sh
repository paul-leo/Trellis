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

echo "OK: the installed trellis binary runs doctor without crashing"
