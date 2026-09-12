# Research: what already exists

Surveyed 2026-09-11. This is why Trellis is a thin orchestration layer, not a
from-scratch rebuild of anything below.

## Rules / skills sync (crowded — don't rebuild)

| Project | Covers | Kiro | pi | MCP | Memory | Secrets |
|---|---|---|---|---|---|---|
| [block/ai-rules](https://github.com/block/ai-rules) (Rust, Apache-2.0, Block/Square) | 11 agents (AMP, Claude Code, Cline, Codex, Copilot, Cursor, Firebender, Gemini, Goose, Kilocode, Roo) | ❌ | ❌ | config generation only | ❌ | ❌ |
| [lbb00/ai-rules-sync](https://github.com/lbb00/ai-rules-sync) | Cursor/Claude/Copilot/OpenCode/Trae/Codex/Gemini/Warp | ❌ | ❌ | ❌ | ❌ | ❌ |
| [shanliuling/skills-link](https://github.com/shanliuling/skills-link) | 41+ agents, pure symlink | unlisted | unlisted | ❌ | ❌ | ❌ |
| [runkids/skillshare](https://github.com/runkids/skillshare), [qufei1993/skills-hub](https://github.com/qufei1993/skills-hub) | Codex/Claude/OpenClaw etc. | ❌ | ❌ | ❌ | ❌ | ❌ |
| [PanisHandsome/ai-rules-sync](https://github.com/PanisHandsome/ai-rules-sync) | AGENTS.md/CLAUDE.md/.cursorrules/Copilot/Windsurf/Cline/Aider/Gemini | ❌ | ❌ | ❌ | ❌ | ❌ |
| [yelmuratoff/agent_sync](https://github.com/yelmuratoff/agent_sync) | Claude/Cursor/Copilot/Gemini + 10 more | ❌ | ❌ | ❌ | ❌ | ❌ |

**No existing tool covers Kiro or pi.** None combine rules+skills with MCP,
memory, and secret hygiene as one system. That's the actual gap.

## The `.agents Protocol` draft

[dotagentsprotocol.com](https://dotagentsprotocol.com) (status: DRAFT,
2026-02-24, community-maintained, no vendor backing yet) proposes exactly the
directory shape this problem needs:

```
.agents/
├── agents.md            # instructions (compatible with the AGENTS.md standard)
├── mcp.json              # MCP servers
├── skills/*/skill.md     # skill definitions
├── agents/*/agent.md     # subagent profiles
├── tasks/*/task.md       # recurring tasks
└── memories/*.md         # persistent memory entries
```

It explicitly has **no reference implementation** yet. Trellis targets
alignment with this draft rather than inventing a competing schema — being
the first working implementation is more leverage than being a sixth
standard. See [`schema/`](../schema) for where Trellis's schema matches the
draft and where it deliberately extends it (Kiro/pi adapters, secret
references, MCP env passthrough semantics — none of which the draft
specifies).

## MCP aggregation (reuse, don't rebuild)

| Project | Stars | Model | Notes |
|---|---|---|---|
| [MetaMCP](https://github.com/metatool-ai/metamcp) | 2.6k, MIT | Docker + Postgres, namespaces, OAuth | Heaviest, most complete; remote-only endpoints need a local stdio bridge for desktop clients |
| [mcp-hub](https://github.com/ravitemer/mcp-hub) | 516★, 227 commits, MIT | Plain Node process, no Docker, single HTTP endpoint (`/mcp`), JSON config with `command`/`args`/`env` (stdio) or `url`/`headers` (remote) — matches Trellis's own `servers.yaml` fields almost 1:1 | Dynamic add/remove without client restart — SSE-pushes `servers_updated`/`tool_list_changed` to already-connected agents |
| [mcp-router](https://github.com/mcp-router/mcp-router) | — | Desktop app + CLI, Sustainable Use License | Already deployed in this environment; token-based, has a GUI. **First-hand incident**: its `MCPR_TOKEN` existed in three different values across `secrets.env`/`config.toml`/`kiro/mcp.json` simultaneously, one silently invalid — see below |

Decision: Trellis still does not implement aggregation/routing logic
itself. It generates native MCP config for each agent directly — that's
what actually needed solving, since none of the above touch Kiro/pi/Codex's
TOML format. But it now natively *supports* routing every agent through a
single external endpoint instead of N direct definitions ("hub mode," see
`docs/architecture.md`) — not a product integration, just an optional
`hub.url` field every adapter checks. What runs behind that URL (mcp-hub,
mcp-router, anything else) is the user's choice, not Trellis's; the type
(`HubConfig`) deliberately has no engine/product field to keep in sync.

The mcp-router incident above is the concrete argument for preferring a
self-hosted hub whose config Trellis generates from the same
`servers.yaml` over one managed through an external dashboard: the latter
becomes a second place "what servers exist" is defined, outside `.trellis/`
entirely, and this project hit real drift from exactly that shape of setup
before hub mode existed as a documented option.

## Shared memory (reuse)

Checked directly against this real machine before writing this section,
rather than trusting an earlier draft's claim at face value — the result
is more nuanced than either "confirmed" or "wrong":

- `src/commands/doctor.ts`'s `DEFAULT_KNOWN_HOST_INJECTED` already lists
  `"memory"`, documented there as "mirasim's actual known connectors on
  this project's own machine" (P0's own empirical finding, not a guess).
  Runtime-injected connectors are, by design, invisible in any agent's
  *static* config — that's the entire reason `known_host_injected` exists
  as a concept distinct from what a config file shows. So this likely
  *is* real: mirasim probably does inject a `server-memory`-class
  connector named `memory` at runtime for every session on this machine,
  and no amount of reading `.claude.json`/`config.toml`/`mcp.json` could
  confirm or deny that either way.
- What static config *does* show, independent of whatever mirasim
  injects: Kiro alone has an *additional* memory server explicitly
  configured — [`totalrecallai`](https://github.com/Auriti-Labs/kiro-memory)
  (npm `totalrecallai`) — SQLite-backed (`better-sqlite3`) with a local
  embedding model for semantic/vector search (`fastembed` + `onnxruntime`),
  a bundled React web viewer, AGPL-3.0 licensed, its own repo literally
  named `kiro-memory` (purpose-built for Kiro, later marketed as
  MCP-client-agnostic). Claude Code and Codex have no additional static
  memory server at all. Whatever mirasim injects at runtime is presumably
  uniform across all three; this static difference is real, additional,
  and Kiro-specific — the single-source fragmentation problem Trellis
  exists to solve, found in the wild rather than assumed on paper.

The official reference server
[`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
is zero-dependency, local JSON knowledge graph, MIT-licensed, maintained
as part of the official `modelcontextprotocol/servers` repo. Trellis
documents this as the default (`schema/servers.example.yaml`'s `memory`
entry) — the safe, unopinionated choice for a default any `.trellis/`
setup can adopt without pulling in native bindings or a copyleft license
obligation. It's very likely already what a mirasim-hosted session gets
via runtime injection (see `known_host_injected` above) — on a host like
that, declaring it again in `mcp/servers.yaml` collides with the
already-injected connector, exactly the class of incident
`known_host_injected` exists to refuse (see the schema example's own
comment for how to tell which situation applies). On a host with no such
injection, declaring it is what actually wires the default. Either way,
`totalrecallai`'s semantic-search/SQLite/viewer feature set belongs in
the same *opt-in upgrade* category as mem0/OpenMemory below, not silently
adopted as the default just because it happened to already be configured
on one agent, on one machine.

[mem0 / OpenMemory MCP](https://github.com/mem0ai/mem0) — "private,
local-first memory layer with a built-in UI, compatible with all MCP
clients." Mature, but needs Docker + an LLM key. Documented as the
upgrade path for cross-machine or richer semantic memory, alongside
`totalrecallai` as a second real option in that same category.

## Secrets (formalize existing practice, don't build new infra)

The 2026 consensus across 1Password, Vault, Infisical writeups is uniform:
**configs hold references, real values resolve only at process-spawn time,
never persisted twice.** This is exactly what this environment was already
doing by hand (`${VAR}` in Claude Code's `mcpServers`, `env_vars` passthrough
in Codex's `config.toml`) before Trellis existed — confirmed working via two
real incidents during development (a GitLab PAT stored under the wrong
variable name, and three divergent values of the same router token, one of
which was silently invalid). Trellis's contribution here is `trellis secrets
audit` — a linter that fails a build if any adapter output contains a raw
credential — not a new secret store.

## pi coding agent — the one place we write real code, not config generation

Reverse-engineered directly from the installed binary
(`@earendil-works/pi-coding-agent`, confirmed via `strings` on
`dist/bundle/chunks/*.js`, not from documentation):

- pi **natively discovers** `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`
  (in that priority order) — instructions and `SKILL.md`-format skills need
  no adapter work at all.
- pi has **no native MCP client**. The only `mcpServers` string in its bundle
  belongs to the Google Gen AI SDK's Vertex tool-schema translator, which
  explicitly throws `"mcpServers parameter is not supported"` — unrelated to
  MCP proper.
- pi's capability surface is **extensions**: JS modules loaded via
  `--extension`/discovery, with a real API (`createExtension`,
  `registerTool`). Giving pi access to the same MCP servers every other agent
  uses means writing a bridge extension that spins up
  `@modelcontextprotocol/sdk` stdio clients from `mcp.json` and registers
  their tools through this API. This is the one adapter in Trellis that is
  genuine code, not config templating — see
  [`src/adapters/pi/`](../src/adapters/pi).

## Codex — three hard constraints learned by breaking them

All three below came from real incidents, not upfront design, and any Codex
adapter must respect them:

1. **Skill discovery dedups by realpath, not by content.** Two physical
   copies of an identical skill directory both get listed (duplicate tool
   entries); a symlink to the same target is correctly merged into one. Never
   copy a skill into `~/.codex/skills` — always symlink.
2. **`SKILL.md` must match byte-for-byte**, including case. A file saved as
   `skill.md` is silently dropped from discovery — no warning, no error.
3. **Same-name MCP server across a static config and a `-c` runtime override
   is not "last write wins" — it's a field-level merge.** If Codex's own
   `config.toml` defines a server as stdio (`command`) and something injects
   a `url` under the same name at runtime, the *entire* `codex` process fails
   to start (`url is not supported for stdio`), not just that one server.
   Trellis must never let a locally-defined server name collide with a name
   a host environment (like mirasim) is known to inject.
