## 1. Canonical source: read mcp/servers.yaml

- [ ] 1.1 Extend `src/core/canonical.ts`'s `loadCanonicalSource()` to parse
      `~/.trellis/mcp/servers.yaml` (via the existing `yaml` dependency)
      into `CanonicalSource.mcp` — `servers`, `knownHostInjected`, `hub`.
      Missing file → the existing empty placeholder, not an error.
- [ ] 1.2 Unit test: a populated `servers.yaml` produces the matching
      `McpServerDef` entries, `knownHostInjected` list, and `hub` config.
- [ ] 1.3 Unit test: a missing `servers.yaml` yields the empty placeholder,
      not a thrown error.

## 2. `src/lib/tomlSection.ts` — Codex's write mechanism (design.md D3)

No TOML library — a purpose-built line-based section locator/splicer.
This is the highest-risk file in the change; test it accordingly.

- [ ] 2.1 `findSection(content: string, header: string): { start: number; end: number } | null` —
      locates `[header]`'s exact line range (start = header line, end =
      last line before the next top-level `[`/`[[` or EOF), operating on
      line indices, not byte offsets, for simplicity and testability.
- [ ] 2.2 `renderServerSection(name: string, def: McpServerDef): string` —
      renders a `[mcp_servers.<name>]` block for a stdio or http def.
      Bounded, known shape only — not general TOML serialization.
- [ ] 2.3 `upsertSection(content, name, def): string` — replaces the
      section if `findSection` finds one, else appends (with a leading
      blank line) at EOF. Never touches any line outside the located span.
- [ ] 2.4 `removeSection(content, name): string` — deletes the section
      (and its immediately preceding blank line, if any) if found; no-op
      if not found.
- [ ] 2.5 Unit test: comments and unrelated tables outside the target
      section survive `upsertSection`/`removeSection` byte-for-byte
      (specs/mcp-server-sync's core requirement — test this directly,
      don't just assert the target section's own content).
- [ ] 2.6 Unit test: `upsertSection` on a file with no existing section
      for that name appends correctly without disturbing existing content.
- [ ] 2.7 Unit test: `removeSection` on a file with no matching section is
      a no-op (idempotent).
- [ ] 2.8 Unit test: a section defined via multi-line array formatting for
      an *unrelated* table doesn't confuse the next-`[`-line boundary
      detection for the section actually being edited (design.md's risk
      note — construct this fixture deliberately, don't assume it away).

## 3. Adapters — MCP additions

- [ ] 3.1 `src/adapters/codex.ts` (extended): `plan()`/`apply()` for MCP
      using `tomlSection.ts`; read-side detection via `codex mcp list
      --json` (reuse P0's probe, not a new TOML read).
- [ ] 3.2 `src/adapters/claude-code.ts` / `kiro.ts` (extended): JSON
      parse → merge under `mcpServers` → stringify (design.md D4);
      every sibling top-level key preserved untouched.
- [ ] 3.3 Every adapter's MCP `plan()` filters via each server's inline
      `agents:` field (not `scope.yaml` — `isInScope` still applies, just
      reading a different field per docs/architecture.md).
- [ ] 3.4 Collision check: refuse (as a `"conflict"` plan item, consistent
      with P1's D6) any server name in `known_host_injected`; Codex's
      conflict message quotes `url is not supported for stdio`.
- [ ] 3.5 Pre-write secrets guard (design.md D5): refuse (as a
      `"conflict"` item) any resolved value matching the hardcoded
      dangerous-pattern list.
- [ ] 3.6 Hub mode: when `canonical.mcp.hub` is set, every adapter's
      `plan()` short-circuits to a single `trellis-hub`-named entry
      (design.md D6); collision check runs against that one name only.

## 4. `trellis mcp sync` command and CLI wiring

- [ ] 4.1 `src/commands/mcp.ts`: `runMcpSync(opts: { json?: boolean;
      homeDir?: string })` — same shape as `src/commands/sync.ts`, reused
      pattern (probe → plan → apply → report), `homeDir` injectable for
      tests/sandbox, never a CLI flag.
- [ ] 4.2 Wire `trellis mcp sync` into `src/cli.ts` (the existing `mcp`
      stub case only handles this one subcommand for now — no other `mcp`
      subcommands are in scope for this change).

## 5. Sandbox fixtures and acceptance verification (sandbox only)

**Same rule as P1: every test in this group runs only against a scratch
`$HOME` or `scripts/sandbox.sh`, never this developer's real dotfiles.**

- [ ] 5.1 Add `test/fixtures/home/.trellis/mcp/servers.yaml` — 2-3
      servers: one unscoped, one scoped to one agent, one whose name
      collides with the fixture's existing `known_host_injected` list
      (reuse the `sentry`-class collision fixture already established for
      P0's doctor tests).
- [ ] 5.2 Reproduce the exact Codex incident in a sandboxed `config.toml`:
      a stdio server statically defined, then attempt to add a same-name
      collision against `known_host_injected` — confirm the collision
      check refuses the write *before* attempting it.
- [ ] 5.3 Point at a scratch `$HOME`, run `trellis mcp sync`, confirm each
      in-scope agent's native config gains the right entries and every
      pre-existing sibling key/setting in each config file is untouched.
- [ ] 5.4 Delete a server from canonical, re-run `trellis mcp sync`,
      confirm it's removed from every agent it had reached, and confirm
      (via a direct file read, not just `trellis doctor`) that surrounding
      content is untouched.
- [ ] 5.5 Set `mcp.hub.url` in the fixture's `servers.yaml`, run `trellis
      mcp sync`, confirm each in-scope agent's config contains exactly one
      `trellis-hub` entry regardless of how many servers are defined.
- [ ] 5.6 Construct a value that would resolve to a literal secret pattern
      and confirm the pre-write guard refuses it rather than writing it.
