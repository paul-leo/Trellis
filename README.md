# Trellis

**A single source of capability for every coding agent you run.**

Skills, MCP servers, subagent definitions, shared memory, and secret policy —
defined once, adapted natively into Claude Code, Codex, Kiro, and the [pi coding
agent](https://github.com/earendil-works/pi), without drift and without a second
copy of anything.

Trellis does not replace any of these agents' native config. It generates and
verifies each one's native adapter from one canonical source, and refuses to let
a plaintext secret or a duplicated skill file slip through.

## Why

By late 2026 the "sync my AI agent rules across tools" space is crowded — at
least seven open source projects do it (`block/ai-rules`, `ai-rules-sync`,
`skillshare`, `skills-hub`, `skills-link`, `agent_sync`, and others). None of
them cover **Kiro** or **pi**, and none of them go past rules/skills into MCP
servers, shared memory, and secret hygiene as one coherent system. That's the
gap Trellis fills — see [`docs/research.md`](docs/research.md) for the full
landscape survey and [`docs/architecture.md`](docs/architecture.md) for what we
build versus what we deliberately reuse.

Trellis aligns with the emerging [`.agents Protocol`](https://dotagentsprotocol.com)
draft rather than inventing a sixth competing standard, and is likely its first
working implementation.

## Install

```
npm install -g agent-trellis
```

## Quick start

1. Create `~/.trellis/agents.md` (shared instructions) and, optionally,
   `~/.trellis/skills/<name>/SKILL.md` per skill, `~/.trellis/mcp/servers.yaml`
   (see [`schema/servers.example.yaml`](schema/servers.example.yaml)), and
   `~/.trellis/secrets.policy.yaml`.
2. `trellis doctor` — read-only scan of every present agent's current state.
3. `trellis sync` — distribute skills/instructions to every present agent.
4. `trellis mcp sync` — distribute MCP servers to every present agent's
   native config (create/repair only — see Known limitations).
5. `trellis secrets audit` — fail non-zero if any agent's real config holds
   a literal credential or an unexpected env var name.

## Status

**Early, pre-1.0.** All four CLI commands above are implemented, unit-tested,
and verified end-to-end against real Docker containers (never a developer's
own dotfiles during development — see
[`docs/architecture.md`](docs/architecture.md)'s testing philosophy). See
[`docs/roadmap.md`](docs/roadmap.md) for what's shipped (P0–P6) vs. planned
(P7, a GUI).

**Known limitations, honestly stated rather than discovered the hard way:**
- MCP servers are never spawned/handshake-tested by `trellis mcp sync` or
  `trellis sync` — only that the *config* is written correctly.
  `trellis doctor --probe-mcp` is the one command that actually connects,
  and it's opt-in.
- The pi bridge extension (`trellis-pi-mcp-bridge`) has been verified to
  load and register tools without erroring, never against a real LLM tool
  call in production.
- Verification has run against real Docker containers and a real,
  isolated pi CLI install — not yet against a developer's actual, existing
  `~/.claude`/`~/.codex`/`~/.kiro`/`~/.pi` in daily use. If you hit
  something a clean-room sandbox wouldn't have caught, please open an
  issue.
- Automatic removal of an MCP server is deliberately unsupported (create/
  repair only) until an ownership-tracking mechanism exists — see
  `docs/roadmap.md`'s P2 note.

## Design principles

1. **One canonical source, many adapters.** Each agent's native config file is
   a generated or symlinked artifact, never hand-edited.
2. **Reuse before building.** MCP aggregation, memory, and secret-reference
   patterns already have mature open source answers — Trellis wires to them
   instead of reimplementing them. See [`docs/architecture.md`](docs/architecture.md).
3. **No plaintext secrets, ever.** Every adapter output holds variable
   references only; `trellis secrets audit` scans for and rejects raw values.
4. **Verify, don't assume.** Every claim this project makes about an agent's
   behavior (file format, discovery path, MCP support) is backed by an
   executed probe, not documentation-reading. Adapters that can't be verified
   this way don't ship.

## License

MIT — see [`LICENSE`](LICENSE).
