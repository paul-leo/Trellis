# Replace the hand-rolled onboarding picker with Clack prompts

## Why

`trellis onboard` currently owns a small raw-mode picker in
`src/lib/terminalPicker.ts`. It has already accumulated terminal-specific
rendering bugs: wrapped rows previously left stale content behind, and
highlighting was difficult to see in terminals that handled reverse-video
poorly. Onboarding also mixes numbered fallback prompts with ANSI redraw
logic, so every new interactive step increases the maintenance surface.

The project needs a polished, colored prompt experience while preserving the
properties that make `onboard` safe to automate: no prompt in `--json` or
non-TTY mode, injectable streams for tests, and a final report that remains in
terminal scrollback.

## What changes

- Add `@clack/prompts` as the runtime prompt dependency.
- Replace the low-level picker implementation with a small Trellis interaction
  adapter around Clack's select, multiselect, confirm, spinner/task, and log
  primitives.
- Keep the current numbered fallback for terminals that cannot support an
  interactive prompt, and keep all non-interactive behavior unchanged.
- Render interactive chrome to stderr so stdout remains suitable for reports
  and machine-readable output.
- Use semantic colors and concise agent summaries. Agent labels show counts and
  health, never every skill name.
- Keep onboarding as a scrollback-oriented prompt flow; this change does not
  introduce a full-screen dashboard.

## Capabilities

### Modified Capabilities

- `onboarding-flow`: the interactive source, managed-agent, category, and
  dry-run confirmation prompts use a shared styled prompt adapter while their
  choices and non-TTY behavior remain compatible.

## Impact

- `src/lib/terminalPicker.ts` or its replacement adapter
- `src/commands/onboard.ts`
- `src/cli.ts` only if help text needs an interaction note
- `test/unit/terminalPicker.test.ts` and `test/unit/onboard.test.ts`
- `package.json` and `package-lock.json`
- `docs/getting-started.md` and `docs/roadmap.md`

No canonical data, agent configuration, memory provider, or MCP gateway
behavior changes in this change.
