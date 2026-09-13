# pi-mcp-bridge Specification

## Purpose
TBD - created by archiving change trellis-pi-mcp-bridge-p4. Update Purpose after archive.
## Requirements
### Requirement: The bridge extension is delivered as a symlink, never a settings.json write
`trellis sync` (pi's adapter) SHALL deliver the MCP bridge extension by
symlinking Trellis's own bundled bridge output
(`dist/pi-bridge/bundle.js` — never the raw `src/pi-bridge/index.ts`
source) into `~/.pi/agent/extensions/`, reusing the same create/repair/
remove symlink semantics established for skills and instructions. It
SHALL NOT read or write `~/.pi/agent/settings.json`'s `extensions` field.

#### Scenario: The symlink targets the bundled output, not raw source
- **WHEN** `trellis sync` plans the bridge symlink
- **THEN** its link target is `dist/pi-bridge/bundle.js`, a single file
  with no unresolved third-party bare-specifier imports (only Node
  builtins) — a symlinked file's own imports resolve relative to the
  symlink's path, not its target, so raw source with external
  dependencies could never load once placed in an arbitrary user's home
  directory (design.md D6)

#### Scenario: First sync creates the bridge symlink
- **WHEN** pi is present and `~/.pi/agent/extensions/` does not yet
  contain a Trellis-managed bridge entry
- **THEN** `trellis sync` creates a symlink there pointing at Trellis's
  own bridge file, and `~/.pi/agent/settings.json` is left byte-for-byte
  unchanged

#### Scenario: A wrong-target bridge symlink is repaired
- **WHEN** the bridge symlink exists but points somewhere other than
  Trellis's current bridge file (e.g. after a Trellis upgrade moved it)
- **THEN** `trellis sync` repoints it, the same repair semantics already
  used for skill/instructions symlinks

#### Scenario: A real file occupying the bridge symlink's path is a conflict, not an overwrite
- **WHEN** a real (non-symlink) file already exists at the bridge
  symlink's target path
- **THEN** `trellis sync` reports a conflict and leaves it untouched,
  never deleting content it cannot prove it created

### Requirement: The bridge registers one namespaced tool per MCP tool, scoped and hub-aware
On load, the bridge extension SHALL read canonical `mcp` configuration,
connect to each server in scope for pi (or the single hub endpoint when
`mcp.hub` is set), list each server's tools, and register each one via
`pi.registerTool()` under the name `<server>__<tool>` to avoid cross-server
name collisions.

#### Scenario: An unscoped server's tools are all registered
- **WHEN** a server has no `agents` restriction and reports two tools
- **THEN** the bridge registers both, named `<server>__<tool1>` and
  `<server>__<tool2>`

#### Scenario: A server scoped away from pi contributes no tools
- **WHEN** a server's `agents` field is set and does not include `"pi"`
- **THEN** the bridge never connects to that server and registers none
  of its tools

#### Scenario: Hub mode collapses to tools from the single hub endpoint
- **WHEN** `mcp.hub.url` is set
- **THEN** the bridge connects to exactly that one endpoint (never the
  individual server definitions) and registers whatever tools it reports

### Requirement: MCP tool schemas and results are translated to pi's own shapes
The bridge SHALL wrap each MCP tool's raw JSON Schema `inputSchema` as a
TypeBox `TSchema` via `Type.Unsafe` (never a JSON-Schema-to-TypeBox
conversion), and SHALL translate each `tools/call` result's content items
into pi's `TextContent | ImageContent` union, degrading any other content
kind (audio, resource, resource_link) to a text summary rather than
dropping it silently.

#### Scenario: A JSON Schema input schema round-trips into a usable pi parameter schema
- **WHEN** an MCP tool declares an `inputSchema` with `properties` and
  `required`
- **THEN** the registered pi tool's `parameters` schema is that same
  schema, unmodified, wrapped for TypeBox's type system

#### Scenario: Text and image content pass through unchanged
- **WHEN** a tool call result contains `text` and `image` content items
- **THEN** the pi tool result's `content` array contains the equivalent
  `TextContent`/`ImageContent` entries with the same text/data/mimeType

#### Scenario: Audio or resource content is degraded to a text summary, not dropped
- **WHEN** a tool call result contains an `audio` or `resource`/
  `resource_link` content item
- **THEN** the pi tool result's `content` array contains a `TextContent`
  entry describing what was omitted (e.g. the resource's URI), and the
  original content item is never silently discarded without a trace

### Requirement: The bridge resolves declared env values through the shared resolver, never raw ambient process.env directly

When connecting to a stdio MCP server, the bridge SHALL obtain each
declared `env` name's value, and each declared `envAliases` entry's
source-name value, via `resolveSecretEnv` (from `secret-env-resolution`)
rather than reading `process.env` inline — never merging an
`envAliases` value as a raw, unresolved literal the way `staticEnv` is
merged. This makes the bridge's own credential exposure controllable by
`secrets.policy.yaml`'s `env_file`, instead of unconditionally
inheriting everything the parent `pi` process's environment happens to
contain, and closes the gap where a differently-named reference
(misclassified before this change existed) would otherwise reach the
spawned server as an unexpanded literal placeholder string.

#### Scenario: With no env_file set, behavior is unchanged from before this requirement existed
- **WHEN** `secrets.policy.yaml` has no `env_file` field
- **THEN** the bridge's stdio connection still receives each declared
  name's value from `process.env`, identical to pre-existing behavior

#### Scenario: With env_file set, only that file's values reach the spawned server
- **WHEN** `secrets.policy.yaml` sets `env_file` to a path containing
  the values a server's declared `env` names need
- **THEN** the spawned MCP server subprocess receives those values, and
  the bridge never reads the parent `pi` process's own `process.env` for
  those names

#### Scenario: An envAliases entry is resolved by its source name and delivered under its target key
- **WHEN** a canonical server declares `envAliases: { OPENAPI_MCP_HEADERS:
  NOTION_OPENAPI_MCP_HEADERS }` and `NOTION_OPENAPI_MCP_HEADERS` has a
  real value in the resolved secrets source
- **THEN** the spawned MCP server subprocess receives that real value
  under the env var name `OPENAPI_MCP_HEADERS` — never the literal text
  `${NOTION_OPENAPI_MCP_HEADERS}`

### Requirement: The bridge passes resolved headers into remote connections

The bridge SHALL resolve an `http`/`sse`-transport server's `headers`
field values (each a `${VAR}` reference) via `resolveSecretEnv`
(trellis-secrets-env-management) and pass the resolved map as
`requestInit.headers` when connecting.

#### Scenario: A resolved header reaches the remote server's request
- **WHEN** a canonical `http`-transport server declares
  `headers: { Authorization: "Bearer ${TOKEN}" }` and `TOKEN` resolves to
  a real value
- **THEN** the bridge's connection to that server includes an
  `Authorization: Bearer <value>` header on its requests

### Requirement: sse-transport servers connect via a dedicated SSE client

The bridge SHALL connect an `sse`-transport server using the MCP SDK's
`SSEClientTransport`, not `StreamableHTTPClientTransport`, with the same
resolved-headers handling as the `http` path.

#### Scenario: An sse-transport server is registered the same way as an http one
- **WHEN** a canonical server has `transport: "sse"`
- **THEN** the bridge connects via `SSEClientTransport` and registers its
  tools identically to how an `http`-transport server's tools are
  registered

### Requirement: A hanging server's connect attempt cannot stall the bridge or block other servers

Each of `connectStdio`/`connectHttp`/`connectSse` SHALL bound its
`client.connect()` call with a fixed timeout (10 seconds). A server
whose connection neither resolves nor rejects within that window SHALL
be treated identically to one whose `connect()` call rejected outright:
logged and skipped, with every other configured server's connection and
tool registration proceeding unaffected.

#### Scenario: A server that never answers the initialize handshake is skipped, not fatal
- **WHEN** a stdio server's process stays alive but never writes a
  response to its `initialize` request
- **THEN** the bridge logs a connection failure for that server after
  the timeout elapses, and does not register any tools for it

#### Scenario: One server timing out does not prevent another server's tools from registering
- **WHEN** one configured server hangs on connect and a second,
  independent server connects and responds normally
- **THEN** the second server's tools are registered exactly as if the
  first server were not configured at all

#### Scenario: `listTools()` hanging after a successful connect is treated the same way
- **WHEN** a server answers `initialize` successfully but its
  `tools/list` response never arrives
- **THEN** the bridge logs a failure for that server after the timeout
  elapses, closes its client connection, and registers no tools for it,
  without affecting any other server

