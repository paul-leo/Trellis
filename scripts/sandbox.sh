#!/usr/bin/env bash
# Build and run Trellis inside an isolated container against the
# fixture home in test/fixtures/home. Never touches this machine's real
# ~/.claude, ~/.codex, ~/.kiro, or ~/.pi.
#
# Usage:
#   scripts/sandbox.sh                    # interactive shell in the sandbox
#   scripts/sandbox.sh npm run dev doctor  # run a command in the sandbox
set -euo pipefail

cd "$(dirname "$0")/.."

docker build -f docker/sandbox.Dockerfile -t trellis-sandbox . >&2

# -it only when stdin is actually a terminal (interactive shell use);
# CI and non-interactive callers (e.g. this repo's own tooling) get -i only.
TTY_FLAG="-i"
if [ -t 0 ]; then
  TTY_FLAG="-it"
fi

docker run --rm $TTY_FLAG \
  -v "$(pwd)/test/fixtures/home:/fixtures-ro/home:ro" \
  trellis-sandbox \
  "${@:-sh}"
