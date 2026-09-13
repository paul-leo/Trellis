# trellis-managed-agents

## Why

Today `trellis sync` / `trellis mcp sync` / `trellis secrets audit` act
against **every present agent** unconditionally — there is no way to tell
Trellis "only manage these ones." That's wrong for the real use case this
was built for: migrating from an existing agent (e.g. Claude Code) onto a
new one (e.g. pi), one agent at a time, without Trellis reaching into every
other agent it happens to detect on the same machine. It's also what
produced the real regression fixed just before this change (`onboard`
silently repointing a foreign-owned instructions symlink) — the blast
radius of "acts on everyone present" is larger than it needs to be, and
larger than most users actually want.

The user's own words, across three messages, define the model precisely:

- "只有用户选定的 agent 我们才接管，我们并不是直接接管" — only the agent(s)
  the user explicitly selects get taken over; presence alone is not
  consent.
- "用户也可以选择没有安装的 agent 例如 pi，我们负责从安装到接管" —
  selecting an agent that isn't installed yet is itself the authorization
  to install it (still confirmed once, never silent), then take it over.
- "只有用户选择结果的我们才 sync，claude code 作为来源我们暂时不修改，来源的
  那个 agent 用户可以选择接管或者不接管，当然默认不接管" — the migration
  **source** (read from, to build canonical) is a separate choice from the
  managed set (written to). The source is excluded from the managed set by
  default; the user can opt it in explicitly.

## What Changes

- New persisted canonical state: `~/.trellis/managed.yaml` — the list of
  agents Trellis is authorized to write to. Empty/absent means "nothing
  managed yet," not "everyone" — a deliberate reversal of today's implicit
  "every present agent" default.
- `resolveScope`'s fallback for an item with no explicit `scope` changes
  from `ALL_AGENTS` to the canonical managed-agents list. An item's own
  explicit `scope` is intersected with the managed set, not used verbatim
  — Trellis never writes to an agent outside the managed set regardless of
  what any single skill's `scope.yaml` entry says.
- `trellis sync`, `trellis mcp sync`, `trellis secrets audit` only build
  adapters for managed agents. An agent that's present but unmanaged is
  never probed for a plan, never reported on, never touched — not even a
  conflict line.
- `trellis onboard` reworked into two separable choices instead of one:
  1. **Migration source** (optional, at most one) — same resolution rules
     as today (auto-selected if exactly one present-with-content agent
     candidate, prompted if more than one, skippable if starting fresh).
     Read-only: importing from it never writes back to it.
  2. **Managed agents** (a set, zero or more) — a new multi-select prompt,
     numbered like the existing single-select was. Candidates are all
     four agents, present or not. The source agent (if any) is offered
     but starts **unchecked** by default. Selecting an agent that isn't
     installed triggers one confirmation, then a real `npm install -g
     <package>` (Kiro has no CLI installer — selecting it while absent is
     refused with an explanation, never silently skipped or force-tried).
  3. `managed.yaml` is written from the resolved set, then migrate (if a
     source was chosen) → sync → mcp sync → secrets audit all run scoped
     to that set only.
- `trellis doctor` is unaffected — read-only visibility across every
  present agent stays valuable regardless of what's managed.
- `~/.agents` (Codex's own ~/.ai-config-sourced skill convention) becomes
  an explicit, tested non-goal rather than an incidental side effect of
  the ownership-conflict fix: Trellis never plans a write there, documented
  and asserted directly instead of relying on "it happens to always look
  like a real directory."

## Impact

- Affected capabilities: `onboarding-flow` (MODIFIED — base selection
  becomes source + managed-set selection), `skill-instructions-sync` and
  `mcp-server-sync` (MODIFIED — scoped to managed agents, not every
  present one), new `agent-management-scope` capability (the persisted
  managed-agents concept and its resolution rules).
- Affected code: `src/core/types.ts` (`resolveScope` signature),
  `src/core/canonical.ts` (load `managed.yaml`), `src/commands/sync.ts`,
  `src/commands/mcp.ts`, `src/commands/secretsAudit.ts` (adapter
  construction scoped to managed agents), `src/commands/onboard.ts`
  (two-choice flow, install confirmation), `src/commands/init.ts`
  (bootstrap an absent-by-default `managed.yaml`), new
  `src/lib/installAgent.ts` (the confirm-then-`npm install -g` step).
