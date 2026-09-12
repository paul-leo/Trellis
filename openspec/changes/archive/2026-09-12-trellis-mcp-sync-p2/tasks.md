## 1. Canonical source: read mcp/servers.yaml

- [x] 1.1 `src/core/canonical.ts`'s `loadServersYaml()` parses
      `~/.trellis/mcp/servers.yaml` into `CanonicalSource.mcp`. Missing
      file → empty placeholder, not an error.
- [x] 1.2 `test/unit/canonical.test.ts`: populated `servers.yaml` → matching
      servers/knownHostInjected/hub.
- [x] 1.3 `test/unit/canonical.test.ts`: missing `servers.yaml` → empty,
      valid config, not a thrown error.

## 2. `src/lib/tomlSection.ts` — Codex's write mechanism (design.md D3)

- [x] 2.1 `findSection` — line-range locator.
- [x] 2.2 `renderServerSection` — bounded stdio/http block renderer.
- [x] 2.3 `upsertSection` — replace-in-place or append at EOF.
- [x] 2.4 `removeSection` — delete section + one preceding blank line.
- [x] 2.5 `test/unit/tomlSection.test.ts`: byte-for-byte survival of
      unrelated content across upsert/remove.
- [x] 2.6 Covered: append-when-absent test.
- [x] 2.7 Covered: no-op-when-absent test.
- [x] 2.8 Covered: nested-array-continuation-line regression test.
- [x] Found via the real sandbox run (not anticipated by any unit test
      until added retroactively): a comment block immediately preceding
      the *next* `[header]` was being swallowed into the *previous*
      section's range, so an update to that previous section would have
      silently deleted a comment documenting an unrelated section. Fixed
      by trimming trailing comment-only lines (not just blank ones) from
      `findSection`'s `end` boundary. Regression test added reproducing
      the exact sandbox fixture shape (`sample-server` immediately
      followed by a comment block introducing `sentry`).

## 3. Adapters — MCP additions

**No automatic removal (design.md D7): `plan()` only ever produces
`"create"` and `"conflict"` items for MCP — verified in
`test/unit/mcp.test.ts`'s "deleting a server from canonical leaves its
entry in place" test and again live in the sandbox.**

- [x] 3.1 `src/adapters/mcpPlan.ts` — `resolveMcpPlan()`, hub-mode
      collapse, collision + literal-secret conflicts. Tested in
      `test/unit/mcpPlan.test.ts` (8 tests).
- [x] 3.2 `src/adapters/codex.ts` — TOML section compare/upsert. Found and
      fixed a real bug while wiring this in: MCP planning was nested
      inside the "no `instructions` key configured" early-return, so a
      Codex install without `instructions` set would silently skip MCP
      entirely — moved `planMcp()` above that branch, unrelated concerns.
- [x] 3.3 `src/adapters/claude-code.ts` / `kiro.ts` — JSON parse/deep-equal/
      merge via shared `src/adapters/jsonMcp.ts`. Tested in
      `test/unit/jsonMcp.test.ts` (8 tests).
- [x] 3.4 Scope filtering via inline `agents:` — inside `mcpPlan.ts`,
      shared once; tested directly in `mcpPlan.test.ts` and end-to-end in
      `mcp.test.ts`'s "scoped to one agent" test.

## 4. `trellis mcp sync` command and CLI wiring

- [x] 4.1 `src/commands/mcp.ts`: `runMcpSync`/`collectMcpSyncReport`, same
      probe→plan→apply→report shape as `sync.ts`, `homeDir` injectable.
      Also fixed a cross-contamination bug found while wiring this:
      `sync.ts`'s `collectSyncReport` was passing every adapter's full
      `plan()` output (now including "mcp" items) straight through when
      no `target` filter was given, meaning bare `trellis sync` would
      have also silently written MCP config. Fixed by having `sync.ts`
      unconditionally exclude `kind === "mcp"` — MCP is `trellis mcp
      sync`'s own command, never folded into bare `sync`. Regression test
      added in `test/unit/sync.test.ts`.
- [x] 4.2 Wired into `src/cli.ts`'s `mcp` case (`mcp sync` only; any other
      `mcp` subcommand errors with usage).

## 5. Sandbox fixtures and acceptance verification (sandbox only)

- [x] 5.1 `test/fixtures/home/.trellis/mcp/servers.yaml` — four servers:
      `sample-server` (already correct everywhere, proves idempotency
      against real files), `new-tool` (unscoped create), `claude-only-tool`
      (scoped to claude-code only), `sentry` (collides with
      `known_host_injected`, and with the pre-existing hand-placed
      `[mcp_servers.sentry]` fixture in `.codex/config.toml`).
- [x] 5.2 Confirmed live in the sandbox: `sentry` refused as a conflict on
      every MCP-capable agent, never attempted as a write, before any
      other item's apply — see run output below.
- [x] 5.3 Ran `scripts/sandbox.sh ... mcp sync` against the fixture home.
      Verified byte-for-byte via direct file reads: `.codex/config.toml`'s
      `model`/`instructions` lines, the untouched `sample-server` section,
      and the untouched `sentry` section (including its introducing
      comment block — the bug found in task group 2) all survived
      unchanged; `new-tool` was appended correctly. `.claude.json` and
      `.kiro/settings/mcp.json` gained `new-tool` (+ `claude-only-tool` for
      claude-code only), `sample-server` unchanged, `sentry` never written.
- [x] 5.4 Covered in `test/unit/mcp.test.ts` (scratch `$HOME`, matching
      P1's own precedent for this exact kind of check): deleting a server
      from canonical and re-running leaves its entry in place, no
      `"remove"` item ever appears, unrelated entries untouched.
- [x] 5.5 Covered in `test/unit/mcp.test.ts`: hub mode collapses every
      server into exactly one `trellis-hub` entry per agent.
- [x] 5.6 Covered in `test/unit/mcp.test.ts` and live in the sandbox's own
      `sentry` fixture name-collision path (design.md D5's guard also has
      a dedicated literal-secret-pattern unit test independent of the
      name-collision path).
