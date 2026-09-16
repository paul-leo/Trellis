# mcp-gateway-hosting Specification

## Purpose
Trellis's own stdio MCP gateway: a locally-spawned process that
aggregates every in-scope canonical MCP server behind one native config
entry per agent, with zero plaintext secrets and correct, tested OAuth
for remote servers that need it. This capability exists so that
claude-code/codex/kiro can converge from N native server entries to one,
without Docker, without a resident daemon, and without the user ever
perceiving a gateway exists.

## Requirements

### Requirement: Gateway mode collapses every server to one native stdio entry per agent
The system SHALL, when a canonical server set's gateway mode is enabled
for an agent, write exactly one native stdio MCP entry to that agent's
config — `command` pointing at the `trellis mcp-gateway` subcommand,
carrying that agent's own id as an argument — instead of one entry per
server in `mcp.servers`, and SHALL NOT iterate `mcp.servers` at all when
producing that agent's plan items.

#### Scenario: Gateway mode produces one entry regardless of server count
- **WHEN** gateway mode is enabled for claude-code and `mcp.servers`
  defines five servers, three of them scoped to claude-code
- **THEN** `~/.claude.json` gains exactly one MCP entry, a stdio command
  pointing at `trellis mcp-gateway --agent claude-code`, not five
  separate entries

#### Scenario: Gateway mode is independent per agent
- **WHEN** gateway mode is enabled for claude-code only, and codex/kiro
  are left in direct (per-server) mode
- **THEN** claude-code's config gains the single gateway entry, while
  codex's and kiro's configs still receive one native entry per in-scope
  server, exactly as `mcp-server-sync` already does today

### Requirement: The gateway subcommand aggregates in-scope upstream servers behind a standard MCP Server
The system SHALL, on startup, resolve the same in-scope server set an
agent's direct-mode plan would have used (respecting each server's
inline `agents:` field, `enabled: false`, and the managed-agents list),
connect to each one, and expose the aggregate result through a standard
MCP `Server` using `ListToolsRequestSchema`/`CallToolRequestSchema`
handlers over `StdioServerTransport` — not a hand-rolled protocol
implementation.

#### Scenario: The gateway only aggregates servers in scope for the requesting agent
- **WHEN** `trellis mcp-gateway` is spawned by claude-code, and one
  canonical server is scoped to `agents: [codex]` only
- **THEN** that codex-only server is not connected to and its tools do
  not appear in the gateway's `tools/list` response to claude-code

#### Scenario: A disabled server is never connected to by the gateway
- **WHEN** a canonical server has `enabled: false`
- **THEN** the gateway subcommand does not attempt to connect to it,
  regardless of agent scope

### Requirement: Tools are aggregated with a server-name prefix and routed back to the correct upstream
The system SHALL expose every upstream tool under the name
`<server>__<tool>` in the gateway's `tools/list` response, and SHALL
route a `tools/call` request for `<server>__<tool>` to that exact
upstream connection's `<tool>` call, never to a different server's
same-named tool.

#### Scenario: Two upstream servers with same-named tools remain distinguishable
- **WHEN** two upstream servers, `alpha` and `beta`, each expose a tool
  named `search`
- **THEN** the gateway's `tools/list` response contains both
  `alpha__search` and `beta__search` as distinct entries

#### Scenario: A tool call is routed to its own upstream, not a same-named one elsewhere
- **WHEN** the gateway receives a `tools/call` request for `beta__search`
- **THEN** the call is forwarded to the `beta` upstream connection only,
  never to `alpha`

### Requirement: One upstream's connection failure does not affect any other upstream
The system SHALL log and skip an upstream server that fails to connect or
times out during the gateway's startup aggregation, and SHALL continue
serving every other upstream that connected successfully — a single
failing or slow upstream SHALL NOT prevent the gateway from starting or
from serving already-connected servers' tools.

#### Scenario: A crashed upstream is skipped, others remain available
- **WHEN** one of three configured upstream servers exits immediately on
  spawn
- **THEN** the gateway starts successfully and its `tools/list` response
  contains only the tools of the two upstreams that connected

#### Scenario: A slow upstream times out without blocking the others
- **WHEN** one upstream server does not respond to `initialize` within
  the gateway's connect timeout
- **THEN** that upstream is skipped and every other upstream's
  connection proceeds and completes independently

