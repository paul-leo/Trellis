## Context

`docs/implementation-plan.md`'s original P4 sketch already correctly
identified the shape (an extension using `@modelcontextprotocol/sdk`
stdio clients + `registerTool`), but left the exact API unconfirmed. This
document records what was verified directly against the installed
`@earendil-works/pi-coding-agent` package's unminified `dist/` tree (same
technique as P0's D5) before writing any bridge code, per this project's
established practice.

Stakeholder: single developer (project owner), same as P0-P3.

## Goals / Non-Goals

**Goals:**
- pi gains access to every MCP server canonical defines (respecting scope
  and hub mode), sourced from the same `mcp/servers.yaml` every other
  agent reads.
- Zero settings.json involvement — delivery is a single symlink, reusing
  the same create/repair/remove machinery P1 already built, not a new
  write path into a JSON file.
- The pure translation logic (JSON Schema → TypeBox, MCP content → pi
  content, tool naming) is unit-testable without a live pi session or a
  live MCP server.

**Non-Goals:**
- pi's skills/instructions adapter — already P1's job
  (`src/adapters/pi.ts`'s existing symlink logic), untouched here.
- A generic "install any Trellis extension" mechanism — this bridge is
  the only extension Trellis ships; building a plugin system for
  hypothetical future extensions is exactly the kind of speculative scope
  this project has consistently avoided.
- Perfect fidelity for every MCP content type. Audio and resource/
  resource_link content are degraded to a text summary (D3) — no incident
  or concrete need justifies building full support for content types pi
  has no native representation for.
- Live, interactive verification against a real LLM turn. Confirming the
  bridge *loads* and *registers tools* without erroring is this change's
  acceptance bar (D4); confirming an LLM actually *calls* a bridged tool
  correctly needs a real model call this project has consistently avoided
  spending in its own acceptance passes (P0 already flagged `pi -p`
  triggers a real API call).

## Decisions

### D1 — Delivery is a symlink into `~/.pi/agent/extensions/`, not a settings.json entry

Read directly from `dist/core/extensions/loader.js`'s
`discoverAndLoadExtensions()`: pi scans `agentDir/extensions/`
unconditionally on every startup (step 2, alongside a project-local
`extensions/` dir and any explicit `--extension`/settings-configured
paths), and `discoverExtensionsInDir()`'s file-recognition check is
`entry.isFile() || entry.isSymbolicLink()` — a symlink to a `.ts`/`.js`
file dropped directly in that directory is picked up with no further
configuration. This means the bridge needs no settings.json parsing or
writing at all; it reuses `src/adapters/symlinkPlan.ts` almost verbatim,
the same infrastructure P1 built for skills/instructions — just pointed
at a file Trellis itself ships instead of one the user authored under
`~/.trellis/`.

### D2 — The symlink target is resolved via `import.meta.url`, not `~/.trellis/`

Skills/instructions symlink from the *user's* canonical source; the
bridge extension is *Trellis's own packaged code*, shipped once per
install. Its source location is computed relative to the currently
executing adapter module's own file
(`fileURLToPath(import.meta.url)`), preserving whichever extension (`.ts`
in a dev checkout run via `tsx`, `.js` in a published install — `tsconfig.json`'s
`rootDir: "src"` / `outDir: "dist"` mirrors `src/pi-bridge/` to
`dist/pi-bridge/` 1:1) the currently-running file itself has, rather than
guessing dev vs. published from any other signal.

This resolution choice has a consequence for dependencies: Node's ESM
resolution follows a symlink's *realpath* when resolving *that target
file's own* bare-specifier imports (documented Node behavior, not
jiti-specific). Once `~/.pi/agent/extensions/trellis-mcp-bridge.js` is a
symlink into Trellis's own install directory, `import { Type } from
"typebox"` inside it resolves node_modules lookup starting from
*Trellis's* directory tree, not pi's — so Trellis needs its own `typebox`
dependency (pinned to the version pi itself bundles) for this to resolve
correctly regardless of which pi version happens to be installed on a
given machine. See proposal.md Impact.

### D3 — MCP content types collapse to pi's `TextContent | ImageContent`

Read directly from `@earendil-works/pi-agent-core`'s `types.d.ts`:
`AgentToolResult<T>.content` is exactly `(TextContent | ImageContent)[]`,
where `TextContent = {type:"text", text}` and `ImageContent =
{type:"image", data, mimeType}` — a strict subset of MCP's own five
content kinds (text, image, audio, resource, resource_link). Audio and
resource/resource_link content are mapped to a `TextContent` summarizing
what was omitted (audio's mimeType; a resource's uri) rather than
dropped silently — no MCP server this project actually configures
returns audio or resource content today (see `schema/servers.example.yaml`),
so building full fidelity for those shapes now would be speculative;
degrading visibly, not dropping silently, is the cheap, honest middle
ground.

### D4 — TypeBox schema translation uses `Type.Unsafe`, not a JSON-Schema-to-TypeBox transformer

`ToolDefinition.parameters` requires a TypeBox `TSchema`
(`ToolDefinition<TParams extends TSchema>`), but MCP tools declare a
plain JSON Schema `inputSchema`. Read directly from the `typebox`
package pi itself bundles (`node_modules/typebox/build/type/types/unsafe.d.mts`):
`Type.Unsafe<Type>(schema: TSchema): TUnsafe<Type>` is the library's own
documented escape hatch for embedding an arbitrary schema object without
TypeBox attempting to structurally validate or transform it — exactly
what's needed here, since the schema was already authored (by the MCP
server) as valid JSON Schema and doesn't need TypeBox's own builder
semantics applied to it. No JSON-Schema-to-TypeBox conversion library is
needed or would even be safe to introduce here: it would risk silently
rejecting a valid MCP tool schema TypeBox's builder vocabulary doesn't
happen to cover, for no benefit over embedding it as-is.

### D5 — Tool names are namespaced `<server>__<tool>`

Two different MCP servers can expose a tool with the same name (e.g. both
declare `search`). `pi.registerTool()` operates on a single flat
namespace across every registered tool, so every bridged tool is
registered as `${serverName}__${toolName}` — deterministic, collision-free
across servers, and still legible to the LLM (the label/description
carry the human-readable name; only the callable identifier is
namespaced).

### D6 — The delivered file is a bundled, dependency-free build output, never the raw TypeScript source

Found empirically in the real sandbox, not anticipated by D1/D2 above:
symlinking `src/pi-bridge/index.ts` directly and running a real `pi -p`
invocation against it failed with `Cannot find module
'@modelcontextprotocol/sdk/client/index.js'`, its require-stack rooted at
the *symlink's own path* (`~/.pi/agent/extensions/trellis-mcp-bridge.ts`),
not at the file's realpath inside Trellis's install directory. This is
the reverse of what D2 originally assumed (that Node's ESM loader follows
a symlink's realpath when resolving *that file's own* bare specifiers) —
whatever loader pi's jiti-based extension loading actually uses resolves
relative to the path the file was *referenced by*, not its target. Since
an arbitrary user's `~/.pi/agent/extensions/` has no `node_modules`
ancestor at all, no dependency declared in Trellis's own `package.json`
could ever make this resolve, regardless of version pinning.

Fix: `scripts/build-pi-bridge.mjs` bundles `src/pi-bridge/index.ts` and
every third-party import it pulls in (`@modelcontextprotocol/sdk`,
`typebox`, transitively `yaml` via `core/canonical.ts`) into one
self-contained `dist/pi-bridge/bundle.js` with `esbuild` (`packages:
"bundle"`, i.e. nothing external except Node's own builtins, which
resolve correctly regardless of a file's location). `src/adapters/pi.ts`
symlinks *that* file, always — including in a dev checkout — not
`src/pi-bridge/index.ts` directly; `npm run build` runs this bundling
step alongside `tsc`. Confirmed via `grep "^import "` on the bundle
output: only `node:*` specifiers remain. Re-verified live in the sandbox
afterward: the same `pi -p` invocation no longer reports "Failed to load
extension," proceeding instead to pi's own unrelated "no API key found"
failure (see Non-Goals — never a real model call).

`@modelcontextprotocol/sdk` and `typebox` moved from `dependencies` to
`devDependencies` as a consequence: Trellis's own CLI runtime never
imports either package directly (only `src/pi-bridge/*.ts` does, as
bundling input), so a real `agent-trellis` CLI install has no need for
either at its own runtime — a smaller install for the common case (using
Trellis without pi at all).

## Risks / Trade-offs

- **A misbehaving or slow-to-start MCP server delays pi's own startup**,
  since tool registration happens during extension load. Accepted for
  this change — the same trade-off already exists for every other agent
  today (a stdio server that hangs on startup is a pre-existing MCP
  ecosystem problem, not something introduced here); a startup-timeout
  budget per server is a reasonable follow-up, not blocking this change.
- **`Type.Unsafe` means pi never validates a bridged tool's arguments
  against its declared schema before calling `execute()`** — the MCP
  server itself is the final arbiter of its own tool's inputs anyway
  (via its own `tools/call` handling), so this is not a new gap, just one
  layer of client-side pre-validation this bridge doesn't add on top of
  what already exists.

## Migration Plan

None — new adapter capability, opt-in by nature of `mcp/servers.yaml`
existing or not. A machine with pi installed but no canonical MCP servers
configured sees zero behavior change (an empty server list means the
bridge registers zero tools and exits its load function immediately).

## Open Questions

None blocking. A startup-timeout budget per server (see Risks) is a named
follow-up, not resolved here.
