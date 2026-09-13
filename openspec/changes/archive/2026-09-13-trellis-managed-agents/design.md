# Design — trellis-managed-agents

## D1: `managed.yaml` shape and absent/empty default

`~/.trellis/managed.yaml`:
```yaml
agents: [pi, codex]
```

Absent file and an empty `agents: []` are the same thing: **zero managed
agents**. This is a deliberate reversal of today's implicit "every present
agent" default — pre-1.0, no back-compat shim for it. `trellis sync` /
`mcp sync` / `secrets audit` against zero managed agents print one line
("no managed agents — run `trellis onboard` or edit
`~/.trellis/managed.yaml`") and exit 0 (nothing to report is not a
failure).

`trellis init` bootstraps this file only if missing, same as every other
canonical file — `agents: []`.

## D2: Source vs. managed are independent; source defaults out of managed

Migration source resolution is unchanged from today's single-base logic
(zero/one/many present-with-content candidates → skip/auto/prompt). It is
purely a read: `migrate --from <source>` never gains a `managed.yaml` entry
as a side effect.

The managed-set prompt always offers all four agents (present or not) and
pre-checks whatever's already in `managed.yaml` from a prior run — **not**
the just-resolved source, even if the source happens to already be in
`managed.yaml` from an earlier run (in which case it stays checked, since
that reflects a real prior choice, not today's default). A fresh, one-time
onboard therefore shows the source unchecked by default, exactly matching
"来源的那个 agent 用户可以选择接管或者不接管，当然默认不接管."

## D3: Managed-set write semantics — union, never a silent subtraction

Re-running `onboard` and selecting a different subset **adds** to
`managed.yaml`, it never removes an agent that was already managed. Same
reasoning as `trellis-kiro-approved-env-vars`'s own D3/D4 (`approvedEnvVars`
is a union) — the concrete case this prevents: a user onboards pi today,
comes back next week specifically to add codex, forgets pi isn't
pre-selected by habit, and would otherwise silently un-manage it. Removing
an agent from management is out of scope for this change — a real decision
serious enough to deserve its own explicit command later, not a side effect
of forgetting to re-check a box.

## D4: `--agent` (source) and `--manage` (managed set) are separate flags

`--agent <id>` keeps its existing meaning (resolves the source
non-interactively). New `--manage <id1,id2,...>`:
- A real, present-or-absent agent id list resolves the managed set
  directly, no prompt.
- The literal value `none` is an explicit, intentional "manage zero
  agents this run" — distinct from omitting the flag entirely.
- Omitted, with no TTY to prompt in (including any `--json` run) and at
  least one of `--agent`'s prior "would need to ask" conditions holding for
  the source too: refuse cleanly asking for `--manage`, same "never guess"
  posture already established for source resolution. Zero present agents
  still short-circuits to install hints before either question is asked,
  unchanged from today.

## D5: Install-then-manage for a selected, not-yet-present agent

New `src/lib/installAgent.ts`: `confirmAndInstall(agent, opts)` —
- Only `claude-code`, `codex`, `pi` have an `npm install -g <pkg>` command
  (`init.ts`'s existing `INSTALL_HINTS`); Kiro's hint is a download URL, not
  a package — selecting Kiro while absent is refused with that URL printed,
  never attempted.
- One confirmation per newly-selected, not-yet-present agent
  (`node:readline/promises`, same real/test-injectable seam as the
  existing agent-choice prompt) — declining leaves that agent out of the
  managed set for this run rather than aborting the whole flow.
- The real install is a real `npm install -g <pkg>` child process
  (`node:child_process`, `execFileSync` — argv array, not a shell string,
  so the package name is never interpolated into a shell). Test-injectable
  the same way `promptForAgent` already is — unit tests never spawn a real
  `npm install`.
- `--json`/non-interactive runs selecting a not-yet-present agent (via
  `--manage`) refuse cleanly instead of silently installing without
  confirmation — the "detect-then-prompt, never silent" rule from
  `trellis-cli-onboard`'s own install-hints decision still holds; explicit
  selection authorizes *asking*, not skipping the ask.

## D6: `resolveScope`'s new fallback, and why explicit scope is intersected

```ts
resolveScope(scope: Scope, managedAgents: readonly AgentId[]): readonly AgentId[]
```
No-scope items resolve to `managedAgents` (was `ALL_AGENTS`). An item
**with** an explicit `scope.yaml` entry is intersected with
`managedAgents`, never used verbatim — a skill scoped to `[kiro]` in
`scope.yaml` still must not reach Kiro if Kiro isn't in the managed set;
"managed" is the hard outer boundary every other scoping decision lives
inside, not a parallel, independently-bypassable filter.

## D7: `~/.agents` as a tested non-goal, not an incidental side effect

Already true today (Codex's individual skill entries under `~/.agents/
skills/<name>` are real directories reached through a symlinked parent,
so `planSymlinks`'s existing conflict detection already refuses to touch
them) — this change adds a direct test modeling exactly that shape
(`rootDir` itself a symlink to an external, non-canonical location,
real directories inside it) so it's asserted on purpose, not preserved by
accident of how the current adapters happen to be wired.

## Non-goals

- Merging differing content across multiple agents into one canonical
  result (already named future work in `trellis-cli-migrate`).
- An "unmanage an agent" command (D3).
- Changing `trellis doctor` — stays unscoped, read-only visibility across
  every present agent regardless of what's managed.
