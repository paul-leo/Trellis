# Design — trellis-cli-onboard

## D1 — `sync` gains `--dry-run`

`collectSyncReport` currently calls `adapter.apply(items)` unconditionally
— there is no preview mode today. Onboard's own `--dry-run` guarantee (a
true no-writes preview of the whole init→migrate→sync chain) needs one, and
it's a small, independently useful addition to `trellis sync` on its own
merits (symmetry with `migrate --dry-run`), not a one-off workaround built
only for onboard. `RunSyncOptions` gains `dryRun?: boolean`; when set,
`adapter.apply(items)` is skipped and the plan is still computed and
returned/printed exactly as today. CLI gains `trellis sync [...] --dry-run`.

## D2 — Onboard orchestrates, never reimplements

`trellis onboard` calls, in order: `collectInitReport` (already
idempotent), each agent's own `probe()` directly (not through
`collectMigratePlan`, since a base hasn't been chosen yet and probing is
needed for all four regardless of which one wins), then — once a base is
resolved — `collectMigratePlan`/`applyMigratePlan` (or `runMigrate`
directly) and `collectSyncReport` (or `runSync` directly). No new
skill-copy, conflict-detection, or symlink logic is written for this
change; every judgment call about a given skill or instructions file was
already made by `migrate`.

## D3 — Base-agent resolution

| Present agents | `--agent` given | stdin is a TTY | Result |
|---|---|---|---|
| 0 | — | — | Print each of the four agents' install hint (`INSTALL_HINTS`, reused from `init.ts`). Exit 0 — this is a correct stopping point, not a failure. |
| 1 | — | — | Auto-selected. Printed as "only <agent> detected — using it as the base" so the choice is never silent. |
| 2+ | valid, present | — | Used directly. No prompt. This is the path `--json` and sandbox verification both go through. |
| 2+ | invalid, or not present | — | Refuse cleanly, exit 1, lists the actually-present agents. |
| 2+ | absent | yes | Interactive `node:readline/promises` prompt: print each present agent's skill count + names + whether it has real (non-placeholder, non-symlink) instructions, then ask the user to type one of the agent ids. Re-prompts once on an unrecognized answer, then refuses cleanly rather than looping forever. |
| 2+ | absent | no | Refuse cleanly, exit 1: "multiple agents detected (<list>) and no terminal to prompt in — pass `--agent <id>`." Same principle `scripts/sandbox.sh` already uses for its own `-it`/`-i` TTY branching. |

`--json` mode never prompts, full stop, even when stdin happens to be a
TTY — a machine caller can't answer an interactive question either. It
follows the same table with "stdin is a TTY" forced to "no."

## D4 — Merge mode is out of scope

Two or more present agents with genuinely *different* real content today
still resolves to "pick one as the base, migrate that one, leave the
others' own real files as `migrate`/`sync` already report them (conflict,
untouched)." Actually combining differing skills/instructions from
multiple agents into one merged canonical result is real, separate,
harder design work (whose content wins per-file? per-skill? does the user
review a diff?) — explicitly deferred, called out in `docs/roadmap.md` as
named future work rather than silently absent.

## D5 — Capability listing scope matches what migrate actually imports

The per-agent summary shown before choosing a base lists skills (count +
names) and instructions presence — exactly what `migrate` imports — not
MCP servers, which `migrate` never touches (that's `mcp sync`'s own,
separate canonical source). Listing something the subsequent migrate step
can't act on would be a preview of a decision the user can't actually make
here.

## D6 — Install hints move from init-only to shared

`INSTALL_HINTS` (currently a module-private `const` in `src/commands/init.ts`)
is exported, matching the existing precedent for `AGENTS_MD_TEMPLATE` —
`onboard` needs the exact same four strings when zero agents are present,
and duplicating them a second time risks the two silently drifting apart.