### Requirement: The gateway resolves secrets exclusively through the existing zero-plaintext mechanism
The system SHALL resolve every upstream server's `env`, `envAliases`,
`staticEnv`, and `headers` values inside the gateway subcommand through
the same `resolveSecretEnv`/`secrets.policy.yaml` mechanism
`mcp-server-sync` already uses, and SHALL NOT introduce any second path
by which a secret value could be written to disk, logged, or held in a
canonical file as a literal.

#### Scenario: An env-referenced secret is resolved at connect time, never written to disk
- **WHEN** an upstream server declares `env: [SOME_TOKEN]`
- **THEN** the gateway resolves `SOME_TOKEN`'s value through
  `resolveSecretEnv` immediately before spawning that upstream's process,
  and no file the gateway writes (including OAuth token storage) ever
  contains that resolved value

#### Scenario: An unresolvable env name is skipped like a failed connection, not silently connected with an empty value
- **WHEN** an upstream server declares `env: [SOME_VAR]` and `SOME_VAR`
  has no value in the resolved secrets source
- **THEN** the gateway does not connect to that upstream and logs the
  same class of failure as an unresolved-name conflict, while every
  other upstream still connects normally

### Requirement: OAuth credentials are stored one file per server, outside canonical, with restrictive permissions
The system SHALL persist OAuth tokens (access token, refresh token,
expiry, client ID) at `~/.trellis/mcp/oauth/<server-name>.json`, mode
`0600`, and SHALL NOT write any OAuth credential into `servers.yaml`,
any other canonical file, or the OS Keychain/credential manager.

#### Scenario: A server's OAuth token is stored in its own file
- **WHEN** `trellis mcp auth github-remote` completes successfully
- **THEN** `~/.trellis/mcp/oauth/github-remote.json` exists with mode
  `0600` and contains the access/refresh tokens and expiry; no other
  server's OAuth file is touched

#### Scenario: Canonical files never contain an OAuth credential
- **WHEN** any OAuth flow completes, for any server
- **THEN** `mcp/servers.yaml` is not modified and contains no token value
  anywhere in the resulting diff

### Requirement: First-time OAuth authorization is a manual, user-invoked command; the gateway never opens a browser
The system SHALL perform the authorization-code-plus-PKCE flow (metadata
discovery, dynamic client registration when available, PKCE challenge,
opening a browser, running a local callback listener, and exchanging the
resulting code for tokens) only inside `trellis mcp auth <server-name>`,
run explicitly by a human. The gateway subcommand itself SHALL NOT open
a browser, start a callback listener, or otherwise attempt an
interactive authorization flow under any circumstance.

#### Scenario: Running the auth command performs the full interactive flow
- **WHEN** a user runs `trellis mcp auth <server-name>` for a remote
  server with no stored token
- **THEN** the command discovers the server's OAuth metadata, registers
  a client if dynamic registration is available, generates a PKCE
  challenge, opens the user's browser at the authorization URL, receives
  the callback locally, exchanges the code for tokens, and persists the
  result

#### Scenario: The gateway subcommand never initiates authorization on its own
- **WHEN** the gateway subcommand starts and finds no stored OAuth token
  for a server that requires one
- **THEN** it skips connecting to that server (per the connection-failure
  requirement above) without opening a browser or blocking on user input

### Requirement: An expired OAuth token is refreshed silently, without user interaction
The system SHALL, when a stored OAuth token is expired or about to
expire, attempt a `refresh_token` grant automatically — inside the
gateway subcommand at connect time, or inside `trellis mcp auth` when
re-run — without requiring a browser, a callback listener, or any user
interaction, and SHALL persist the refreshed token back to that server's
OAuth file.

#### Scenario: The gateway silently refreshes an expired token before connecting
- **WHEN** the gateway subcommand starts and a server's stored OAuth
  token is past its expiry
- **THEN** the gateway performs a `refresh_token` grant, persists the
  new access token, and proceeds to connect using it — with no browser
  opened and no user prompt

#### Scenario: A refresh failure is treated as a connection failure, not a crash
- **WHEN** a `refresh_token` grant itself fails (e.g. the refresh token
  has also expired)
- **THEN** the gateway skips that upstream server per the
  connection-failure requirement, and does not open a browser to attempt
  re-authorization on its own

### Requirement: Gateway mode and hub mode are independent and mutually exclusive per resolution
The system SHALL treat the new gateway field and the existing `mcp.hub`
field as orthogonal settings that MAY both exist in canonical
simultaneously, but SHALL resolve at most one of them into an agent's
desired entries per sync run — gateway mode takes precedence over hub
mode when both apply to the same agent, and enabling or disabling one
SHALL NOT require the other to change.

