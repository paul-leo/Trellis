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

## Status

Pre-alpha. Architecture and schema are being finalized before the first CLI
command ships. See [`docs/roadmap.md`](docs/roadmap.md).

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
