# Architecture

This document is for contributors and anyone evaluating Trellis's internals
— how adapters are built, why they're built the way they are, and the
testing discipline behind that. If you just want to *use* Trellis, see
[`docs/getting-started.md`](getting-started.md) instead; nothing below is
required reading for that.

## Layers and who owns each one

```
┌─────────────────────────────────────────────────────────┐
│  Trellis canonical source  (~/.trellis — global only, see  │
│  "Global vs. workspace scope" below)                        │
│  instructions · skills · agents · mcp/servers.yaml ·      │
│  memories · secrets policy                                 │
└───────────────┬─────────────────────────────────────────┘
                │  trellis sync / trellis doctor
        ┌───────┼────────┬─────────────┬──────────────┐
        ▼                ▼             ▼              ▼
   Claude Code         Codex          Kiro            pi          Kimi Code
  (symlink adapter) (incremental   (symlink adapter) (bridge
                     TOML writer)                    extension)
```

Trellis owns exactly one thing: **the canonical source, and the generators
that turn it into each agent's native format.** It does not own MCP
transport, memory storage, or secret storage — those are delegated (see
[`research.md`](research.md)).

## Canonical schema

Aligned to the `.agents Protocol` draft, extended where the draft is silent:

```
.trellis/
├── agents.md                # instructions, AGENTS.md-compatible
├── skills/<name>/SKILL.md   # exact filename required — see research.md
├── agents/<name>.md         # subagent profiles (Claude-format frontmatter
│                             # today; this is the layer with no cross-agent
│                             # equivalent yet — Codex has no persistent
│                             # subagent concept, see research.md)
├── mcp/servers.yaml          # single MCP source, values are var-name
│                             # references only, never literals
├── memories/*.md             # shared memory entries (server-memory backed)
├── scope.yaml                 # exceptions to "shared with all agents" —
│                             # see "Private / agent-specific capabilities"
└── secrets.policy.yaml       # which var names are allowed, nothing else

# Not user-authored, so not shown in the tree above — Trellis's own
# bookkeeping, written/read only by `trellis mcp sync` itself:
#   mcp/ownership.json  # what Trellis last wrote per (agent, server name) —
#                       # the ownership marker MCP removal needed
#                       # (docs/roadmap.md P14, src/lib/mcpOwnership.ts)
```

## Global vs. workspace scope

**Global only, for now.** Trellis manages `~/.trellis` — one canonical
source per machine, applied to that machine's four agents. It does not yet
read or merge a project-local `.trellis/` in a specific repo.

The `.agents Protocol` draft (see `research.md`) describes a two-layer
merge — global defaults, workspace overrides on top, closest wins. That
model is a reasonable target eventually, but it's explicitly **out of
scope until a later phase**: it adds real complexity (merge precedence,
per-project drift, a second place secrets policy has to be checked) that
isn't justified before the single-layer global case is solid. Don't build
workspace resolution ahead of that decision — if you find yourself adding
a `root?: string` parameter or precedence logic to `loadCanonicalSource`,
that's scope creep against this section, not a natural extension.

## Private / agent-specific capabilities

Not everything belongs to all four agents. A skill built around Claude
Code's Task-based subagent delegation has no equivalent to delegate to on
Codex; an MCP server might only make sense for one agent's workflow. Every
scopable item — skill, subagent profile, memory entry, MCP server —
defaults to "shared with all four," and can be restricted with an explicit
`scope` (skills/agents/memories) or inline `agents:` (MCP servers, see
below). Restriction is the exception you declare, not something you
configure for the common case.

**Skills, subagent profiles, and memory entries declare scope in
`.trellis/scope.yaml`, never inside the artifact file itself.** This
isn't a style preference: Codex validates `SKILL.md` frontmatter against
an allow-list of recognized keys and rejects files with unknown ones (see
`research.md`) — a Trellis-only `scope:` field written into a skill's own
frontmatter would break that skill specifically on Codex. Keeping scope
declarations in a separate manifest means every artifact stays a clean,
portable file exactly as its target agent's own spec expects; Trellis's
own bookkeeping lives next to it, not inside it. See
`schema/scope.example.yaml`.

