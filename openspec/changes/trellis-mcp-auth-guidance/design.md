# Design

## Goals / Non-Goals

**Goals:**

- Make every skipped MCP server explainable and actionable.
- Let an Agent tell the user what command to run without needing a browser or
  a terminal attached to the Gateway process.
- Keep status useful even when every upstream fails: built-in Runtime tools
  must still list and answer.
- Never return token values, Authorization headers, or env file contents.

**Non-Goals:**

- Do not start an OAuth browser flow from Gateway or from an MCP tool call.
- Do not invent a provider-specific login command when the server is only
  known to need a variable or executable.
- Do not make status itself perform an upstream handshake a second time.

## Decisions

### D1 — Backend owns status facts

`LocalBackend` records one status per resolved upstream: `ready`,
`auth-required`, `unavailable`, or `timeout`, with a sanitized detail and an
optional remediation. Failed upstreams remain absent from the tool registry,
but their status remains available to the Runtime provider.

### D2 — Runtime exposes a read-only status tool

The built-in Runtime registry adds `trellis.mcp.status`. Its result includes
server names, transport, status, sanitized detail, and next action. For a
remote OAuth-like failure the next action is `trellis mcp auth <server>`;
stdio failures explain that the command or environment must be fixed. No
secret value is included.

### D3 — Human authorization boundary remains explicit

`trellis mcp auth <server>` remains the only initial OAuth entry point. It may
open a browser and stores the credential under the existing 0600 OAuth store.
The Gateway status tool only guides the user to that command. Silent refresh
continues to happen inside Gateway when a refresh token exists.

### D4 — Status survives partial upstream failure

Built-in SkillProvider and RuntimeMemoryProvider are registered independently
of upstream connections. A failed upstream produces a status record and a
warning, not a failed MCP initialize.

## Verification

- A real Kimi Gateway session lists `trellis.mcp.status` even when Figma or
  another upstream is unauthorized.
- Status reports an OAuth remediation command without token values.
- A healthy upstream remains callable while another is unavailable.
- Existing Skill/Memory tools remain callable in the same session.
