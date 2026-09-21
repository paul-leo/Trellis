#!/bin/sh
# Copies the read-only fixture home into a container-local writable
# location before running anything, so no command executed here can ever
# write back to test/fixtures/home on the host — that directory is checked
# into git and must stay a clean, deterministic starting point every run.
set -e

FIXTURE_HOME_PATH=${TRELLIS_FIXTURE_HOME:-/fixtures-ro/home}
mkdir -p /root-scratch
cp -R "${FIXTURE_HOME_PATH}"/. /root-scratch/
export HOME=/root-scratch
export KIRO_HOME="$HOME/.kiro"
export PATH="/trellis/node_modules/.bin:$PATH"

# Optional host-auth bridge. The launcher mounts one selected auth file
# read-only at /host-auth/auth.json. Only that file is copied into the
# container-local auth volume; its value is never printed.
case "${TRELLIS_HOST_AUTH_AGENT:-}" in
  codex)
    mkdir -p "$HOME/.codex"
    cp /host-auth/auth.json "$HOME/.codex/auth.json"
    chmod 600 "$HOME/.codex/auth.json"
    ;;
  pi)
    mkdir -p "$HOME/.pi/agent"
    cp /host-auth/auth.json "$HOME/.pi/agent/auth.json"
    chmod 600 "$HOME/.pi/agent/auth.json"
    ;;
  kimi-code)
    mkdir -p "$HOME/.kimi-code/credentials"
    cp /host-auth/auth.json "$HOME/.kimi-code/credentials/kimi-code.json"
    chmod 600 "$HOME/.kimi-code/credentials/kimi-code.json"
    # Optional: the host's real provider/model registration. Absent when
    # the launcher found no config.toml to bridge — not an error, since a
    # bare OAuth credential is still meaningful for e.g. `kimi doctor`.
    if [ -f /host-auth/config.toml ]; then
      cp /host-auth/config.toml "$HOME/.kimi-code/config.toml"
      chmod 600 "$HOME/.kimi-code/config.toml"
    fi
    ;;
  claude-code)
    mkdir -p "$HOME/.claude"
    cp /host-auth/auth.json "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    ;;
  "") ;;
  *)
    echo "unsupported host auth agent: $TRELLIS_HOST_AUTH_AGENT" >&2
    exit 2
    ;;
esac

# Every name test/fixtures/home/.trellis/secrets.policy.yaml's allowed_vars
# lists is presumed, by the fixture's own design, to resolve to *something*
# in a real working setup — these are the sandbox's own stand-in values
# (trellis-mcp-static-env-and-disabled-servers: mcp sync now refuses to
# write a name-only env entry that doesn't resolve, so a fixture server
# declaring one of these names needs it actually set here, same as it
# would need to be on a real machine).
export SAMPLE_TOKEN="sandbox-sample-token"
export REMOTE_BEARER_TOKEN="sandbox-bearer-token"
export REMOTE_MULTI_TOKEN="sandbox-multi-token"
export REMOTE_MULTI_KEY="sandbox-multi-key"

cd /trellis
exec "$@"
