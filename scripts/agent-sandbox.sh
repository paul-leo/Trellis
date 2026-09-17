#!/usr/bin/env bash
# Runs real agent binaries against an isolated runtime fixture. Normal smoke
# runs use a disposable HOME. `--login`/`--status`/`--auth`/`--prepare`/`--host-auth` opt into one named Docker
# volume so the sandbox's own login survives container removal without ever
# copying the developer's host credentials.
set -euo pipefail

cd "$(dirname "$0")/.."
agent_fixture_home="${TRELLIS_AGENT_FIXTURE_HOME:-$(pwd)/test/fixtures/runtime-home}"

docker build -f docker/agent-sandbox.Dockerfile -t trellis-agent-sandbox . >&2

tty_flag="-i"
if [ -t 0 ]; then
  tty_flag="-it"
fi

auth_volume="${TRELLIS_AGENT_AUTH_VOLUME:-trellis-agent-auth-home}"
use_auth_volume=false
host_auth_agent=""

if [ "${1:-}" = "--login" ]; then
  agent="${2:-}"
  shift 2 || true
  use_auth_volume=true
  case "$agent" in
    codex) set -- codex login --device-auth ;;
    claude-code|claude) set -- claude auth login --claudeai ;;
    kiro) set -- kiro-cli login --license free --use-device-flow ;;
    *)
      echo "Usage: scripts/agent-sandbox.sh --login codex|claude|kiro" >&2
      exit 2
      ;;
  esac
fi

if [ "${1:-}" = "--status" ]; then
  agent="${2:-}"
  shift 2 || true
  use_auth_volume=true
  case "$agent" in
    codex) set -- codex login status ;;
    claude-code|claude) set -- claude auth status ;;
    kiro) set -- kiro-cli mcp list ;;
    *)
      echo "Usage: scripts/agent-sandbox.sh --status codex|claude|kiro" >&2
      exit 2
      ;;
  esac
fi

if [ "${1:-}" = "--auth" ]; then
  shift
  use_auth_volume=true
fi

if [ "${1:-}" = "--host-auth" ]; then
  host_auth_agent="${2:-}"
  shift 2 || true
  use_auth_volume=true
  case "$host_auth_agent" in
    codex|pi) ;;
    *)
      echo "Usage: scripts/agent-sandbox.sh --host-auth codex|pi" >&2
      exit 2
      ;;
  esac
fi

if [ "${1:-}" = "--prepare" ]; then
  shift
  use_auth_volume=true
  set -- node scripts/runtime-lab.mjs
fi

if [ "$#" -eq 0 ]; then
  set -- node scripts/agent-smoke-lab.mjs
fi

if [ "$use_auth_volume" = true ]; then
  docker volume create "$auth_volume" >/dev/null
  host_auth_source=""
  if [ -n "$host_auth_agent" ]; then
    case "$host_auth_agent" in
      codex) host_auth_source="${HOME}/.codex/auth.json" ;;
      pi) host_auth_source="${HOME}/.pi/agent/auth.json" ;;
    esac
    if [ ! -f "$host_auth_source" ]; then
      echo "Host auth file not found: $host_auth_source" >&2
      exit 2
    fi
    docker run --rm $tty_flag \
      -e "TRELLIS_HOST_AUTH_AGENT=$host_auth_agent" \
      -v "$auth_volume:/root-scratch" \
      -v "$host_auth_source:/host-auth/auth.json:ro" \
    -v "$agent_fixture_home:/fixtures-ro/home:ro" \
      trellis-agent-sandbox \
      "$@"
  else
    docker run --rm $tty_flag \
      -v "$auth_volume:/root-scratch" \
      -v "$(pwd)/test/fixtures/runtime-home:/fixtures-ro/home:ro" \
      trellis-agent-sandbox \
      "$@"
  fi
  exit $?
fi

docker run --rm $tty_flag \
  -v "$agent_fixture_home:/fixtures-ro/home:ro" \
  trellis-agent-sandbox \
  "$@"
