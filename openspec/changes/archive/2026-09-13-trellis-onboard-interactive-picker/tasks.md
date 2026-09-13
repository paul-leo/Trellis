## 1. Terminal picker module

- [x] 1.1 New module (`src/lib/terminalPicker.ts`): capability
      detection (`isTTY` on both stdin/stdout + `setRawMode` presence)
- [x] 1.2 Single-select renderer: print candidate list, highlight
      current row (reverse-video), redraw in place on Up/Down/j/k
- [x] 1.3 Multi-select renderer: same navigation + checkbox state per
      row, toggled with Space
- [x] 1.4 Keypress handling: arrows, j/k, Enter (confirm), Space
      (multi-select toggle), Ctrl+C (clean cancel)
- [x] 1.5 `try/finally` restoring raw mode + removing the keypress
      listener; `process.once("exit", ...)` safety-net restore

## 2. Wire into onboard

- [x] 2.1 `promptForAgentReal`: capability check → picker or existing
      numbered `rl.question()` fallback (renamed `promptForAgentNumbered`),
      unchanged either way in what string it returns
- [x] 2.2 `promptForManagedAgentsReal`: same, checkbox picker or
      existing numbered multi-select fallback (renamed
      `promptForManagedAgentsNumbered`)
- [x] 2.3 Confirmed `RunOnboardOptions.promptForAgent`/
      `promptForManagedAgents` and `parseManagedSelection` need zero
      changes — full existing test suite (250 tests) passes unmodified

## 3. Cancel handling

- [x] 3.1 Ctrl+C during either picker prints "cancelled, no changes
      made" and exits directly (`process.exit(1)`) rather than Node's
      default SIGINT behavior or threading a new state through onboard's
      return-based refusal plumbing

## 4. Tests

- [x] 4.1 Unit tests for the picker module itself: navigation wrapping,
      toggle state, confirm resolves the expected value, cancel resolves
      distinctly (`test/unit/terminalPicker.test.ts`, 15 tests)
- [x] 4.2 Existing `onboard.test.ts` suite passes unmodified (proves the
      seam/contract preservation from design.md D5) — full suite is
      265/265 (was 250; +15 from terminalPicker.test.ts), zero changes
      to onboard.test.ts itself
- [x] 4.3 Fallback path: `git diff` against the pre-change
      `promptForAgentReal`/`promptForManagedAgentsReal` confirms
      `promptForAgentNumbered`/`promptForManagedAgentsNumbered` are
      behaviorally identical (the only change is extracting one
      duplicated console.log line into the shared `agentSummaryLabel()`
      helper, same output string). **Not** covered by a new automated
      end-to-end test: both numbered functions hardcode
      `process.stdin`/`process.stdout` via `createInterface` (pre-existing,
      not introduced by this change), so driving them requires either a
      real TTY with piped answers or refactoring them to accept
      injectable streams — out of scope here since that would touch
      already-shipped, unchanged code just to make it newly testable.
      Confidence rests on code-identity, not a new test.

## 5. Manual/sandboxed verification

- [ ] 5.1 `scripts/sandbox.sh` interactive run: exercise both pickers by
      hand against `test/fixtures/home`'s multi-agent fixture — **needs a
      human at a real terminal**; a Docker-exec'd shell through this
      session's tooling is not a real pty, so raw-mode behavior can't be
      honestly verified here. Left open for the user to run by hand.
- [ ] 5.2 Verify terminal state is clean after a normal confirm, after
      Ctrl+C cancel, and after forcing an error mid-picker — same
      real-terminal requirement as 5.1, left open.

## 6. Documentation

- [x] 6.1 Updated `docs/getting-started.md`'s onboarding walkthrough:
      both bullets now describe the arrow-key/checkbox picker as the
      primary interactive path, numbered typing as the explicit
      fallback (previously said "numbered choice" / "numbered
      multi-select prompt" unconditionally, which became inaccurate)
