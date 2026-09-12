#!/bin/sh
# Copies the read-only fixture home into a container-local writable
# location before running anything, so no command executed here can ever
# write back to test/fixtures/home on the host — that directory is checked
# into git and must stay a clean, deterministic starting point every run.
set -e

cp -r /fixtures-ro/home /root-scratch
export HOME=/root-scratch
export PATH="/trellis/node_modules/.bin:$PATH"

cd /trellis
exec "$@"
