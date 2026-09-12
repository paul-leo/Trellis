# Roadmap

Each phase must ship with a `trellis doctor` check that verifies its own
claim — no phase is "done" on the strength of a config file existing, only
on the strength of a passing verification against the real running agent.

See [`implementation-plan.md`](implementation-plan.md) for P1–P4 broken down
to file/function level.

**P0 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-doctor-p0/`;
living spec at `openspec/specs/agent-state-probing/` and
`openspec/specs/capability-drift-detection/`). Verified against this real
machine, not just fixtures: independently rediscovered the already-fixed
Codex `openspec-*` duplication as clean, found a real, previously-unknown
MCP name collision (`sentry` statically configured on Claude Code and Kiro
while also being a `known_host_injected` name), and found a real wrong-case
skill file (`e2e-test`). `trellis doctor` (no flags) does none of this by
spawning anything — MCP handshake probing is opt-in via `--probe-mcp`
(see `docs/architecture.md`), added after a real run showed the default
had a much larger blast radius than "read-only" should mean.

This is the format every later phase uses: one `openspec/changes/<phase>/`
directory per phase, `openspec new change <name>` → tasks implemented →
`openspec archive <name>`. `implementation-plan.md`'s P0 section is kept
only as a historical note; don't edit it further.

| Phase | Deliverable | Depends on |
|---|---|---|
| P0 | ✅ `trellis doctor` — read-only, opt-in-for-handshakes scan of all four agents' current skills/MCP/instructions state, reports drift and duplicates | nothing |
| P1 | `trellis sync skills` / `trellis sync instructions` — symlink-based distribution to Claude Code, Codex, Kiro | P0 |
| P2 | `trellis mcp sync` — incremental, in-place adapters for Claude Code (JSON merge), Codex (TOML section patch), Kiro (JSON merge); collision check against known host-injected server names | P1 |
| P3 | `trellis secrets audit` — scans every adapter's output for literal credential patterns, fails non-zero on any hit | P2 |
| P4 | pi bridge extension — MCP tool registration via `registerTool`, sourced from the same `mcp/servers.yaml` | P2 |
| P5 | `@trellis/sdk` — read-only API over the canonical source, for third-party agents to consume without depending on the CLI | P1–P4 stable |
| P6 | Memory: document and wire the `server-memory` default; write the mem0/OpenMemory upgrade guide | P2 |
| P7 | GUI: evaluate embedding into mcp-router's or skills-hub's existing interface before building anything new | P3–P6 |

No dates. This is scoped by verification milestones, not calendar time.
