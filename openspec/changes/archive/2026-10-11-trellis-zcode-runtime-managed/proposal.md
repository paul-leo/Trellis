# Proposal

## Why

ZCode is now open source and the local machine has a usable `zcode-app-cli`
runtime, but Trellis cannot manage it. ZCode also discovers the shared
`~/.agents/skills` tree, so a native projection would bypass Trellis's
per-agent scope boundary.

Trellis needs a first-class, Runtime-first ZCode integration that manages one
owned MCP entry, shares scoped Skills and Memory through Trellis Runtime, and
uses a documented CLI contract for invocation when a compatible ZCode CLI is
installed.

## What Changes

- Add `zcode` as a supported managed Agent, with probe, migration, onboarding,
  doctor, Runtime, gateway, and lifecycle support.
- Add a profile-aware ZCode adapter that preserves unrelated JSON state and
  manages the nested `mcp.servers` map in either the official
  `~/.zcode/cli/config.json` or the local `zcode-app-cli`
  `~/.zcode/cli/setting.json`.
- Make Runtime delivery the ZCode default: one `trellis mcp-runtime --agent
  zcode` stdio entry provides canonical Skills, shared Memory, and eligible
  upstream MCP servers.
- In Runtime-only delivery, ledger-manage ZCode's native-Skill switches so its
  automatic `~/.agents/skills` discovery cannot expose skills outside their
  canonical scope; project shared instructions to `~/.zcode/AGENTS.md`.
- Add ZCode CLI chat and delegated-call support for compatible public `zcode`
  binaries, including its `stream-json` session and response event schema.
- Keep desktop-only ZCode installations configuration-manageable without
  invoking private application paths as a process-host API.
- Replace the now-stale documentation claim that ZCode lacks a headless CLI.

## Capabilities

### New Capabilities

- `zcode-runtime-managed`: Profile-aware Runtime-first configuration,
  instruction, capability, and isolation delivery for ZCode.
- `zcode-cli-chat`: Safe non-interactive ZCode CLI invocation and structured
  chat-session streaming.

### Modified Capabilities

- `agent-management-scope`: Allow ZCode in managed-agent lifecycle and scope
  validation.
- `agent-state-probing`: Produce a read-only ZCode snapshot from its native
  configuration and public CLI identity.
- `mcp-server-sync`: Synchronize an ownership-safe ZCode nested MCP map.
- `skill-instructions-sync`: Define ZCode instruction projection and
  Runtime-only native-Skill isolation.
- `canonical-source-migration`: Import ZCode Skills, instructions, and native
  MCP declarations into canonical source.
- `onboarding-flow`: Surface ZCode discovery, management, and Runtime delivery
  in onboarding.
- `capability-drift-detection`: Include ZCode snapshots in cross-agent drift
  and collision checks.

## Impact

- Agent identity unions, canonical parsing, probes, adapters, Runtime command
  validation, onboarding, migration, doctor, GUI chat, tests, and docs.
- No new runtime dependency. The implementation writes only documented ZCode
  JSON configuration and uses the published `zcode` executable when CLI
  execution is available.
- Existing Agent behavior and unmanaged ZCode state remain unchanged.
