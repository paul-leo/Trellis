#!/usr/bin/env bash
# Real package-resolution check for the SDK's "exports" map
# (trellis-sdk-p5 tasks.md 3.2) — a source-relative import (what
# test/unit/sdk.test.ts does) can't catch an "exports" map broken well
# enough that a real consumer's node_modules resolution would fail even
# though tsc/tsx resolution succeeds. Packs the real tarball, installs it
# into a throwaway scratch project, and imports it via the bare
# "agent-trellis" specifier — the same resolution path an actual
# consumer goes through.
set -euo pipefail

cd "$(dirname "$0")/.."
npm run build >/dev/null
npm pack >/dev/null

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"; rm -f agent-trellis-*.tgz' EXIT

cp agent-trellis-*.tgz "$SCRATCH/"
cd "$SCRATCH"
npm init -y >/dev/null 2>&1
npm install ./agent-trellis-*.tgz >/dev/null 2>&1

node --input-type=module -e "
import { loadCanonicalSource, ALL_AGENTS } from 'agent-trellis';
if (typeof loadCanonicalSource !== 'function') throw new Error('loadCanonicalSource did not resolve as a function');
if (JSON.stringify(ALL_AGENTS) !== '[\"claude-code\",\"codex\",\"kiro\",\"pi\"]') throw new Error('ALL_AGENTS did not resolve correctly: ' + JSON.stringify(ALL_AGENTS));
console.log('OK: agent-trellis resolves loadCanonicalSource and ALL_AGENTS via real package exports');
"
