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

See [`docs/getting-started.md`](docs/getting-started.md) for the detailed
walkthrough — example output for each command, what each `migrate`/`sync`
conflict action means, and troubleshooting. Short version:

**Already using Claude Code, Codex, Kiro, or pi and want to migrate what you
already have?**

1. `trellis init` — creates `~/.trellis/` with a minimal skeleton (only what's
   missing; never overwrites a file you already have) and tells you which of
   the four agents it found on this machine.
2. `trellis migrate --from <agent>` — once per agent you already use. Copies
   that agent's real skills and instructions into canonical source. Never
   overwrites: an already-identical skill is reported and skipped, a genuine
   conflict is reported and left for you to resolve by hand. Add `--dry-run`
   to preview first.
3. `trellis sync` — distributes canonical skills/instructions to every agent
   present on this machine (including the ones you didn't migrate from).
4. `trellis mcp sync` — distributes `~/.trellis/mcp/servers.yaml` (see
   [`schema/servers.example.yaml`](schema/servers.example.yaml)) to every
   agent's native MCP config (create/repair only — see Known limitations).
5. `trellis secrets audit` — fails non-zero if any agent's real config holds
   a literal credential or an unexpected env var name.
6. `trellis doctor` — read-only scan of every present agent's current state;
   run any time to check for drift.

**Starting from nothing?** Skip step 2 — `trellis init`'s placeholder
`agents.md` and empty `skills/` are a fine starting point; edit them by hand.

## Status

**Early, pre-1.0.** All six CLI commands above (`init`, `migrate`, `doctor`,
`sync`, `mcp sync`, `secrets audit`) are implemented, unit-tested, and verified
end-to-end against real Docker containers (never a developer's own dotfiles
during development — see [`docs/architecture.md`](docs/architecture.md)'s
testing philosophy). See [`docs/roadmap.md`](docs/roadmap.md) for what's
shipped (P0–P6) vs. planned (P7, a GUI).

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
