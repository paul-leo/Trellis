# trellis-pi-mcp-bridge-p4

## Why

pi has no native MCP client at all (docs/research.md) — the only
`mcpServers` string in its bundle belongs to an unrelated Vertex tool-schema
translator that explicitly throws `"mcpServers parameter is not
supported"`. Every other agent gets MCP servers via a native-config adapter
(P2); pi needs the one adapter in this project that is genuine runtime
code, not config templating — a bridge extension that connects to each
configured MCP server itself and registers their tools through pi's own
extension API.

## What Changes

- `src/pi-bridge/index.ts`: an `ExtensionFactory` (pi's own extension
  entry-point shape, confirmed by reading the installed
  `@earendil-works/pi-coding-agent` package's unminified `dist/` tree, same
  technique P0's design.md D5 used) that, on load, reads
  `~/.trellis/mcp/servers.yaml`, opens an `@modelcontextprotocol/sdk`
  client per server (or one client to `hub.url` in hub mode), lists each
  server's tools, and registers a wrapped tool per (server, tool) pair via
  `pi.registerTool()`.
- `src/pi-bridge/schemaTranslate.ts`: pure, unit-testable translation —
  MCP's raw JSON Schema `inputSchema` wrapped via TypeBox's `Type.Unsafe`
  escape hatch (pi's `ToolDefinition.parameters` requires a TypeBox
  `TSchema`, not raw JSON Schema); MCP's `content` array (text/image/audio/
  resource/resource_link) mapped to pi's narrower `TextContent |
  ImageContent` union, degrading audio/resource to a text summary.
- `src/adapters/pi.ts` (extended): a new symlink kind delivers the bridge
  file itself — not a user-authored capability from `~/.trellis/`, but
  Trellis's own packaged code — into `~/.pi/agent/extensions/`, where pi's
  own directory-based auto-discovery picks it up with zero settings.json
  involvement (confirmed by reading `discoverAndLoadExtensions`'s actual
  source: `entry.isFile() || entry.isSymbolicLink()` at the file-recognition
  check, and a real, persistent directory scanned unconditionally on every
  startup — the same shape P1 already established for skills/instructions,
  reused here for a different kind of payload).

## Capabilities

- **New**: `pi-mcp-bridge` — pi gains access to every MCP server canonical
  defines (respecting scope and hub mode) via a single, symlinked bridge
  extension; no settings.json parsing/writing at all.

## Impact

Two new build-time (dev) dependencies, not CLI runtime ones:
`@modelcontextprotocol/sdk` (the bridge is the first piece of Trellis
that speaks the MCP protocol itself, rather than generating config for
another program to speak it) and `typebox` (pinned to `^1.3.0` to match
the version pi itself bundles). Neither is imported by Trellis's own CLI
runtime — only by `src/pi-bridge/*.ts`, which is bundled at build time
(`scripts/build-pi-bridge.mjs`, `esbuild`) into a single, dependency-free
`dist/pi-bridge/bundle.js`, the file the pi adapter actually symlinks.
This bundling is not a style preference: a symlinked file's own
bare-specifier imports resolve relative to the *symlink's path*, not its
target — confirmed empirically in the real sandbox (design.md D6) — so an
unbundled file could never resolve either package once placed in an
arbitrary user's `~/.pi/agent/extensions/`, regardless of what Trellis's
own `package.json` declared.
