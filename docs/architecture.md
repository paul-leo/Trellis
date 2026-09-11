# Architecture

## Layers and who owns each one

```
┌─────────────────────────────────────────────────────────┐
│  Trellis canonical source  (~/.trellis or project .trellis) │
│  instructions · skills · agents · mcp/servers.yaml ·      │
│  memories · secrets policy                                 │
└───────────────┬─────────────────────────────────────────┘
                │  trellis sync / trellis doctor
        ┌───────┼────────┬─────────────┬──────────────┐
        ▼                ▼             ▼              ▼
   Claude Code         Codex          Kiro            pi
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
├── secrets.policy.yaml       # which var names are allowed, nothing else
└── trellis.lock.json         # per-agent adapter state, for drift detection
```

## Adapter contract

Every adapter must implement:

- `probe()` — does this agent exist on this machine, what version
- `plan(canonical)` — pure function, canonical state → diff to apply, no I/O
- `apply(plan)` — perform the diff; must be idempotent and re-runnable
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

**Codex** — skills via `~/.agents/skills` symlink (Codex's own built-in
convention, requires no Trellis-specific path). MCP via `codex mcp add`
where possible; for env passthrough use `env_vars`, never `--env` with a
literal secret value. Must check for name collisions against any host-
injected servers (mirasim connectors) before writing — see research.md §3.

**Kiro** — same shape as Claude Code: `~/.kiro/skills` symlink,
`~/.kiro/steering/CLAUDE.md` symlink, `~/.kiro/settings/mcp.json` patched
like Claude's.

**pi** — instructions and skills need no adapter (native discovery). MCP
needs a real bridge: a pi extension, shipped by Trellis, that reads
`mcp/servers.yaml` at pi startup and registers each server's tools through
pi's `registerTool` API by running a real `@modelcontextprotocol/sdk` stdio
client per server. This is the one piece of the project that is an agent
runtime extension, not a config generator.

## What Trellis explicitly does not build

- An MCP aggregator/gateway (use mcp-hub if you want tool-subset filtering
  across many servers; Trellis's adapters talk to servers directly)
- A memory backend (defaults to `@modelcontextprotocol/server-memory`;
  mem0/OpenMemory documented as an opt-in upgrade)
- A secret vault (reads `${VAR}` from whatever the environment already
  provides — `~/.config/agent-env/secrets.env`, 1Password's `op run`,
  anything that populates `process.env` before an adapter's generated
  command runs)
- A GUI (P5 in the roadmap evaluates embedding into an existing one —
  mcp-router's or skills-hub's — before building a new one)
