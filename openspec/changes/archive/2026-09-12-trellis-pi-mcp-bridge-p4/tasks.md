## 1. Dependencies

- [x] 1.1 Added `@modelcontextprotocol/sdk` and `typebox` (pinned to
      `^1.3.0`, matching the version pi itself bundles — confirmed by
      reading pi's own `node_modules/typebox/package.json`) as
      **devDependencies** — revised from an initial "runtime dependency"
      plan once bundling (task 3, below) made clear neither is ever
      imported by Trellis's own CLI runtime.

## 2. `src/pi-bridge/schemaTranslate.ts` — pure translation logic

- [x] 2.1 `toParametersSchema` — wraps a raw MCP JSON Schema via
      `Type.Unsafe` (design.md D4).
- [x] 2.2 `toPiContent` — text/image pass through; audio/resource/
      resource_link degrade to a `TextContent` summary (design.md D3).
- [x] 2.3 `bridgedToolName` — `${serverName}__${toolName}` (design.md D5).
- [x] 2.4 `test/unit/schemaTranslate.test.ts` (7 tests): schema wrapping
      preserves the input object (verified against `Type.Unsafe`'s actual
      runtime shape — its `~unsafe` marker is non-enumerable, confirmed
      empirically before writing the assertion); every MCP content kind
      maps correctly including degrade-not-drop; distinct names across
      two servers.

## 3. `src/pi-bridge/index.ts` — the extension entry, and its bundling

- [x] 3.1 `ExtensionFactory` (duck-typed against pi's API, no dependency
      on `@earendil-works/pi-coding-agent` itself) that loads canonical
      mcp config, reuses `src/adapters/mcpPlan.ts`'s `resolveMcpPlan` for
      scope/hub resolution (not reimplemented), opens one
      `StdioClientTransport` per stdio server (env: `getDefaultEnvironment()`
      merged with the named vars from `process.env`) or one
      `StreamableHTTPClientTransport` for an http-transport def (covers
      both hub mode and a directly-configured http server), lists tools,
      registers each via `pi.registerTool()`.
- [x] 3.2 A server that fails to connect, or fails `tools/list`, is caught
      and logged per-server — `Promise.all` over independent per-server
      try/catch blocks, so one bad server never prevents another's tools
      from registering.
- [x] 3.3 (Added — not in the original plan, found necessary via the real
      sandbox, design.md D6) `scripts/build-pi-bridge.mjs`: bundles
      `src/pi-bridge/index.ts` and every third-party import into one
      dependency-free `dist/pi-bridge/bundle.js` via `esbuild`
      (`packages: "bundle"`). Wired into `npm run build`. Verified via
      `grep "^import "` on the output: only `node:*` specifiers remain.

## 4. `src/adapters/pi.ts` — bridge symlink delivery (design.md D1/D2/D6)

- [x] 4.1 Extended `AdapterPlanItem.kind` with `"extension"`
      (`src/core/adapter.ts`); widened `planSymlinks`'s own `kind` param
      to match (`src/adapters/symlinkPlan.ts`).
- [x] 4.2 `resolveBridgeFile()`: always resolves to
      `<repo-root>/dist/pi-bridge/bundle.js` via
      `fileURLToPath(import.meta.url)` relative to the currently executing
      module — correct from both `src/adapters/pi.ts` (dev, tsx) and
      `dist/adapters/pi.js` (published), since both sit exactly two
      directories below the repo root. Always the bundled `.js` output,
      never raw `.ts` source, in dev too (design.md D6 — found this was
      required, not optional, via the real sandbox).
- [x] 4.3 Wired into `plan()` (existing `apply()`/`applySymlinkPlan`
      needed no change — it's kind-agnostic, already generic over any
      symlink-shaped plan item).
- [x] 4.4 `test/unit/piAdapter.test.ts` (2 tests): the bridge symlink is
      created pointing at the real bridge file and actually lands on
      disk; re-running is idempotent (no second create item).

## 5. Sandbox acceptance verification (sandbox only — genuine runtime code)

**No live LLM call was spent — matching this project's established
avoidance (P0 already flagged `pi -p` triggers a real model API call).**

- [x] 5.1 Extended `test/fixtures/sample-mcp-server.js` (shared with P0-P3)
      to also handle `tools/list` (one trivial "echo" tool) and
      `tools/call` — purely additive, every existing caller only ever
      sent `initialize`. The existing `sample-server`/`new-tool` entries
      in the P2 sandbox fixture's `mcp/servers.yaml` already point at this
      script and are unscoped (reachable by pi too); `sentry` is already
      a `known_host_injected` collision, exercising the same
      collision-exclusion path for pi as for every other agent.
- [x] 5.2 Ran `trellis sync` in a real Docker container
      (`scripts/sandbox.sh`) and confirmed the bridge symlink lands in
      `~/.pi/agent/extensions/` pointing at `dist/pi-bridge/bundle.js`.
- [x] 5.3 Built a dedicated `docker/pi-sandbox.Dockerfile` (deliberately
      NOT merged into the shared `sandbox.Dockerfile` — installing the
      real pi binary would slow down every other phase's sandbox builds
      for a dependency only this one adapter needs) with the real
      `@earendil-works/pi-coding-agent` installed. First run (raw,
      unbundled `src/pi-bridge/index.ts` symlink) failed exactly as
      design.md D6 describes: `Cannot find module
      '@modelcontextprotocol/sdk/client/index.js'`. After fixing via
      bundling (task 3.3/4.2), re-ran with zero model credentials
      configured: `pi -p "hello"` proceeded past extension loading with
      no `"Failed to load extension"` diagnostic, reaching pi's own
      unrelated `"No API key found for the selected model"` failure —
      proof the bridge loaded and called `pi.registerTool()` without
      throwing, without ever reaching a real model call.
