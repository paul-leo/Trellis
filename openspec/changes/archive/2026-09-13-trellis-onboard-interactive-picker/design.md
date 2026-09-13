## Context

Today, `promptForAgentReal`/`promptForManagedAgentsReal`
(`src/commands/onboard.ts`) both use `node:readline/promises`'
`rl.question()` — a numbered list is printed, the user types a digit (or
comma-separated digits) and presses Enter. This is the only interactive
surface in the whole CLI; every other command is flag-driven or
non-interactive. `package.json` has exactly one runtime dependency
(`yaml`) — two existing modules (`src/lib/envVarNames.ts`,
`src/lib/secretEnv.ts`) explicitly justify, in their own doc comments,
not pulling in a full library for a narrow need. That precedent applies
directly here.

## Goals / Non-Goals

**Goals:**
- Arrow-key (or j/k) navigation + Enter to confirm, for the
  migration-source single-select.
- The same navigation + Space to toggle + Enter to confirm, checkbox
  style, for the managed-set multi-select.
- Zero change to `--agent`/`--manage` flag behavior, the non-TTY refusal
  path, the test-only prompt-injection seams, or the string contract
  `parseManagedSelection` parses.
- Terminal that can't do raw mode/ANSI falls back to today's exact
  numbered-typing prompt — never hangs, never corrupts output.

**Non-Goals:**
- Search/filter/pagination — the candidate list is at most 4 agents,
  never large enough to need it.
- Any change to how the resolved answer is interpreted downstream
  (`parseManagedSelection`, `resolveManagedAgents`) — only how the
  *real* prompt functions gather that answer changes.
- Windows legacy console support beyond "detect it can't do this,
  fall back" — not chasing full cross-platform terminal parity.

## Decisions

**D1 — hand-roll a minimal raw-mode picker, don't add a dependency.**
Considered `@inquirer/prompts`/`enquirer`/`prompts`. Rejected for now:
the actual interaction surface is narrow and bounded (≤4 rows, no
search, no async validation, no pagination) — exactly the kind of
narrow need `envVarNames.ts`/`secretEnv.ts` already declined a full
library for. A dependency buys cross-platform edge-case coverage this
CLI's actual surface doesn't need yet, at the cost of the same
"trust a library's parse/render round-trip" risk this project has
explicitly avoided elsewhere (see `tomlSection.ts`'s doc comment on why
a general TOML parser was rejected for a bounded, known shape). Revisit
if real terminal-compatibility bug reports pile up post-ship.

**D2 — capability gate, with the existing prompt as the fallback.**
Before rendering the picker: `process.stdin.isTTY && process.stdout.isTTY
&& typeof process.stdin.setRawMode === "function"`. If any part is
false, call the existing (unchanged) `rl.question()`-based numbered
prompt instead — not a new error state, the code path that already
exists today just becomes the fallback branch rather than the only
branch.

**D3 — rendering via raw ANSI escapes, no terminal library.**
Cursor movement/clear-line/highlight written directly via
`process.stdout.write` (`\x1b[<n>A` to move up, `\x1b[2K` to clear a
line, reverse-video `\x1b[7m...\x1b[0m` for the highlighted row). Fixed
viewport — redraw exactly the candidate-list lines in place, no
scrolling, since the list is always small.

**D4 — keybindings.**
Up/Down arrows (`\x1b[A`/`\x1b[B`) and `j`/`k` move the highlight;
`Enter` (`\r`) confirms; multi-select additionally binds `Space` (` `)
to toggle the current row; `Ctrl+C` (`\x03`) cancels cleanly — prints
"cancelled, no changes made" and exits the same way a refusal does
today, rather than falling through to Node's default SIGINT handling.

**D5 — the picker's output is the exact same string contract as today.**
Single-select resolves to `byIndex.agent` (the chosen agent id) exactly
as `promptForAgentReal` returns today. Multi-select resolves to the same
comma-separated 1-based-index string (or `""` for none selected) that
`promptForManagedAgentsReal` returns today, still parsed by the
unchanged `parseManagedSelection`. `RunOnboardOptions.promptForAgent`/
`promptForManagedAgents` (the test-injection seams) and every existing
test using them require zero changes — the picker replaces
`promptForAgentReal`/`promptForManagedAgentsReal`'s internals only.

**D6 — always restore terminal state.**
`process.stdin.setRawMode(true)` at picker start is wrapped in
`try/finally` restoring `setRawMode(false)` and removing the raw
keypress listener before the function returns *or throws* — same
"finally-block cleanup" precedent as the existing `rl.close()` in
`promptForAgentReal`/`promptForManagedAgentsReal` today. A second-layer
`process.once("exit", restore)` safety net covers an unhandled-exception
exit path a `finally` block can't reach.

## Risks / Trade-offs

- [Risk] Hand-rolled raw-mode code is a classic source of "left the
  user's shell in raw mode / cursor hidden" bugs on an unexpected exit
  path. → Mitigation: D6's try/finally plus the `process.once("exit")`
  safety net.
- [Risk] Limited terminal compatibility (legacy Windows console, some
  minimal/embedded TTYs) compared to a maintained library. →
  Mitigation: D2's capability gate falls back to the existing,
  unchanged numbered prompt — never a hard requirement, never a hang.
- [Trade-off] We own arrow-key/ANSI handling ourselves rather than
  leaning on a library's own cross-platform test suite. Accepted:
  matches this project's existing narrow-dependency-free precedent, and
  the actual surface (≤4 items, no search) doesn't need what a full
  library provides.

## Migration Plan

Purely additive to the interactive path only. `--agent`/`--manage` and
every non-TTY path are byte-for-byte unchanged. Nothing written to disk
changes as a result of this change — it only changes how an interactive
answer is *collected*, not what happens with it afterward — so there is
no rollback concern beyond the normal `trellis rollback` coverage of
whatever `onboard` itself goes on to do with that answer.

## Open Questions

- Exact highlight style (reverse-video vs. a leading `>` marker vs.
  both) — a polish decision, finalize during implementation with an eye
  toward staying legible on a plain, colorless terminal too.
