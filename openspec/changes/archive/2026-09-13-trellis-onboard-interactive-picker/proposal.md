## Why

`trellis onboard`'s two interactive prompts (migration-source single-select,
managed-set multi-select) require reading a numbered list and typing the
right digits — a worse experience than a real terminal picker most CLI
users expect today, and error-prone for the multi-select in particular
(comma-separated indices are easy to mistype). This only affects the
interactive, real-terminal path — flags and scripted/piped use are
already fine and stay untouched.

## What Changes

- **BREAKING** (interaction mechanism only, not the contract around it):
  when stdin is a real TTY, `promptForAgentReal` (single-select) and
  `promptForManagedAgentsReal` (multi-select) stop asking the user to
  type a number and instead render an arrow-key-navigable picker —
  Up/Down (or j/k) to move a highlighted row, Enter to confirm a
  single-select, Space to toggle + Enter to confirm a checkbox-style
  multi-select.
- `--agent <id>` / `--manage <ids>|none` flags are unaffected — no
  prompt at all when a flag is given, exactly as today.
- The existing test-only injection seams (`RunOnboardOptions.
  promptForAgent`/`promptForManagedAgents`) and the string contract
  `parseManagedSelection` parses (comma-separated numbers/ids, or
  `none`) are unchanged — the picker is a drop-in replacement for how
  the *real* prompt functions gather an answer, not for how that answer
  is interpreted afterward.
- Non-TTY stdin (CI, piped input, `--json`) is unaffected — same
  refuse-without-a-flag behavior as today; this change only touches the
  real-terminal code path.
- A terminal that can't support raw-mode/ANSI cursor control falls back
  to the existing numbered-typing prompt rather than hanging or
  corrupting output (see design.md for the exact detection).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `onboarding-flow`: the "Interactive prompt is a numbered choice"
  scenario under "Multiple present agents require an explicit
  base-agent choice", and the numbered-multi-select description in
  "Managed-set selection is a separate, explicit multi-choice", both
  change from typed-number entry to an arrow-key/checkbox picker on a
  real, capable terminal — with a defined fallback when the terminal
  can't support it.

## Impact

- `src/commands/onboard.ts` — `promptForAgentReal`,
  `promptForManagedAgentsReal`.
- A new small terminal-picker module (raw-mode key handling, rendering,
  fallback detection) — location and whether it's hand-rolled or a new
  dependency is a design.md decision.
- `package.json` — only if design.md concludes a dependency is the
  right call.
- `docs/getting-started.md` — screenshot/example update if the
  interactive transcript shown there changes shape.
