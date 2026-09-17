## 1. Prompt dependency and adapter

- [x] 1.1 Add pinned `@clack/prompts` runtime dependency and regenerate the lockfile.
- [x] 1.2 Replace raw picker internals with a Trellis interaction adapter backed by Clack.
- [x] 1.3 Preserve stream injection, cancellation, and non-TTY detection at the adapter boundary.
- [x] 1.4 Route interactive output to stderr and keep report/JSON output on stdout.

## 2. Onboarding integration

- [x] 2.1 Wire source-agent selection through the adapter.
- [x] 2.2 Wire managed-agent multiselect through the adapter.
- [x] 2.3 Wire migration-category multiselect through the adapter.
- [x] 2.4 Wire dry-run apply confirmation through the adapter.
- [x] 2.5 Keep explicit flags and first/Nth-run idempotency behavior unchanged.
- [x] 2.6 Render compact aggregate agent labels without skill-name enumeration.

## 3. Verification

- [x] 3.1 Add adapter tests for select, multiselect, cancellation, and custom streams.
- [x] 3.2 Existing onboarding tests prove JSON and non-TTY paths never enter interactive selection; keep them green.
- [x] 3.3 Existing progress/report tests prove interactive chrome does not contaminate stdout; keep them green.
- [x] 3.4 Run the full suite, typecheck, build, and package verification.
- [x] 3.5 Verify the compiled CLI on a scratch home and one real TTY session.

## 4. Documentation

- [x] 4.1 Update the onboarding walkthrough with the new prompt controls and
      compact status display.
- [x] 4.2 Record the TUI decision in the roadmap and onboarding documentation.
