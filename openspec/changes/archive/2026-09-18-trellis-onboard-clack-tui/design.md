# Design: Clack-backed onboarding interaction

## Context

The primary users are developers who run `trellis onboard` on a real terminal
to bring several coding agents under management. They need to reach a usable
managed state quickly, understand what will happen, and retain the final
report for inspection. The interaction should feel like a precise developer
tool: quiet when it is working, colored only when color communicates state,
and never dependent on a full-screen alternate buffer.

## Decisions

### D1 — Use `@clack/prompts`, not a full-screen TUI runtime

Clack provides the exact bounded controls onboard needs: select,
multiselect, confirmation, spinner/task progress, logs, and cancellation. It
also supports custom input/output streams, which preserves the existing test
seam. OpenTUI is intentionally not used: it introduces a native Zig/FFI
runtime and currently requires a newer Node runtime than Trellis supports.
Ink is also out of scope because a React renderer is disproportionate for a
short-lived wizard.

### D2 — Keep a Trellis interaction adapter

`onboard.ts` must not import Clack prompt functions throughout its orchestration
logic. A small adapter exposes the semantic operations Trellis needs:

- `selectAgent`
- `selectAgents`
- `selectMigrationCategories`
- `confirmApply`
- `runTask` / stage status helpers

The adapter owns cancellation, stream selection, and value normalization. This
keeps the current business contracts (`AgentId`, `MigrateKind[]`, and boolean
confirmation) stable and leaves room for another renderer later.

### D3 — Interactive output goes to stderr

Prompt chrome, spinners, and progress indicators write to stderr. The
existing report and `--json` payload remain on stdout. This preserves
`trellis onboard > report.txt` and makes piping behavior deterministic.

`--json` never initializes Clack. Non-TTY execution never initializes Clack
either; it keeps the existing numbered fallback or clean refusal behavior.

### D4 — Semantic color, plain-text fallback

Use Clack's default theme for:

- cyan/strong emphasis for the active choice,
- green for completed stages,
- yellow for warnings and optional actions,
- red for cancellation or blocking findings.

The prompt text must still contain clear markers and words so terminals that
strip ANSI escape sequences remain understandable. No raw ANSI cursor math
remains in Trellis-owned onboarding code.

### D5 — Progressive disclosure for agent summaries

Agent choices display only identity, presence, and aggregate counts, such as
`claude-code · 36 skills · 6 MCP`. They never enumerate skill names inside a
picker. Detailed names remain available through explicit list/doctor commands.

### D6 — Preserve first-run and Nth-run semantics

The renderer changes only how choices are presented. Existing rules remain:

- explicit flags bypass prompts;
- an omitted choice preserves current state where the command already has that
  meaning;
- a non-interactive invocation never guesses a source or managed set;
- cancellation performs no writes and returns the existing cancellation result.

### D7 — Test observable prompt contracts

Tests use Clack's custom stream support through the Trellis adapter. They assert
resolved values, cancellation, no-prompt behavior for JSON/non-TTY, and the
presence of semantic status markers. They do not assert terminal cursor escape
sequences or exact spinner frames.

## Flow

```text
onboard orchestration
        │ semantic choices
        ▼
Trellis interaction adapter
        ├── TTY + text mode  ──> @clack/prompts on stderr
        ├── non-TTY           ──> numbered fallback / refusal
        └── --json             ──> no prompt, structured stdout
```

## Risks and mitigations

- Clack updates could change visual output: pin the package range and test
  semantic behavior through the adapter.
- A prompt library could accidentally write to stdout: inject stderr as the
  default interactive output and add a regression test for JSON/report output.
- A raw-mode cleanup regression could leave the terminal unusable: rely on
  Clack cleanup and add a child-process cancellation smoke test.
- Long labels could wrap: truncate aggregate labels to the terminal width or
  use Clack's own layout behavior; never reintroduce hand-written row erasure.

## Open questions

None for this change. A separate full-screen `trellis tui` command can be
considered later if status dashboards become a product requirement.
