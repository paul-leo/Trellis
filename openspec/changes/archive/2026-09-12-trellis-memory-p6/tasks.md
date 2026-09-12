## 1. Correct the record

- [x] 1.1 `docs/research.md`'s "Shared memory" section: reframed the
      "already running via mirasim" claim with the correct nuance —
      `DEFAULT_KNOWN_HOST_INJECTED` already lists `"memory"` as a real,
      empirically-found P0 result (mirasim's own runtime connector,
      invisible in static config by definition), so the claim likely
      *is* true and unconfirmable either way from
      `.claude.json`/`.codex/config.toml`/`~/.kiro/settings/mcp.json`.
      What static config *does* show: Kiro alone has an additional
      memory server, `totalrecallai` (SQLite + local embeddings +
      bundled viewer, AGPL-3.0, repo named `Auriti-Labs/kiro-memory`);
      Claude Code/Codex have none. Recorded as the evidence behind
      keeping `server-memory` as the documented default (design.md D1).
- [x] 1.2 `docs/architecture.md`: updated the memory bullet under
      "not owned/delegated" to reference the schema example and
      `totalrecallai`-class servers alongside mem0/OpenMemory as opt-in
      upgrades.

## 2. Schema example (design.md D3/D4)

- [x] 2.1 Added a `memory` entry to `schema/servers.example.yaml` using
      `@modelcontextprotocol/server-memory`, unscoped — **commented out**
      (design.md D4, found while writing this: the same file already
      lists `memory` under `known_host_injected`, so an active
      definition would self-collide) — with a comment explaining the two
      situations a reader may be in (host already injects `memory` at
      runtime vs. no such injection). Verified the file still parses
      correctly (`servers`/`known_host_injected` keys unaffected) via a
      direct `yaml.parse()` check.

## 3. Sandbox verification (no new code — proving the existing pipeline)

- [x] 3.1 Added a `memory` entry (the real
      `@modelcontextprotocol/server-memory` package name) to the sandbox
      fixture's `~/.trellis/mcp/servers.yaml`, unscoped — active, not
      commented out, since the sandbox fixture's own
      `known_host_injected` list only contains `sentry`, so no
      self-collision risk there.
- [x] 3.2 Ran `trellis mcp sync` in the real Docker sandbox. Confirmed
      via direct reads: `~/.claude.json`, `~/.codex/config.toml`, and
      `~/.kiro/settings/mcp.json` each gained a `memory` entry with
      `command: npx`, `args: ["-y", "@modelcontextprotocol/server-memory"]`
      — byte-identical shape across all three. Never actually spawned
      (`mcp sync` only writes config), so no real npm registry access was
      needed or attempted.
- [x] 3.3 Confirmed via a direct call to `resolveMcpPlan("pi", canonical.mcp)`
      against the fixture: `desired` includes `"memory"` alongside
      `sample-server`/`new-tool`, `conflicts` correctly excludes it (only
      `sentry` conflicts) — proving pi's bridge would register the
      memory server's tools with zero special-casing. `trellis mcp sync`
      itself correctly reports "pi — already in sync" for every run,
      since pi has no native MCP config file to write into at all (P4's
      design) — its access happens at the bridge's own runtime, not
      through this command's write path, so that report line is not a
      bug, just a different (correct) mechanism than the other three
      agents.