**MCP servers are the one exception** — `agents:` is declared inline per
server in `mcp/servers.yaml` (see `schema/servers.example.yaml`), because
that file is Trellis's own format and is never handed to an agent
directly; every adapter translates it into that agent's native shape, so
there's no risk of an agent choking on an unrecognized field the way Codex
does with SKILL.md.

Every `TrellisAdapter.plan()` implementation must filter the canonical
source through scope before producing any plan item for it — an item
scoped away from that adapter's agent must never appear in its plan at
all. See `src/core/adapter.ts`'s `isInScope` helper and the obligation
documented on `plan()` itself.

## Adapter contract

Every adapter must implement:

- `probe()` — does this agent exist on this machine, what version
- `plan(canonical)` — diffs canonical against this agent's current on-disk
  state (read-only, but it does read — create/remove/no-op/conflict can't
  be decided from canonical alone) and produces `AdapterPlanItem[]`, each
  tagged `"create"`, `"remove"`, or `"conflict"`. **Must emit `"remove"`
  items**, not just `"create"`: a Trellis-managed symlink (realpath
  resolves inside the canonical source) whose entry was deleted from
  canonical or scoped away from this agent is stale and belongs in the
  plan — see `src/core/adapter.ts`'s `plan()` doc. A real, non-symlink path
  occupying a spot Trellis would otherwise touch is a `"conflict"` item,
  not a thrown error — it must show up in the same report as everything
  else, not abort the whole run over one unrelated item.
- `apply(plan)` — perform the diff; must be idempotent and re-runnable for
  "create"/"remove", and must treat "conflict" as report-only (no I/O,
  never throws) — see `src/core/adapter.ts`'s `apply()` doc for why this
  responsibility sits with the caller (`trellis sync`), not per-item
- `verify()` — re-read the agent's own state and confirm it matches
  canonical; this is what `trellis doctor` calls

No adapter is allowed to overwrite fields it doesn't own. Codex's adapter in
particular must never rewrite `config.toml` wholesale — it must locate the
target `[mcp_servers.<name>]` section and patch only that block, because
Codex's own `config.toml` also holds mirasim-independent user settings
(models, trust levels) that Trellis has no business touching.

### Adapter-specific notes

**Claude Code** — `~/.claude/skills`, `~/.claude/agents` become symlinks into
the canonical source. `~/.claude.json`'s `mcpServers` is patched in place
(JSON, so this is a simple merge). Values are always `${VAR}` references.
When `mcp.hub` is set, this becomes one entry (the hub URL) instead of N.

**Codex** — skills via `~/.agents/skills` symlink (Codex's own built-in
convention, requires no Trellis-specific path). MCP via `codex mcp add`
where possible; for env passthrough use `env_vars`, never `--env` with a
literal secret value. Must check for name collisions against any host-
injected servers (mirasim connectors) before writing — see research.md §3.
When `mcp.hub` is set, only the single hub entry needs this check — there's
nothing else defined locally for it to collide with.

**Kiro** — same shape as Claude Code: `~/.kiro/skills` symlink,
`~/.kiro/steering/CLAUDE.md` symlink, `~/.kiro/settings/mcp.json` patched
like Claude's. Same hub-mode simplification applies.

**pi** — same symlink shape as Claude Code/Kiro after all: `~/.pi/agent/skills`
symlink, instructions symlinked to whichever of `AGENTS.override.md` /
`AGENTS.md` / `CLAUDE.md` pi checks first (`~/.pi/agent/`, confirmed by
direct source read — see `openspec/specs/agent-state-probing/spec.md`'s pi
scenario). Pi *reads* these natively without any Trellis-specific parsing,
but the files still have to physically exist at that path — nothing
populates `~/.pi/agent/skills` on its own. (This corrects an earlier,
pre-P0 assumption that pi needed "no adapter" for skills/instructions;
that was written before pi's actual global discovery directory was
confirmed, when it wasn't yet known whether canonical skills would ever
reach it without one.) MCP is the one place pi is genuinely different: it
needs a real bridge either way, but which shape depends on `mcp.hub`:
without it, the bridge extension opens N `@modelcontextprotocol/sdk` stdio
clients (one per server) and registers each one's tools through pi's
`registerTool` API; with `mcp.hub` set, it opens exactly one HTTP client to
the hub instead — meaningfully less code and one fewer class of failure
(N processes to keep alive vs. one connection). This is the one piece of
the project that is an agent runtime extension, not a config generator,
regardless of hub mode.

