# Proposal

## Why

Kimi Code 2.0 is installed locally and supports both Agent Skills and MCP,
but its default Skill discovery includes the shared `~/.agents/skills` root.
If Trellis simply adds Kimi to the existing native projections, Kimi would
consume the same Skill twice: once natively and once through Trellis Runtime.

Trellis needs a first-class Runtime-first integration for Kimi: one managed
MCP entry, Skill/Memory exposed through Trellis providers, and selected
upstream MCP servers mounted behind the existing GatewayBackend.

## What Changes

- Add `kimi-code` as a supported Agent identity and probe target.
- Add a Kimi adapter for `~/.kimi-code/mcp.json` that owns exactly one
  `trellis-runtime` entry when Runtime delivery is selected.
- Add a `trellis kimi` launcher that starts Kimi with an empty `--skills-dir`
  so shared native Skill roots cannot duplicate Runtime Skill delivery.
- Add Kimi Runtime delivery to capability selection and onboarding.
- Use Kimi's `deferred` MCP option for the Runtime entry where supported, while
  keeping Trellis Runtime's own progressive-disclosure providers authoritative.
- Preserve Kimi's existing user configuration, OAuth files, sessions, and
  unrelated MCP entries.
- Verify Kimi's real binary, MCP config recognition, Runtime handshake,
  SkillProvider/MemoryProvider visibility, and upstream gateway routing in the
  isolated Agent sandbox.

## Capabilities

### New Capabilities

- `kimi-code-runtime-delivery`: Runtime-first Kimi Code integration with one
  MCP entry and native Skill-discovery isolation.

### Modified Capabilities

- `agent-state-probing`: recognize Kimi Code as a supported installed Agent.
- `agent-management-scope`: allow Kimi Code in the managed-agent boundary.
- `mcp-server-sync`: project the owned Runtime entry into Kimi's `mcp.json`.
- `onboarding-flow`: expose Kimi in selection and onboarding summaries.

## Impact

- `src/core/types.ts`, probes, adapters, CLI, onboarding, capability-selection
  schema, Runtime launcher, and Kimi-specific tests.
- No new runtime dependency; uses Kimi Code's documented CLI and JSON MCP
  schema.
- The current canonical `SkillProvider`, `RuntimeMemoryProvider`, and
  `UpstreamProvider` remain unchanged and become Kimi's capability edge.
- Kimi login state and credentials remain outside Trellis canonical data.
