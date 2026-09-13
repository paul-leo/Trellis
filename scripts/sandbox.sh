#!/usr/bin/env bash
# Build and run Trellis inside an isolated container. Default mode mounts
# the fixture home in test/fixtures/home — never touches this machine's
# real ~/.claude, ~/.codex, ~/.kiro, or ~/.pi. `--real` mode is the one
# exception: it explicitly copies this machine's real, allowlisted
# structural config (src/lib/realHomeSnapshot.ts) into a throwaway
# snapshot, refuses if `trellis secrets audit` finds anything in it, and
# only mounts that snapshot — the copy is deleted when this script exits.
# `--real` is never invoked by anything but an explicit human run of this
# script (no CI, no npm test) — copying real dotfiles is always a
# deliberate, one-off choice you make yourself.
#
# Usage:
#   scripts/sandbox.sh                    # interactive shell, fixture home
#   scripts/sandbox.sh npm run dev doctor # run a command, fixture home
#   scripts/sandbox.sh --real             # interactive shell, THIS machine's
#                                         # real allowlisted home
#   scripts/sandbox.sh --real npm run dev doctor
set -euo pipefail

cd "$(dirname "$0")/.."

MOUNT_SRC="$(pwd)/test/fixtures/home"

if [ "${1:-}" = "--real" ]; then
  shift
  SNAPSHOT_DIR="$(mktemp -d)"
  trap 'rm -rf "$SNAPSHOT_DIR"' EXIT
  npx tsx scripts/prepare-real-sandbox.ts "$HOME" "$SNAPSHOT_DIR"
  MOUNT_SRC="$SNAPSHOT_DIR"
fi

docker build -f docker/sandbox.Dockerfile -t trellis-sandbox . >&2

# -it only when stdin is actually a terminal (interactive shell use);
# CI and non-interactive callers (e.g. this repo's own tooling) get -i only.
TTY_FLAG="-i"
if [ -t 0 ]; then
  TTY_FLAG="-it"
fi

docker run --rm $TTY_FLAG \
  -v "$MOUNT_SRC:/fixtures-ro/home:ro" \
  trellis-sandbox \
  "${@:-sh}"
