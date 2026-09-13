## 1. Schema

- [x] 1.1 Add `envAliases?: Record<string, string>` to `McpServerDef`
      (`src/core/types.ts`) — target key → source variable name.
      Document the self-referencing-vs-aliased split precisely, matching
      `env`'s and `staticEnv`'s existing doc-comment style.

## 2. Read path (migrate-in classification)

- [x] 2.1 In `src/lib/mcpMigrateRead.ts`'s `splitJsonEnvMap`, drop the
      `match[1] === key` restriction: any `${NAME}` value is a
      reference. Self-referencing (`match[1] === key`) still goes into
      `env`; otherwise into a new `envAliases` result field.
- [x] 2.2 Extend `Pick<McpServerDef, "env" | "staticEnv">`'s return type
      to include `envAliases`, and thread it through
      `fromRichJsonServerDef` (claude-code/kiro path).
- [x] 2.3 Apply the same classification change to the Codex TOML path
      (`buildCodexMcpReadResult`'s `readServerEnvTable`-sourced
      static_env handling) — same rule, same split.

## 3. Write path

- [x] 3.1 `src/adapters/jsonMcp.ts`'s `renderJsonServerEntry`: merge
      `envAliases` entries as `{ [targetKey]: "${sourceName}" }` into
      the same `env` object `env`'s own name-refs already populate
      (before `staticEnv` merges in, same ordering).
- [x] 3.2 `src/lib/tomlSection.ts`'s `renderServerSection`: merge
      `envAliases` entries into the same `[mcp_servers.<name>.env]`
      literal table `staticEnv` already writes to, as
      `targetKey = "${sourceName}"`.
- [x] 3.3 `src/commands/mcp.ts` (or wherever the pre-write "unresolvable
      env name" refusal guard currently lives): extend it to also
      resolve every `envAliases` source name, refusing that one server
      for that one agent (naming the unresolved *source* name, not the
      target key) if any fails to resolve — same posture as `env`'s
      existing guard, not a parallel differently-behaved one.
      (Found in `src/adapters/mcpPlan.ts`'s `findUnresolvedEnvName`.)

## 3b. Canonical on-disk round-trip (found while implementing task 5, not
      originally listed — `upsertServerYaml`/`loadCanonicalSource` are the
      exact bridge `migrate --only mcp` uses to persist a read entry into
      `servers.yaml` and read it back for `mcp sync`/pi-bridge; without
      this, an `envAliases` entry would never survive a real migrate run)

- [x] 3b.1 `src/core/canonical.ts`: `McpServerDefYaml`/`fromServerDefYaml`/
      `toServerDefYaml` extended to translate `env_aliases` (snake_case
      on disk) <-> `envAliases` (camelCase in memory), same treatment as
      `static_env`/`staticEnv`.

## 4. pi-bridge runtime resolution

- [x] 4.1 `src/pi-bridge/index.ts`: resolve every `envAliases` source
      name via `resolveSecretEnv` (same call/merge point as `def.env`'s
      existing resolution), then merge `{ [targetKey]: resolved[sourceName]
      }` for each alias entry — before `staticEnv`'s literal merge,
      after `env`'s resolved merge (same relative ordering already
      documented there).

## 5. Tests

- [x] 5.1 `test/unit/mcpMigrateRead.test.ts`: a differently-named
      `${NAME}` value migrates into `envAliases`, not `staticEnv`; a
      same-name reference still migrates into `env`, unchanged; a
      genuinely literal value still migrates into `staticEnv`,
      unchanged. Cover both the claude-code/kiro JSON path and the Codex
      TOML path.
- [x] 5.2 `test/unit/jsonMcp.test.ts` / `test/unit/tomlSection.test.ts`:
      `renderJsonServerEntry` and `renderServerSection` each render an
      `envAliases` entry correctly, alongside existing `env`/`staticEnv`
      entries in the same server.
- [x] 5.3 A test for the pre-write refusal guard: an unresolvable
      `envAliases` source name refuses that one server, naming the
      source name, without blocking other servers/agents.
      (`test/unit/mcpPlan.test.ts`.)
- [x] 5.4 `test/unit/piBridge.test.ts`: an `envAliases` entry resolves
      through `resolveSecretEnv` and is delivered to the spawned
      subprocess under the target key — real resolved value, never the
      literal placeholder text. This same test doubles as 5.5's
      round-trip regression (real notion shape, real subprocess, real
      resolved value delivered under the target key).
- [x] 5.5 (folded into 5.4, plus `test/unit/canonical.test.ts`'s new
      `env_aliases`/`envAliases` round-trip tests covering the
      migrate-write/canonical-read half of the same path.)

## 6. Docs and this real machine's own broken data

- [x] 6.1 `docs/getting-started.md` / `docs/research.md` "Secrets"
      section: document `envAliases` alongside `env`/`staticEnv`.
      (Also `schema/servers.example.yaml`, which both docs point readers
      to for the full picture.)
- [x] 6.2 `docs/roadmap.md`: new entry, same style as prior phases,
      naming this as a real bug found via live dogfooding (notion on
      pi), not a hypothetical.
- [ ] 6.3 Note (do not silently auto-fix): this real machine's own
      `~/.trellis/mcp/servers.yaml` still has the broken
      `staticEnv: { OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}"
      }` entry from before this fix — re-running `migrate --only mcp`
      from claude-code after this ships will correctly re-classify it,
      but that re-migrate is a separate, explicit action for the user to
      run, not part of this change's own tasks.