#### Scenario: Enabling gateway mode does not require removing an existing hub setting
- **WHEN** `mcp.hub.url` is already set and gateway mode is then enabled
  for the same agent
- **THEN** `trellis mcp sync` writes the single gateway stdio entry for
  that agent, and no error or conflict is reported about `hub` still
  being set

#### Scenario: An agent left in hub mode is unaffected by another agent's gateway mode
- **WHEN** gateway mode is enabled for claude-code only, and codex is
  still resolving through `mcp.hub`
- **THEN** codex's config still receives the single `trellis-hub` entry
  exactly as the existing hub-mode requirement describes, unaffected by
  claude-code's gateway mode

### Requirement: Codex's headers limitation does not apply in gateway mode
The system SHALL NOT run Codex's bearer-token-header-shape check (the
existing `mcp-server-sync` requirement that refuses non-bearer-token
`headers` shapes for Codex) against any upstream server when Codex is in
gateway mode, since Codex no longer receives that server's `headers`
directly — the gateway, not Codex, holds and resolves them.

#### Scenario: A multi-header remote server causes no Codex conflict in gateway mode
- **WHEN** Codex is in gateway mode and an upstream server declares two
  custom headers (a shape that would be a Codex-only conflict in direct
  mode)
- **THEN** `trellis mcp sync` reports no Codex conflict for that server,
  and the gateway itself resolves and sends those headers to the
  upstream on Codex's behalf

### Requirement: The gateway terminates and releases every upstream when its client disconnects
The system SHALL detect end-of-input on its own stdin — the signal that
the agent that spawned it has closed the pipe — and SHALL, on that
signal, close every upstream MCP client, terminate every upstream child
process it started, and exit. It SHALL NOT rely on the MCP SDK's stdio
transport to report this, and SHALL perform the same teardown on
`SIGTERM`, `SIGINT`, and `SIGHUP`.

This requirement exists because neither layer below provides the
behavior: `StdioServerTransport` registers listeners only for `'data'`
and `'error'`, so EOF never reaches `onclose`; and POSIX re-parents an
orphan to `launchd` rather than killing it, while the gateway's own
event loop is held open by every upstream it connected. Without explicit
teardown, each agent session leaves a gateway and its entire upstream
set running forever.

#### Scenario: Closing the agent leaves no gateway or upstream process behind
- **WHEN** an agent that spawned the gateway exits, closing the pipe to
  the gateway's stdin
- **THEN** the gateway closes all upstream clients, terminates every
  upstream child process it spawned, and exits — leaving no process from
  that session running

#### Scenario: Repeated sessions do not accumulate processes
- **WHEN** an agent session is started and closed several times in
  sequence
- **THEN** the number of gateway and upstream processes after the last
  session ends is the same as before the first one started

### Requirement: A gateway entry name colliding with a host-injected server is reported, not silently written
The system SHALL, before writing the gateway entry into an agent's native
config, check that entry's name against `mcp.knownHostInjected` and
SHALL report a conflict instead of writing, exactly as the existing hub
branch already does for its own entry name.

#### Scenario: A host-injected server of the same name produces a conflict
- **WHEN** gateway mode is enabled for an agent and the gateway entry's
  name also appears in that agent's `known_host_injected` list
- **THEN** `trellis mcp sync` reports a name-collision conflict for that
  agent and writes no gateway entry, rather than silently shadowing the
  host-injected server

### Requirement: Concurrent OAuth refreshes for one server are serialized
The system SHALL hold an exclusive lock, scoped to a single server, for
the duration of a `refresh_token` grant and the write of its result, and
SHALL re-read that server's stored token after acquiring the lock so
that a refresh already completed by another holder is detected and not
repeated.

This applies regardless of which process initiates the refresh — a
gateway subcommand at connect time or `trellis mcp auth` run by hand —
because authorization servers commonly rotate the refresh token on each
grant and invalidate the previous one, making two concurrent refreshes
leave one party holding a credential that is already dead.

#### Scenario: Two concurrent refreshes result in exactly one grant
- **WHEN** two processes both find the same server's stored token
  expired at the same moment and both attempt a refresh
- **THEN** exactly one `refresh_token` grant is sent to the
  authorization server, and both processes end up using the single
  resulting valid token

#### Scenario: A refresh lock is not a connection dependency between servers
- **WHEN** one server's refresh is in progress and holding its lock
- **THEN** connecting to and refreshing any other server proceeds
  without waiting on that lock
