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
    codex|pi|kimi-code|kimi|claude-code|claude) ;;
    *)
      echo "Usage: scripts/agent-sandbox.sh --host-auth codex|pi|kimi-code|claude-code" >&2
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
      claude|claude-code) host_auth_agent="claude-code" ;;
      kimi|kimi-code) host_auth_agent="kimi-code" ;;
    esac
    case "$host_auth_agent" in
      codex) host_auth_source="${HOME}/.codex/auth.json" ;;
      pi) host_auth_source="${HOME}/.pi/agent/auth.json" ;;
      kimi-code) host_auth_source="${HOME}/.kimi-code/credentials/kimi-code.json" ;;
      # macOS stores this in the system Keychain instead of a file (Claude
      # Code migrates it there and deletes the file on write); this path is
      # the Linux/CI fallback location the CLI itself uses when no Keychain
      # exists. On a Mac this SHALL fail the existence check below rather
      # than silently trying to read a stale or absent file.
      claude-code) host_auth_source="${HOME}/.claude/.credentials.json" ;;
    esac
    if [ ! -f "$host_auth_source" ]; then
      echo "Host auth file not found: $host_auth_source" >&2
      if [ "$host_auth_agent" = "claude-code" ]; then
        echo "Claude Code on macOS stores its token in the system Keychain, not a file — this bridge only supports the file-based credential Claude Code itself writes on Linux/CI. Run 'claude setup-token' to mint a portable long-lived token instead, or supply it another way (e.g. CLAUDE_CODE_OAUTH_TOKEN)." >&2
      fi
      exit 2
    fi
    # Kimi Code's OAuth credential alone is not enough to pick a model —
    # that lives in its separate config.toml (provider/model registration,
    # no different in kind from the model list Codex/Claude Code ship
    # baked into their own binaries). Bridged the exact same read-only,
    # single-file, container-destroyed-after way as the auth file itself,
    # only when the host actually has one — its absence is not an error,
    # since not every target needs a second file.
    extra_mounts=()
    if [ "$host_auth_agent" = "kimi-code" ] && [ -f "${HOME}/.kimi-code/config.toml" ]; then
      extra_mounts+=(-v "${HOME}/.kimi-code/config.toml:/host-auth/config.toml:ro")
    fi
    docker run --rm $tty_flag \
      -e "TRELLIS_HOST_AUTH_AGENT=$host_auth_agent" \
      -v "$auth_volume:/root-scratch" \
      -v "$host_auth_source:/host-auth/auth.json:ro" \
      "${extra_mounts[@]}" \
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
