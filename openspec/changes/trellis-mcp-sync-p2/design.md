## Context

`docs/implementation-plan.md`'s original P2 sketch assumed two things that
turned out to be wrong once actually checked against a real Codex install
and real TOML libraries — this document exists to record what was
verified instead of assumed, per this project's own established practice
(P0's D2/D5, P1's D1 all did the same kind of check-before-committing).

Stakeholder: single developer (project owner), same as P0/P1.

## Goals / Non-Goals

**Goals:**
- Make MCP server definitions single-sourced across Claude Code, Codex,
  and Kiro, with the same create/repair/remove/refuse contract P1
  established for skills/instructions.
- Never let Trellis's own write introduce the exact incident class
  `docs/research.md` documents (same-name static+injected collision,
  literal secrets on disk).
- Never touch a byte of `~/.codex/config.toml` outside the specific
  `[mcp_servers.<name>]` section being changed.

**Non-Goals:**
- pi's MCP bridge (P4 — pi has no native MCP client at all, a different
  kind of problem, not a config-sync one).
- The full, configurable `trellis secrets audit` command (P3) — this
  change's pre-write guard is a narrow, hardcoded floor, not that command.
- Rewiring `trellis doctor`'s collision check to read the now-real
  `known_host_injected` from canonical instead of its P0-era hardcoded
  default (`src/commands/doctor.ts`'s `DEFAULT_KNOWN_HOST_INJECTED`) — a
  natural follow-up once this change lands, deliberately left as one, not
  silently folded in here (`capability-drift-detection` isn't listed as a
  modified capability in proposal.md; if it needs to change, that's its
  own small change with its own proposal).

## Decisions

### D1 — REJECTED: `codex mcp add`/`remove` for the general write path

Investigated as a way to avoid needing any TOML handling at all (matching
P0's D2 precedent of preferring Codex's own CLI over parsing its config).
Tested directly against an isolated scratch `$HOME` (never the real
machine):

```
$ HOME=$SCRATCH codex mcp add gitlab --env GITLAB_PERSONAL_ACCESS_TOKEN -- npx -y @zereight/mcp-gitlab
error: invalid value 'GITLAB_PERSONAL_ACCESS_TOKEN' for '--env <KEY=VALUE>':
environment entries must be in KEY=VALUE form
```

`codex mcp add --env` only accepts a literal `KEY=VALUE` — there is no
CLI-exposed way to produce the name-only `env_vars = ["NAME"]` form
Trellis's secrets model requires (docs/research.md "Secrets": configs hold
variable *names*, never values). Using `codex mcp add` for any server
needing credentials would mean shelling out with the real secret value on
the command line and having Codex write it into `config.toml` as a
literal — exactly the thing this project's secrets policy exists to
prevent. (`codex mcp remove` has no such problem — deleting a section
never involves a value — but is not used, for the single-code-path reason
in D3.)

### D2 — REJECTED: parse-mutate-reserialize with a TOML library

Both realistic candidates (`@iarna/toml` 2.2.5, last published 2023-07;
`smol-toml` 1.8.0, actively maintained) were installed and run against a
real fixture, not assumed:

```toml
# top comment
model = "gpt-5.6-sol" # inline comment

[mcp_servers.gitlab]
command = "npx"
args = ["-y", "@zereight/mcp-gitlab"]
env_vars = ["GITLAB_PERSONAL_ACCESS_TOKEN"]
```

Both libraries' `parse()` → `stringify()` round-trip on this exact input
**silently dropped both comments** and **reformatted the arrays**
(`["-y", ...]` → `[ "-y", ... ]`) — on a file that was never even
supposed to change. Neither is safe for "patch one section, leave every
other byte alone," which is the hard constraint, not a nice-to-have.

### D3 — Line-based section locator/splicer, no TOML library dependency

Since neither D1 nor D2 works, and since what's actually needed is narrow
(find where `[mcp_servers.<name>]` starts and ends as *lines*, replace
just those lines), `src/lib/tomlSection.ts` implements this directly:

- A section starts at a line matching `^\[mcp_servers\.<name>\]\s*$`
  (exact, anchored — not a substring match).