The pi bridge symlink follows the currently executing Trellis installation.
When switching from a checkout to a global package (or between installation
roots), sync can repair an outside-root link only if its target ends in
`dist/pi-bridge/bundle.js` and its bytes match the current bridge bundle.
The repair is backed up, including the old symlink target. Modified, unrelated,
or dangling outside-root links remain conflicts; this exception applies only
to the bridge extension, not to Skill or instruction symlinks.

## MCP hub mode

For onboarding, the short rule is: **Gateway is the recommended local
Trellis mode; Hub is for an already-running external service**. Gateway is a
local stdio subprocess that Trellis starts for the Agent session. Hub is an
HTTP endpoint operated outside this process; Trellis only writes the URL and
does not deploy, configure, or health-manage that Hub.

Every agent's MCP surface can be either N direct server definitions
(default) or one static entry pointing at a single HTTP endpoint — `mcp.hub.url`
in `mcp/servers.yaml` is the field, but the supported way to set it is
`trellis onboard --mcp-mode hub --hub-url <url>` (trellis-onboard-mcp-mode),
not hand-editing the file: onboard's own writer clears any conflicting
`gateway` block for you and is the same command that later turns hub mode
back off again (`--mcp-mode direct`). `schema/servers.example.yaml` still
documents the raw field shape for reference. Nothing about *what* runs behind that URL
is part of Trellis's design: a self-hosted
[mcp-hub](https://github.com/ravitemer/mcp-hub) instance, a hosted
mcp-router account, anything else speaking MCP over HTTP all look
identical to every adapter — a URL. There is deliberately no "engine"
switch in the type (`HubConfig` is just `{ url: string }`) or in adapter
code — building one was tried and reverted as unneeded complexity for a
distinction (self-hosted vs. hosted, generated-config vs.
externally-managed) that only matters to the human choosing a hub, never
to the code writing one entry that points at it.

**What actually changes when `hub` is set:**
- Every adapter writes ONE entry instead of N. This is most of the value:
  adding a new backend server means editing wherever the hub's own config
  lives (this project doesn't prescribe that either) and never touching
  any of the four agents' configs or restarting them, if the hub supports
  live reload (mcp-hub does, via SSE).
- The collision check against `known_host_injected` (docs/research.md
  §"Codex — three hard constraints") shrinks to checking one name instead
  of N, since there's nothing else locally defined to collide with.
- pi's bridge (P4) becomes one HTTP client instead of N stdio clients.

**What doesn't change:** the boundary with mirasim (docs/research.md §3)
is unaffected — `mcp.hub`, self-hosted or not, only ever carries the
servers Trellis's own `servers.yaml` defines (local stdio, per that
boundary); mirasim's remote-OAuth connectors are injected at the agent's
own process level regardless of whether hub mode is on.

**The trade-off, stated plainly:** self-hosting a hub (or paying for a
hosted one) adds a moving part that direct mode doesn't have — if it's
down, every agent loses MCP capability at once, not just one server. And
if you point at a hub you manage outside Trellis (rather than one Trellis
generates config for), that hub's own dashboard/config becomes a second
place "what servers exist" is defined, outside `.trellis/` — this project
hit that exact problem first-hand with a token going stale across three
different values before `mcp.hub` existed as a concept (docs/research.md).
Direct mode remains fully supported for anyone who'd rather not take that
trade.

## Static header auth vs. real OAuth for remote MCP servers

A remote (`http`/`sse`-transport) MCP server needing a credential comes
in two real shapes, and Trellis only ever builds for one of them.

**Static header auth** (a bearer token or API key that doesn't expire on
its own) is exactly like `env` for stdio servers: `McpServerDef.headers`
holds `${VAR}` references, never a value, and each adapter renders it
through its own real, verified schema — Claude Code and Kiro accept the
identical plain `Record<string,string>` map; Codex has no generic
headers concept at all, only a single purpose-built
`bearer_token_env_var` field (confirmed by what `codex mcp add
--bearer-token-env-var` itself generates) — a server needing more than
one header simply can't reach Codex through Trellis, and is refused
there (not silently dropped) while still reaching every other agent.

**Real OAuth** (browser redirect, short-lived access token, refresh
token) was, for most of this project's life, deliberately not built:
all three native-config agents already have their own working flow —
Claude Code's `claude mcp add --client-id/--client-secret/--callback-port`,
Codex's `codex mcp login`/`logout` pair, Kiro's `oauth`/`oauthScopes`
fields — and pi, whose bridge is Trellis's own code, simply couldn't
reach such a server at all.

That changed with gateway mode (below), which made it unavoidable: in
gateway mode the agent connects to Trellis, and Trellis connects to the
remote server, so the agent's own OAuth flow is no longer on the path.
Trellis now implements the client half itself — discovery (RFC 8414 /
RFC 9728), dynamic client registration (RFC 7591), authorization code
with PKCE S256 (RFC 7636), and the refresh grant — in `src/lib/oauth/`.

Two rules shape it, both from the constraint that the gateway is spawned
silently by an agent with no terminal attached:

- **Only `trellis mcp auth <server>` ever opens a browser.** It is run by
  a human, once. The gateway never initiates an interactive flow under
  any circumstance; a server with no stored credential is skipped the
  same way an unreachable one is.
- **Refreshing is silent, and serialized by a lock.** A `refresh_token`
  grant needs neither a browser nor a callback, so the gateway does it
  at connect time. The lock (`~/.trellis/mcp/oauth/<name>.lock`) exists
  because most authorization servers rotate the refresh token and
  invalidate its predecessor — two concurrent refreshes would leave one
  party holding a credential that is already dead.

Tokens live one-file-per-server at `~/.trellis/mcp/oauth/<name>.json`,
mode 0600, never in `servers.yaml` and never in the OS keychain (macOS's
`security add-generic-password` fails with exit 152/154 in exactly the
non-interactive, no-GUI-session context the gateway runs in — measured,
not assumed).

In direct mode nothing here applies: each agent keeps using its own
native OAuth flow, exactly as before.

## MCP gateway mode

Gateway mode collapses an agent's MCP config to one entry, like hub mode
— but what sits behind it is a local subprocess Trellis owns
(`trellis mcp-gateway --agent <id>`), not a URL someone operates. Turn it
on with `trellis onboard --mcp-mode gateway` (optionally
`--gateway-agents <ids>` to narrow it to specific agents instead of every
managed agent); `trellis onboard --mcp-mode direct` turns it back off.
The underlying fields (`mcp.gateway.enabled`/`.agents` in
`mcp/servers.yaml`) are what onboard's writer sets — hand-editing them is
unsupported now that a real command exists for it
(trellis-onboard-mcp-mode). Selecting `hub` instead always clears
`gateway`, and vice versa (a mode selector, not two independently
toggleable fields) — see "MCP hub mode" above for why onboard treats them
as one mutually-exclusive choice rather than exposing the field-level
"both set, gateway wins" flexibility `resolveMcpPlan` itself still
tolerates for anyone who reaches this state some other way.

**Lifecycle: there isn't one.** The agent spawns it like any other stdio
MCP server and it exits when the session ends. No daemon, no
start/stop/status command, nothing to monitor. Two things make that
true rather than aspirational:

- The gateway watches its own stdin for EOF and tears everything down.
  The MCP SDK's `StdioServerTransport` binds only `'data'` and
  `'error'`, so it never reports EOF, and POSIX re-parents orphans to
  launchd rather than killing them — without explicit teardown every
  session would leak a gateway plus its whole upstream set, forever.
- Upstream failures are isolated. One server that is unreachable,
  misconfigured, or permanently hanging is logged and skipped; every
  other server's tools are still served.

**What it does:** resolves the same in-scope server set direct mode
would have written for that agent (same `resolveMcpPlan`, so per-server
`agents:` scope, `enabled: false`, host-injected collisions,
literal-secret refusals and unresolved `env` names all behave
identically), connects each one, and exposes their tools as
`<server>__<tool>`. Secrets resolve through `resolveSecretEnv` exactly as
in direct mode — the gateway introduces no second path by which a value
could reach disk.

**What it changes for the agents:** Codex's single-`bearer_token_env_var`
limitation stops applying, because Codex no longer receives any server's
`headers` — the gateway holds them. Remote servers needing real OAuth
become reachable from every agent, including pi, for the same reason.

**The seam.** `src/commands/mcpGateway.ts` depends on a `GatewayBackend`
interface and nothing below it — never a connection, transport, or
server definition. Today the only implementation connects upstreams
in-process, one gateway per agent session. The confirmed direction is a
single shared service holding one connection set for all agents, with
the per-session process becoming a thin client forwarding over a Unix
socket, speaking MCP itself (so no second protocol to own). That is a
substitution at one construction site: the entry written into each
agent's config is identical either way, so converging later requires no
re-sync and nothing the user notices.

## MCP Runtime direction

Gateway mode is the first consumer of a broader runtime shape. The runtime
edge is available as `trellis mcp-runtime --agent <id>`. Existing
`trellis mcp-gateway --agent <id>` entries are a compatibility alias and now
use the same provider registry. Both edges can expose Trellis-owned
capabilities and selected upstream MCP capabilities:

```text
Agent
  │ one MCP connection
  ▼
Trellis MCP Runtime
  ├─ BuiltinRegistry
  │   ├─ SkillProvider   (read/search canonical skills)
  │   ├─ RuntimeMemoryProvider
  │   │   └─ CanonicalMemoryProvider (read-only canonical Markdown)
  │   └─ StatusProvider  (future read-only diagnostics)
  └─ UpstreamProvider
      └─ existing GatewayBackend / future RemoteBackend
```

The runtime is a protocol edge; providers are the capability boundary. A
provider may expose tools, resources, prompts, or a combination. The current
`GatewayBackend` remains the upstream tool aggregation implementation and is
mounted as an `UpstreamProvider`, so connection, OAuth, timeout, namespace,
and cleanup logic stay in one place.

Native skills remain the default delivery. Runtime MCP delivery is configured
per agent under `mcp.runtime.delivery` and supports `native`, `mcp`, or
`both`. The built-in providers are intentionally read-only and scope-filtered:
SkillProvider reads canonical skills, while RuntimeMemoryProvider adapts a
CanonicalMemoryProvider that reads canonical Markdown memories through
`trellis.memory.search`, `trellis.memory.read`, and
`trellis://memories/<name>.md`. Neither executes scripts or mutates canonical
state. A future local-graph/OpenViking source can implement the same
MemoryProvider contract. Memory writes and configuration mutation require
separate provider designs and explicit user-control rules.

Kimi Code is Runtime-first. Its adapter writes one `trellis-runtime` entry to
`~/.kimi-code/mcp.json`; it does not copy canonical Skills into
`~/.kimi-code/skills` when delivery is `mcp`. Use `trellis kimi` for this mode:
the launcher passes Kimi's documented `--skills-dir` override an empty
temporary directory, preventing Kimi's automatic `~/.agents/skills` discovery
from duplicating the Runtime SkillProvider. Kimi's native mode remains
available when delivery is `native` or `both`.

Kimi's user MCP registry is `~/.kimi-code/mcp.json`; the adapter preserves
unowned entries and uses the existing MCP ownership ledger for the one entry
Trellis owns. The Kimi CLI itself remains responsible for login and OAuth.

## What Trellis explicitly does not build

- A resident MCP gateway daemon. Gateway mode above is a per-session
  subprocess with no lifecycle; hub mode points at something you operate.
  Neither is a service Trellis starts, supervises, or keeps running.
- A semantic/external memory backend (the built-in provider only exposes
  read-only canonical Markdown; the default graph backend remains
  `@modelcontextprotocol/server-memory`,
  turned on with `trellis onboard --memory on` (trellis-onboard-mcp-mode)
  rather than hand-editing `servers.yaml`, documented in
  `schema/servers.example.yaml`; mem0/OpenMemory and totalrecallai-class
  semantic-search servers documented as opt-in upgrades — see
  docs/research.md "Shared memory")
- A secret vault (reads `${VAR}` from whatever the environment already
  provides — `~/.config/agent-env/secrets.env`, 1Password's `op run`,
  anything that populates `process.env` before an adapter's generated
  command runs)
- A GUI (P5 in the roadmap evaluates embedding into an existing one —
  mcp-router's or skills-hub's — before building a new one)

## MCP handshake probing is opt-in, not default

`trellis doctor`'s default run never spawns a configured MCP server — it
only reads static config (name, transport, collision against
`known_host_injected`). Live handshake probing (`src/lib/mcpProbe.ts`) is a
real capability, unit-tested against a fixture server, but running it
against every server configured on a real machine turned out not to be
"read-only" in the sense that actually matters: some servers reach real
external services with real credentials (OAuth-backed connectors,
`chrome-devtools-mcp`'s `--autoConnect`), and doing this for a dozen-plus
servers serially, once per agent, made a single default `trellis doctor`
run take minutes and spawn processes with a meaningfully larger blast
radius than "list what's configured." Pass `--probe-mcp` to opt in; the
default stays fast, side-effect-free, and safe to run in a pre-commit hook
or CI on every commit.

## Testing philosophy: never verify against the developer's real environment

**Hard rule, not a preference.** P0's probes are read-only, so they're safe
to run against a real machine's real `~/.claude`, `~/.codex`, etc. — that's
how `docs/research.md`'s findings were originally discovered, by hand,
against a real machine, and P0 formalizes exactly that.

Every phase from P1 onward writes: symlinks, in-place TOML/JSON patches,
eventually credentials passing through a spawned process's env. **None of
that is ever exercised against a developer's actual dotfiles, actual
`~/.claude.json`, actual `~/.codex/config.toml`, or any other real
configuration a person depends on for their day-to-day work** — not during
development, not in CI, not for a "quick manual check." A bug in an adapter
that patches TOML in place is exactly the kind of thing that corrupts a
real config file if it's tested against one.

**Exception: pi.** This rule protects real state a person depends on — the
other three agents' adapters patch that state in place (symlinks over real
directories, in-place TOML/JSON edits). pi's adapter never does: skills/
instructions are the same symlink-or-noop regardless of machine, and the
MCP bridge (P4) is a single already-symlinked extension file that reads a
separate, Trellis-owned `servers.yaml` rather than writing into anything pi
itself depends on. A temporary, narrowly-scoped `~/.trellis/mcp/servers.yaml`
(deleted afterward) plus a real `pi -p` run therefore carries none of the
corruption risk this section exists to prevent, and it's the only way to
observe pi's actual extension-loading behavior on *this* installed pi/jiti
version — `docker/pi-sandbox.Dockerfile` verifies the same jiti-tolerance in
general (P4's own acceptance criteria), but doesn't stand in for a
spot-check against a specific real installation. Real-machine verification
of pi specifically is therefore permitted, not a hard-rule violation — the
other three agents are not exempted.

Verification happens against an isolated environment instead: a scratch
`$HOME` (or a container with one mounted) populated with synthetic
per-agent config that looks like the real thing but is expendable — created
fresh, asserted against, thrown away. `docs/implementation-plan.md`'s P1
acceptance criteria already describes this shape ("point at a scratch
`$HOME`... run `trellis sync skills`... confirm zero findings"); this
section exists to make it a project-wide rule that every later phase's
acceptance criteria must follow, not a detail specific to P1.

This is also why P0 needing to resolve pi's actual skill-discovery path
(§D5 in `openspec/changes/trellis-doctor-p0/design.md`) is investigated
directly against a real pi installation *as a read-only observation*, and
that finding then gets encoded as a fixture for the isolated test
environment — the real machine is where you learn the shape of the truth
once; it is never where you repeatedly verify against it.

### The actual mechanism: `scripts/sandbox.sh`

```
scripts/sandbox.sh                    # interactive shell in the sandbox
scripts/sandbox.sh npm run dev doctor  # run a command in the sandbox
scripts/sandbox.sh --runtime           # divergent multi-agent Runtime lab
scripts/sandbox.sh --migration         # Kiro -> Codex post-migration lab
scripts/sandbox.sh --management        # steady-state unified management lab
scripts/sandbox.sh --failure           # hanging-upstream isolation lab
scripts/sandbox-matrix.sh              # run the full scenario matrix
scripts/agent-sandbox.sh               # real Codex/Claude/Kiro/pi/Kimi CLI config smoke
```

`agent-sandbox.sh` 默认使用一次性 HOME。需要进行授权时，显式使用专用
Docker volume（默认名为 `trellis-agent-auth-home`）：

如果宿主机已经登录 Codex 或 pi，可以显式复用单个认证文件：

```
scripts/agent-sandbox.sh --host-auth codex
scripts/agent-sandbox.sh --host-auth pi
```

这两个命令只读取宿主机对应的 `auth.json`，不读取整个 agent 配置目录。

```
scripts/agent-sandbox.sh --login codex
scripts/agent-sandbox.sh --login claude
scripts/agent-sandbox.sh --login kiro
scripts/agent-sandbox.sh --status codex
scripts/agent-sandbox.sh --status claude
scripts/agent-sandbox.sh --status kiro
scripts/agent-sandbox.sh --auth codex exec --help
scripts/agent-sandbox.sh --auth claude -p --help
scripts/agent-sandbox.sh --prepare
scripts/agent-sandbox.sh --host-auth codex
scripts/agent-sandbox.sh --host-auth pi
```

授权只写入这个 Docker volume，不会复制宿主机的登录态，也不会进入
Git、镜像或 fixture。`--login` 会分别执行真实 agent 的登录命令：
Codex 使用 device auth，Claude Code 使用 Claude subscription 登录，
Kiro CLI 使用 free license 的 device flow。Kiro 在未登录时会明确拒绝
`mcp list`，这是预期的授权前置条件。需要清空授权 volume 时，应由用户
显式执行 `docker volume rm <volume-name>`；Trellis 不会自动删除它。

授权后若要在同一登录态中运行真实 agent，使用 `--auth` 前缀，例如：

```
scripts/agent-sandbox.sh --prepare
scripts/agent-sandbox.sh --auth codex exec ...
scripts/agent-sandbox.sh --auth claude -p ...
```

Backed by OrbStack (this machine's Docker context — a Mac-native,
Apple-Virtualization-framework-backed runtime, not Docker Desktop; any
Docker-compatible daemon works identically). `docker/sandbox.Dockerfile`
builds a Node image containing the repo's `src/`; `docker/entrypoint.sh`
copies `test/fixtures/home` (mounted **read-only**) into a container-local
scratch `$HOME` before running anything, so no command executed inside the
container can ever write back to the fixture files checked into git —
verified directly: a write to the sandboxed `$HOME` during development
left the host-side fixture byte-for-byte unchanged.

`test/fixtures/home/` is a synthetic four-agent `$HOME` — fake
`.claude.json`, `.codex/config.toml`, `.kiro/settings/mcp.json`,
`.pi/agent/settings.json`, skill directories — built to exercise specific,
known findings, not just to look plausible:

- `.agents/skills/sample-skill/` vs. `.codex/skills/duplicate-skill/`:
  byte-identical content at two different paths, deliberately, to exercise
  `capability-drift-detection`'s duplication check against a real case
  rather than an assertion with no failing fixture behind it.
- `.codex/config.toml` defines an `mcp_servers.sentry` entry — a name that
  also appears in `known_host_injected` (`schema/servers.example.yaml`) —
  reproducing the exact collision class from `docs/research.md` (same-name
  static + host-injected server) as a fixture, not just a comment
  describing the risk.
- `.kiro/skills/broken-case-skill/skill.md` — deliberately lowercase, to
  exercise the case-sensitivity check.
- `test/fixtures/sample-mcp-server.js` — a minimal real MCP server (reads
  `initialize` over stdio, replies with fixed `serverInfo`) so
 `probeMcpServer` has something deterministic to handshake against inside
 the container without depending on a real npm package or network access.

For the MCP Runtime phase, the sandbox has a separate intentionally
divergent fixture rather than expanding the baseline one:

```
scripts/sandbox.sh --runtime
```

This scenario gives Claude Code, Codex, Kiro, pi, and Kimi Code different native
skills, instructions, and MCP entries; adds canonical scope, per-agent
direct/gateway routes, `native`/`mcp`/`both` delivery, a deliberate
host-injected collision, and canonical memory content. The lab then runs
native sync, MCP sync, memory sync, secrets audit, and real MCP client
handshakes against Claude/Codex/pi/Kimi runtime views. All writes stay inside
the container-local HOME.
