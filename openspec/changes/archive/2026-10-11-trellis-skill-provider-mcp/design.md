# Design: Trellis MCP Runtime

## Architecture

```text
Agent
  │ one stdio / Unix socket / HTTP MCP edge
  ▼
TrellisMcpRuntime
  ├─ BuiltinRegistry
  │   ├─ SkillProvider
  │   ├─ RuntimeMemoryProvider
  │   │   └─ CanonicalMemoryProvider (read-only canonical Markdown)
  │   ├─ StatusProvider (future)
  │   └─ CapabilityProvider (future)
  │
  └─ UpstreamProvider
      └─ existing GatewayBackend / RemoteBackend
```

The runtime owns the MCP protocol edge. Providers own capabilities. Transport
and provider logic are separate so the same provider can run behind the
current per-agent stdio process or a future shared Unix-socket/HTTP service.

## Decisions

### D1 — General runtime, not a skill-specific MCP server

The public process becomes conceptually `trellis mcp-runtime --agent <id>`.
An alias may preserve `trellis skill-provider` during migration, but new
agent configuration should point at the runtime entry. Skill is a provider,
not the runtime itself.

### D2 — Providers use the MCP primitive that matches their control model

The runtime supports all three server primitives:

- Tools for model-controlled search and actions;
- Resources for application-managed context and file-like content;
- Prompts for user-selected templates, when a provider needs them.

The runtime must not force every provider into `tools/call`. It registers only
the capabilities a provider actually implements.

### D3 — Provider contract is transport-independent

```ts
interface TrellisProvider {
  id: string;
  listTools?(context: RuntimeContext): Promise<Tool[]>;
  callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult>;
  listResources?(context: RuntimeContext): Promise<Resource[]>;
  readResource?(uri: URL, context: RuntimeContext): Promise<ReadResourceResult>;
  listPrompts?(context: RuntimeContext): Promise<Prompt[]>;
  getPrompt?(name: string, args: unknown, context: RuntimeContext): Promise<GetPromptResult>;
  close?(): Promise<void>;
}
```

`RuntimeContext` carries the requesting `agentId`, canonical root, managed
scope, and provider-safe configuration. Providers never infer identity from
the current working directory.

### D4 — Existing GatewayBackend becomes an upstream provider adapter

`GatewayBackend` remains responsible for upstream MCP tool aggregation and
routing. The runtime wraps it as an `UpstreamProvider`; it does not copy the
connection, OAuth, timeout, or tool-prefix logic into the built-in registry.

Upstream tools use `<server>__<tool>` names. The current `GatewayBackend` is a
tool aggregation seam, so this change mounts upstream tools first. The runtime
contract already has independent resource/prompt handlers; upstream resources
and prompts require a backend that exposes those operations and remain a
follow-up extension rather than being silently dropped or emulated as tools.

### D5 — One runtime edge per agent, with direct/gateway compatibility

Native skill delivery remains the default. Runtime MCP delivery is additive:

- `native`: current filesystem projection;
- `mcp`: one runtime entry exposing built-in providers and selected upstreams;
- `both`: native projection plus the runtime entry.

When the existing gateway mode is active, the runtime can mount the same
selected upstream set and built-in providers. The agent still sees one MCP
entry; only the backend construction changes.

### D6 — SkillProvider is read-only and progressive

The first provider exposes:

- `trellis.skills.search(query, limit?)` — metadata only;
- `trellis.skills.read(name)` — `SKILL.md` content and provenance;
- `trellis.skills.read_file(name, relativePath)` — bounded supporting file;
- `trellis://skills/<name>/SKILL.md` resources where supported.

Search does not load every skill body. File reads reject absolute paths,
traversal, symlink escapes, secrets files, and oversized content.

### D7 — MemoryProvider is a provider seam, not a special-case skill path

The runtime's initial memory path is read-only and exposes
`trellis.memory.search`, `trellis.memory.read`, and
`trellis://memories/<name>.md` resources over canonical Markdown memory files.
`RuntimeMemoryProvider` adapts the storage-independent `MemoryProvider`
contract to MCP. `CanonicalMemoryProvider` is the default implementation; a
later local-graph or OpenViking implementation can replace it without changing
the MCP edge or agent-facing names. This change does not add an OpenViking
dependency or expose `remember`, delete, or canonical mutation tools.

Canonical configuration mutation and memory deletion are not exposed as model
tools in the first runtime.

### D8 — Every request is scope-checked

The runtime requires a supported `--agent` id. Each provider re-checks scope
on every request. A provider may not use the fact that it was spawned as a
substitute for the managed-agent boundary.

### D9 — Security and human control are explicit

Built-in providers never resolve or return secret values. SkillProvider never
executes scripts, installs dependencies, or fetches network content. Any future
memory write tool must carry explicit read/write semantics, audit information,
and rely on the host's user approval behavior.

Tool annotations are hints, not authorization. Provider policy remains the
source of truth.

## Risks

- A single runtime failure can remove both built-in and upstream MCP access.
  Mitigate with provider-level failure isolation and a native fallback mode.
- A large runtime tool catalog can increase context cost. Use progressive
  disclosure, namespaces, and provider-level search.
- The MCP protocol is evolving toward stateless HTTP and richer cache hints.
  Keep provider state outside transport sessions and avoid depending on
  handshake/session ids for memory identity.
- Exposing memory writes changes trust boundaries. Start with read-only
  providers and add write operations through a separate reviewed change.

## Open questions

- Whether the runtime entry should replace `trellis-gateway` immediately or
  coexist with it behind a compatibility alias.
- Whether an upstream resource/prompt-capable backend should be added in a
  follow-up change; the first runtime release deliberately mounts the existing
  tool-only GatewayBackend.
