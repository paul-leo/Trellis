## 1. Core types and resolution plumbing

- [x] 1.1 Add `enabled?: boolean` and `staticEnv?: Record<string, string>`
      to `McpServerDef` (src/core/types.ts)
- [x] 1.2 `resolveMcpPlan` (src/adapters/mcpPlan.ts): gain a required
      fourth `policy: SecretsPolicy` parameter
- [x] 1.3 `resolveMcpPlan`: skip any server with `enabled: false` before
      scope/collision/secret checks — no `desired` entry, no conflict
- [x] 1.4 `resolveMcpPlan`: extend `findLiteralSecret` to also scan
      `Object.values(def.staticEnv ?? {})`
- [x] 1.5 `resolveMcpPlan`: for every name-only `env` entry on a server
      about to be written, resolve via `resolveSecretEnv([...names],
      policy)`; any name resolving to `undefined` becomes a new
      `unresolved-env-value` conflict scoped to that server for that
      agent only

## 2. Codex TOML rendering

- [x] 2.1 `tomlSection.ts`: `renderServerSection` emits a second,
      adjacent `[mcp_servers.<name>.env]` table when `def.staticEnv` is
      set, with literal `key = "value"` lines
- [x] 2.2 `tomlSection.ts`: extend `findSection`/`currentServerSectionText`
      to treat an immediately-following `[<header>.env]` table as part of
      the same logical server entry when present
- [x] 2.3 `tomlSection.ts`: `upsertSection`/`removeSection` create,
      repair, and remove the two-table pair atomically
- [x] 2.4 Fixture tests: adjacent nested table with blank-line and
      trailing-comment variants, mirroring the existing single-table
      edge cases already covered

## 3. JSON rendering (Claude Code / Kiro)

- [x] 3.1 `jsonMcp.ts`: `renderJsonServerEntry`'s `entry.env` merges
      name-reference entries (`${VAR}`) with `staticEnv` entries in the
      same map

## 4. Call-site updates for the new `resolveMcpPlan` signature

- [x] 4.1 `src/adapters/codex.ts`: pass `policy` through
- [x] 4.2 `src/adapters/claude-code.ts`: pass `policy` through
- [x] 4.3 `src/adapters/kiro.ts`: pass `policy` through (both call
      sites — `planMcp` and `desiredApprovedEnvVars`)
- [x] 4.4 `src/adapters/jsonMcp.ts`'s `planJsonMcp`: accept and forward
      `policy`
- [x] 4.5 (found during implementation, not in original scope)
      `src/pi-bridge/index.ts`'s own `resolveMcpPlan` call site also
      needed `policy` — same signature change applies everywhere

## 5. Schema and documentation fixes

- [x] 5.1 Remove the dead `auth: oauth` line from
      `schema/servers.example.yaml`'s `figma` example
- [x] 5.2 Document `enabled` and `static_env` (the YAML surface key —
      `staticEnv` internally, translated in `loadServersYaml` like every
      other multi-word key across `.trellis/*.yaml`) in
      `schema/servers.example.yaml`, matching the `tanka`/`supabase-db`
      shapes found on this machine
- [x] 5.3 Update `docs/getting-started.md`'s `trellis mcp sync` section
      and `README.md`'s Status/Known-limitations for the new behaviors
- [x] 5.4 Add a `docs/roadmap.md` entry now that it's implemented and
      sandbox-verified

## 6. Open question to resolve during implementation

- [x] 6.1 Check pi's actual settings/bridge schema for whether
      `staticEnv` has any meaning there; scope pi support accordingly
      (support it, or explicitly document why it's a no-op for pi) —
      **resolved: pi's bridge (`connectStdio` in src/pi-bridge/index.ts`)
      builds the spawned server's env directly, so `staticEnv` merges in
      there too, same as the other three agents' rendering**

## 7. Tests

- [x] 7.1 Unit tests for `enabled: false` (skip write, no conflict,
      re-enable writes normally)
- [x] 7.2 Unit tests for `staticEnv` rendering on all three adapters
      (codex TOML two-table, Claude Code JSON, Kiro JSON — Kiro shares
      `jsonMcp.ts`'s renderer with Claude Code, same test covers both)
- [x] 7.3 Unit tests for the credential-pattern scan now covering
      `staticEnv` values
- [x] 7.4 Unit tests for the unresolved-env-value conflict: one failing
      name blocks only its own server, other servers/agents unaffected
- [x] 7.5 Real-machine verification: reproduced this machine's actual
      `tanka` (staticEnv) and `supabase-db` (`enabled: false`) shapes in
      `test/fixtures/home/.trellis/mcp/servers.yaml`, ran both
      `mcp sync --dry-run` and a real `mcp sync` **inside
      `scripts/sandbox.sh`** (never against the real machine). Confirmed:
      `supabase-db` produces no write and no conflict on any agent;
      Codex's written `[mcp_servers.tanka]` + `[mcp_servers.tanka.env]`
      pair matches this machine's real, working config byte-for-byte;
      Claude Code's JSON entry merges the literal values into `env`
      correctly. Also found and fixed a real regression this change would
      have caused: the sandbox's own pre-existing fixture servers
      (`sample-server`, `remote-bearer`, `remote-multi-header`) declare
      `env` names that don't resolve inside the container — the new
      pre-write check would have refused all of them. Fixed by exporting
      their fixture values in `docker/entrypoint.sh`, matching what a
      real working setup would actually have.