- It ends at the line before the next line that starts with `[` (any
  table header, array-table `[[...]]` included, or EOF) — whichever
  comes first.
- Replacing: splice the found line range with the new rendered section
  text (or with nothing, for removal — including the blank line before it
  if one exists, so repeated add/remove doesn't accumulate blank lines).
- Inserting a new section (no existing header found): append to EOF with
  a leading blank line for separation, never inserted mid-file — avoids
  any risk of misjudging where "the right place" to insert is relative to
  content this tool doesn't understand.
- Rendering a `McpServerDef` as TOML text is call generation, not parsing
  — a small, fully-tested function for a bounded, known shape (`command`,
  `args`, `env_vars`/`url`), not general TOML serialization.

**Safety net**: if the scanner finds something it can't confidently
resolve (e.g. an existing `[mcp_servers.<name>]` header but no clear
following table boundary before EOF in a way that looks intentional — in
practice this shouldn't happen, but the code must not guess), it refuses
the write for that server and surfaces a conflict/diagnostic rather than
attempting a best-effort splice. Silence is not an acceptable failure mode
for a function whose entire job is "never touch bytes you don't own."

Read-side detection (does a server already exist, for collision checking)
continues to use `codex mcp list --json` (P0's D2) — this document only
concerns the *write* path, which `codex mcp list` cannot do.

### D4 — Claude Code / Kiro: plain JSON parse → merge → stringify

Unlike TOML, JSON has no comments to lose, so the concern D2 raises for
Codex doesn't apply here — `JSON.parse` the whole file, merge only under
the `mcpServers` key (spread every sibling key through untouched),
`JSON.stringify` the result. This was already the plan in
`docs/architecture.md`; this change is where it's actually built.

### D5 — Pre-write secrets guard is a narrow, hardcoded floor, not P3's job

Refuses to write any value matching `glpat-`, `sk-`, `ghp_`, or `mcpr_`
literally (mirrors `schema/secrets.policy.example.yaml`'s own examples).
This is deliberately not wired to a real, user-configurable
`secrets.policy.yaml` yet — P3 owns parsing that file and the full
`trellis secrets audit` command that scans *adapter output* after the
fact; this is a narrower, pre-write guard specific to the MCP adapter,
cheaper to catch here than after. `CanonicalSource.secretsPolicy` stays
the empty placeholder P1 left it as.

### D6 — Hub-mode entry name: `trellis-hub`

When `canonical.mcp.hub` is set, every adapter writes exactly one entry
under the fixed name `trellis-hub` (Claude Code/Kiro: one `mcpServers`
key; Codex: one `[mcp_servers.trellis-hub]` section) instead of one entry
per server in `canonical.mcp.servers`. The collision check runs against
this single name instead of every server name, since there's nothing else
locally defined to collide with (`docs/architecture.md` "MCP hub mode").

## Risks / Trade-offs

- **[Risk]** The line-based section scanner is hand-rolled, not a
  standards-compliant TOML parser — it could misjudge a section boundary
  on TOML syntax it wasn't built to understand (deeply unusual formatting,
  a value containing a line starting with `[`). **Mitigation**: scope is
  intentionally narrow (only ever needs to recognize `[mcp_servers.*]`
  headers and top-level table boundaries, not general TOML); the refuse-
  rather-than-guess safety net in D3; and this is the same trade profile
  P0 already accepted for `readInstructionsPath` (a narrow heuristic
  preferred over a general parser for a narrow, well-understood need).
- **[Trade-off]** No TOML library means writing (and testing) the
  section-locator and the TOML-value-rendering logic by hand instead of
  delegating to a library. Accepted because D2's own evidence shows the
  realistic library candidates don't actually solve the problem safely —
  paying this cost buys real correctness, not just less code.

## Migration Plan

No migration — first version of this capability. Rollback: delete the
Trellis-managed section(s) from each config (the same "remove" mechanic
this change implements handles this on the next `trellis mcp sync` run,
same pattern as P1's rollback story).

## Open Questions

None blocking.
