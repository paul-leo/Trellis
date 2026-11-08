# Proposal

## Why

MCP secret values currently resolve through one of two channels, both fragile: ambient `process.env` (depends on the host process having been launched from a shell that exported the values) or `secrets.policy.yaml`'s `env_file` (a plaintext dotenv file the policy itself warns against). On the machine that seeded this change the situation is already broken: global secret governance moved every value into the encrypted `~/.mxenv/.env` (mxenv), `servers.local.env` was deleted, and `secrets.policy.yaml` still points `env_file` at the deleted file — so `resolveSecretEnv` resolves every name to `undefined` and the next `mcp sync` pre-check would refuse `MINIMAX_API_KEY`. The values themselves already live in a governed, encrypted store with an SDK; Trellis should compose from it instead of demanding a second plaintext copy or lucky ambient state.

## What Changes

- `env` entries and `envAliases` source values accept **`mxenv://<profile>/<KEY>` references** alongside bare names. A reference resolves through the `@morphixai/mxenv-core` SDK (`loadConfigLayers` + `composeEnvironment`) at the consumption point and is delivered to the spawned server under the `KEY` segment. Bare names keep today's exact semantics (sole-source `env_file` when set, otherwise ambient `process.env`).
- `resolveSecretEnv` becomes async (composition is async by nature) and returns values keyed by **delivered name** (the `KEY` segment for references, the entry itself for bare names). Every consumer (pi bridge, `resolveMcpPlan` pre-check, `trellis secrets audit`, OAuth/workspace helpers) keeps calling the one shared resolver.
- `trellis secrets audit` and the `resolveMcpPlan` pre-check validate references the same way they validate names: unresolvable → finding/conflict, never a silent pass.
- mxenv's reference machinery (`packages/mxenv-core/src/refs.ts`: parser + `ReferenceResolver`) is part of the `@morphixai/mxenv-core` public SDK exports (0.12.0 起，Wave A 三包发布已带出) so the syntax has one owner; Trellis consumes it rather than re-implementing the grammar.
- Operational: this machine's `secrets.policy.yaml` drops the dangling `env_file` pointer and the `minimax` server entry moves to the reference form (`env: ["mxenv://legacy/MINIMAX_API_KEY"]`).

## Capabilities

### New Capabilities
（无。）

### Modified Capabilities
- `secret-env-resolution`: resolver becomes async and reference-aware; new requirement defining `mxenv://` reference shape, delivered-name derivation, and SDK-based resolution (env_file/ambient semantics for bare names unchanged).
- `pi-mcp-bridge`: bridge injects reference-resolved values under delivered names, through the same shared resolver.
- `secrets-audit`: audit collects and validates reference entries alongside bare names and `${VAR}` header references.

## Impact

- `src/lib/secretEnv.ts` (async resolver + reference parsing + delivered names), `src/adapters/mcpPlan.ts`, `src/lib/mcpConnect.ts`, `src/lib/workspaceDoctor.ts`, `src/lib/oauth/store.ts`, `src/commands/secretsAudit.ts`, `src/commands/mcpAuth.ts`, `src/core/types.ts` (`McpServerDef` entry semantics), `src/pi-bridge/*` — mechanical `await`/name-derivation updates at existing call sites.
- New dependency: `@morphixai/mxenv-core` (^0.12.0 for the exported reference API).
- Docs: `schema/servers.example.yaml` + `schema/secrets.policy.example.yaml` reference-form documentation; README wording.
- No change to how native-client agents (Claude Code/Codex/Kiro) resolve `${VAR}` in their own processes — that path remains name-based and is covered by mxenv's terminal injection/shims.
