# onboarding-flow Specification

## Purpose
TBD - created by archiving change trellis-cli-onboard. Update Purpose after archive.

## Requirements

### Requirement: `trellis onboard` chains init, agent detection, migrate, and sync into one guided flow

The system SHALL run `trellis init`'s own idempotent bootstrap first, then
probe all five agents directly for their real skill names/count,
instructions presence, and real MCP server count, then resolve three
independent things — a migration **source** (at most one, read-only, may
be none), which migrate **categories** to bring in from that source
(skills, instructions, mcp — any combination, may be none, in which case
migrate is skipped entirely for this run), and a **managed set** (zero or
more agents to write to) — before running, in order, `migrate --from
<source> --only <categories>` (if a source was resolved and at least one
category was selected), `sync`, `mcp sync`, `memory sync`, `secrets
audit`, and a final `trellis doctor`-equivalent health scan, each reusing
its own command's existing plan/apply logic rather than re-implementing
any of it. A user completing onboard SHALL never need to run a further
command by hand to finish it, or to verify it.

#### Scenario: A fresh machine with no canonical source yet gets one, safely
- **WHEN** `trellis onboard` runs and `~/.trellis/` does not exist yet
- **THEN** it is created exactly as `trellis init` alone would create it,
  never overwriting any file that already exists

#### Scenario: Onboard's summary lists everything migrate can act on, including MCP
- **WHEN** a present agent is being summarized before source selection
- **THEN** the summary shows its skill count and names, whether its
  instructions file has real (non-placeholder, non-symlink) content, and
  how many real MCP servers `migrate --only mcp` would find for it — an
  agent with MCP servers but no skills or custom instructions is still a
  valid migration-source candidate on this basis alone

#### Scenario: Completing onboard requires no further manual command
- **WHEN** `trellis onboard` resolves a source and a non-empty managed
  set and completes
- **THEN** its own output already includes migrate, sync, mcp sync,
  memory sync, secrets audit, and health-scan results, terminated by a
  verdict block — not a hint telling the user to run any of them, or
  `trellis doctor`, separately

### Requirement: Migrate category selection is offered only when it's a meaningful choice

The system SHALL offer an interactive checkbox listing exactly the
categories (skills, instructions, mcp) for which the resolved source
agent has real content, pre-checked, on a real, raw-mode-capable
terminal, only when two or more categories have real content. When at
most one category has real content, or no interactive picker is
available, the system SHALL skip the prompt and migrate whichever
category (or categories) actually have content, with no prompt shown.

#### Scenario: A source with two or more real categories offers the checkbox
- **WHEN** the resolved source agent has real content in two or more of
  skills, instructions, and mcp, and stdin/stdout are a real terminal
  capable of raw mode
- **THEN** the command renders a checkbox listing exactly those
  categories that have real content, all pre-checked, lets the user
  toggle any of them with Space, and confirms with Enter

#### Scenario: A source with only one real category skips the prompt
- **WHEN** the resolved source agent has real content in exactly one of
  skills, instructions, or mcp
- **THEN** no category prompt is shown, and migrate runs for that one
  category only

#### Scenario: An MCP-only source is still fully migratable, unprompted
- **WHEN** the resolved source agent has real MCP servers but no real
  skills and no real (non-placeholder, non-symlink) instructions content
- **THEN** no category prompt is shown, and migrate runs with `--only
  mcp` for that agent

#### Scenario: A terminal that can't support the picker migrates every real category, unprompted
- **WHEN** the resolved source has real content in two or more categories
  but the terminal cannot support the interactive picker (or is not a
  TTY at all)
- **THEN** migrate runs for every category that has real content, with
  no prompt shown

### Requirement: Selecting zero categories skips migrate for this run, not an error

The system SHALL treat an empty category selection as an explicit,
valid choice to skip migrate entirely for this run — distinct from no
source having been resolved at all — and SHALL continue on to sync, mcp
sync, and secrets audit for the resolved managed set exactly as if no
source existed.

#### Scenario: Unchecking both categories skips migrate, not the rest of onboard
- **WHEN** the user unchecks both "skills" and "instructions" in the
  category checkbox and confirms
- **THEN** the output states migrate was skipped because no categories
  were selected, and sync/mcp sync/secrets audit still run normally for
  the resolved managed set

### Requirement: Zero present agents surfaces install guidance, never an installer

The system SHALL, when no agent is detected present, print each of the
five supported agents' real install command or download URL and stop,
without spawning any install process itself.

#### Scenario: No agent detected
- **WHEN** `trellis onboard` runs and none of the five agents are
  detected present
- **THEN** the output names each agent's real install command/URL, no
  process is spawned to install anything, and the command exits
  successfully

### Requirement: A single present agent is auto-selected as the migration base

The system SHALL, when exactly one agent is detected present with real
content, use it as the migration source without prompting, stating in
its output that it was chosen automatically and why. This SHALL NOT add
that agent to the managed set — source and managed-set resolution are
independent, per the new managed-set requirement below.

#### Scenario: Exactly one agent present resolves the source, not the managed set
- **WHEN** `trellis onboard` runs and exactly one of the five agents is
  detected present with real content
- **THEN** that agent is used as `migrate --from`'s target with no
  prompt, the output states it was auto-selected, and the managed-set
  prompt/flag resolution still runs independently — the source is not
  implicitly added to `managed.yaml`

### Requirement: Multiple present agents require an explicit base-agent choice

The system SHALL, when two or more agents are detected present with real
content, resolve which one is the migration source via an explicit
`--agent <id>` flag when given, or an interactive picker when stdin/stdout
are a real terminal capable of raw mode and no flag was given, and SHALL
refuse cleanly with no prompt and no guess when neither is available. The
interactive picker SHALL let the user move a highlighted selection with
arrow keys (or j/k) and confirm with Enter; a terminal that cannot support
raw mode SHALL fall back to a numbered-choice text prompt instead of
failing to prompt at all.

#### Scenario: `--agent` resolves the source non-interactively
- **WHEN** two or more agents are present with real content and
  `--agent <id>` names one of them
- **THEN** that agent is used as the source with no interactive prompt

#### Scenario: An unrecognized or absent `--agent` value is a clean refusal
- **WHEN** two or more agents are present with real content and
  `--agent` names an agent that either isn't one of the four supported
  ids or isn't present on this machine
- **THEN** the command refuses, lists the agents that are actually
  present, and performs no writes

#### Scenario: Interactive picker resolves the source on a capable terminal
- **WHEN** two or more agents are present with real content, no
  `--agent` was given, and stdin/stdout are a real terminal capable of
  raw mode
- **THEN** the command renders an arrow-key-navigable list of the
  present candidates, highlights the current selection, and resolves to
  the chosen agent's id when the user presses Enter — with no digit
  typing required

#### Scenario: A terminal that can't support the picker falls back to numbered choice
- **WHEN** two or more agents are present with real content, no
  `--agent` was given, and stdin is a real terminal but cannot support
  raw mode (e.g. `process.stdin.setRawMode` is unavailable)
- **THEN** the command falls back to prompting with a numbered list of
  the present candidates and accepts either the number or the agent's
  id, exactly as before this change

#### Scenario: No prompt possible refuses cleanly
- **WHEN** two or more agents are present with real content, no
  `--agent` was given, and stdin is not a real terminal (including
  `--json` mode, which never prompts regardless of stdin)
- **THEN** the command refuses with a message naming the agents that are
  present and asking for `--agent <id>`, and performs no writes

### Requirement: `--dry-run` previews the entire onboarding flow with zero writes

The system SHALL, when `--dry-run` is given, compute and print the same
init/migrate/sync/mcp-sync plan the real run would produce without
creating, modifying, or deleting any file under `~/.trellis/` (including
`managed.yaml`) or any agent's native configuration. `secrets audit` is
read-only regardless of `--dry-run` and its output is included either way.

#### Scenario: Dry run touches nothing on disk
- **WHEN** `trellis onboard --agent <id> --manage <ids> --dry-run` runs
- **THEN** the output names the planned migrate, sync, and mcp-sync
  actions plus the secrets-audit report, and no file under
  `~/.trellis/` or any agent's native configuration is created, modified,
  or deleted

### Requirement: Managed-set selection is a separate, explicit multi-choice

The system SHALL prompt for which agents to manage as a distinct step
from source resolution — an interactive checkbox picker on a real
terminal capable of raw mode, listing all five agents, present or not,
with whatever's already in `~/.trellis/managed.yaml` pre-checked; a
terminal that cannot support raw mode SHALL fall back to a numbered
multi-select (comma-separated indices) instead of failing to prompt at
all. The resolved source (if any) SHALL be offered like every other
candidate and SHALL start unchecked unless it was already in
`managed.yaml` from an earlier run.

#### Scenario: The source starts unchecked in the managed-set prompt
- **WHEN** claude-code is resolved as the migration source and
  `managed.yaml` does not yet list it
- **THEN** the managed-set prompt lists claude-code as an option but does
  not pre-select it — the user must explicitly include it to have it
  managed

#### Scenario: `--manage` resolves the managed set non-interactively
- **WHEN** `--manage pi,codex` is given
- **THEN** the managed set is exactly `[pi, codex]` for this run, no
  prompt is shown

#### Scenario: `--manage none` is an explicit, intentional empty set
- **WHEN** `--manage none` is given
- **THEN** the managed set is empty for this run — distinct from
  omitting `--manage` entirely, which requires a prompt or refuses

#### Scenario: Interactive checkbox picker resolves the managed set on a capable terminal
- **WHEN** no `--manage` was given and stdin/stdout are a real terminal
  capable of raw mode
- **THEN** the command renders a checkbox-style list of all five agents
  (pre-checked per `managed.yaml`), lets the user move the highlight
  with arrow keys and toggle a row with Space, and resolves to the set
  of checked agents when the user presses Enter — with no digit typing
  required

#### Scenario: A terminal that can't support the picker falls back to numbered multi-select
- **WHEN** no `--manage` was given and stdin is a real terminal but
  cannot support raw mode
- **THEN** the command falls back to the numbered multi-select
  (comma-separated indices) prompt exactly as before this change

#### Scenario: No TTY and no `--manage` refuses cleanly
- **WHEN** stdin is not a real terminal (including any `--json` run) and
  `--manage` was not given
- **THEN** the command refuses, asking for `--manage <ids>` (or
  `--manage none`), and performs no writes

### Requirement: Selecting a not-yet-present agent installs it after one confirmation

The system SHALL, when the managed-set selection includes an agent that
is not currently present and has a real `npm install -g <package>`
command (claude-code, codex, pi), ask for one confirmation and then run
that real install command as a child process before continuing.
Declining leaves that agent out of the managed set for this run rather
than aborting the whole flow. Kiro has no CLI package (a desktop
download) — selecting it while absent SHALL be refused with its real
download URL printed, never attempted as an install.

#### Scenario: Selecting an absent, installable agent installs it after confirmation
- **WHEN** the managed set includes `pi`, pi is not present, and the user
  confirms the install prompt
- **THEN** `npm install -g @earendil-works/pi-coding-agent` runs for
  real, and — once it succeeds — pi is probed again and included in the
  subsequent sync/mcp-sync/secrets-audit stages

#### Scenario: Declining the install excludes that agent, not the whole run
- **WHEN** the managed set includes `pi`, pi is not present, and the user
  declines the install prompt
- **THEN** pi is left out of the managed set for this run; migrate/sync/
  mcp-sync/secrets-audit still run for any other selected, present agents

#### Scenario: Selecting an absent Kiro is refused, never force-installed
- **WHEN** the managed set includes `kiro` and Kiro is not present
- **THEN** the command refuses to add Kiro this run and prints Kiro's
  real download URL instead of attempting any install

#### Scenario: `--json`/non-interactive selection of an absent agent still confirms
- **WHEN** `--manage pi --json` is given and pi is not present
- **THEN** the command refuses rather than installing without a
  confirmation — explicit selection authorizes asking, not skipping the
  ask

### Requirement: Onboard opens one backup session and shares it across its chained sync and mcp-sync stages

The system SHALL, when `trellis onboard` proceeds to its `sync` and
`mcp sync` stages, open exactly one backup session (`trellis-backup-
rollback`) tagged as an `onboard` run, pass it into both stages, and
finalize it once after both complete — never one session per stage.
`--dry-run` SHALL NOT open a session at all, since neither stage performs
any real write to record.

#### Scenario: One onboard run produces one backup, covering both stages
- **WHEN** `trellis onboard` resolves a source and a non-empty managed
  set, and both its `sync` and `mcp sync` stages perform real writes
- **THEN** exactly one run directory appears under
  `~/.trellis/backups/`, and its manifest includes operations from both
  stages

#### Scenario: `trellis rollback` after `onboard` undoes the whole run in one command
- **WHEN** a real (non-dry-run) `trellis onboard` invocation completes and
  the user runs `trellis rollback` with no run id immediately after
- **THEN** every write that onboard's `sync` and `mcp sync` stages made is
  undone by that single `rollback` invocation

#### Scenario: `--dry-run` creates no backup
- **WHEN** `trellis onboard --dry-run` runs
- **THEN** no run directory is created under `~/.trellis/backups/`,
  matching that neither chained stage performed a real write

### Requirement: Onboard runs memory sync as its final chained stage

The system SHALL, after `mcp sync` and before `secrets audit`, run the
same plan/apply logic as `trellis memory sync`'s own standalone command,
scoped to canonical `~/.trellis/memories/*.md` and whatever `memory` MCP
server is (or isn't) configured in `servers.yaml` — independent of the
resolved managed-agent set, since the memory server is shared, not
per-agent. A `memory` server not yet configured in `servers.yaml` SHALL
be reported in onboard's own output with the same explanation memory
sync's standalone command already gives, and SHALL NOT by itself cause
onboard to report failure or a non-zero exit code.

#### Scenario: A configured memory server with new canonical content gets synced
- **WHEN** `servers.yaml` has a `memory` server with
  `static_env.MEMORY_FILE_PATH` set, and `~/.trellis/memories/*.md` has
  content not yet present in that path's on-disk graph
- **THEN** a real (non-dry-run) `trellis onboard` run writes the missing
  entries into that graph file, and the output reports what was added

#### Scenario: No memory server configured is reported, not an error
- **WHEN** `servers.yaml` has no `memory` server with
  `static_env.MEMORY_FILE_PATH` configured
- **THEN** onboard's output states this plainly (the same reason text
  `trellis memory sync` would give on its own), and this alone does not
  make onboard exit non-zero

#### Scenario: `--dry-run` previews memory sync without writing
- **WHEN** `trellis onboard --dry-run` runs and a `memory` server is
  configured
- **THEN** the planned memory-sync actions are printed and the on-disk
  graph file is not created or modified

### Requirement: A real write is followed by a re-plan confirming it took effect

The system SHALL, immediately after `sync`'s and after `mcp sync`'s own
real (non-dry-run) apply, re-run that stage's own plan computation in
dry-run mode against the same home directory and managed-agent set, and
SHALL treat any resulting `"create"` or `"conflict"` item as a blocking
verification failure — not a re-statement of the write, evidence that it
did not hold. Onboard SHALL NOT report a run as successful on the
strength of having written configuration files alone; a successful
report requires the corresponding re-plan to come back empty.

This is distinct from, and does not substitute for, the doctor stage
below: `trellis doctor`'s own detectors compare agents against each
other and never read canonical, so they cannot answer whether a write
took effect — only a re-plan against canonical can.

#### Scenario: A clean run's re-plan comes back empty
- **WHEN** `trellis onboard` completes `sync` and `mcp sync` with no
  conflicts
- **THEN** the immediate re-plan after each stage produces zero
  `"create"` or `"conflict"` items, and this is reflected in the run's
  success

#### Scenario: A write that silently failed to hold is caught
- **WHEN** a real `sync` or `mcp sync` apply reports success, but the
  immediately following dry-run re-plan still finds a `"create"` item
  for something the apply claimed to have written
- **THEN** the run reports this as a blocking verification failure,
  distinct from and in addition to whatever the apply stage itself
  reported, and exits non-zero

#### Scenario: Verification runs against the operated-on home, not the real one
- **WHEN** `trellis onboard` is run with an explicit home directory
- **THEN** the re-plan reads that directory's agent config, and reports
  nothing about any agent configured under the invoking user's real home

### Requirement: Onboard surfaces whole-machine health via doctor, as a secondary check

The system SHALL run the same probe-and-detect logic as `trellis doctor`
as the final stage of `trellis onboard`, after `secrets audit`, scoped
to the real home directory the run operated on, and SHALL include its
findings in the run's own output, labelled as a broader health scan
distinct from the write-verification above.

Onboard's doctor stage SHALL NOT perform MCP handshake probing — it
SHALL run the structural checks only, matching `trellis doctor`'s own
default, since spawning every configured MCP server reaches real
external services with real credentials.

#### Scenario: A clean run ends with a passing health scan
- **WHEN** `trellis onboard` completes every stage with no conflicts and
  the resulting configuration has no drift, duplication, or collisions
- **THEN** the output includes a doctor stage reporting no findings, and
  the run exits zero

#### Scenario: Drift introduced on a managed agent is caught by onboard itself
- **WHEN** a real `trellis onboard` run finishes writing, and the
  resulting state has a finding doctor detects on a managed agent
- **THEN** that finding appears in onboard's own output, without the
  user having to run `trellis doctor` separately

#### Scenario: Onboard never spawns MCP servers to verify
- **WHEN** `trellis onboard` runs against a home with configured stdio
  MCP servers
- **THEN** no configured MCP server process is spawned by the doctor
  stage

#### Scenario: The health scan runs against the operated-on home, not the real one
- **WHEN** `trellis onboard` is run with an explicit home directory
- **THEN** the doctor stage probes that directory, and reports nothing
  about any agent configured under the invoking user's real home

### Requirement: Every run terminates in a verdict that matches its exit code

The system SHALL end every non-`--json` `trellis onboard` run with a
verdict block that is the last thing printed, containing: every blocking
conflict and every warning produced by any stage, a count of each, and a
plain statement of what the run's exit code means. The verdict SHALL be
printed on a fully clean run too, stating plainly that nothing needs
attention.

The run SHALL exit non-zero if and only if at least one blocking item is
present. A warning alone SHALL NOT produce a non-zero exit.

#### Scenario: A conflict is the last thing on screen, not a green line from a later stage
- **WHEN** a run produces a conflict in an early stage (e.g. `sync`) and
  every later stage reports nothing wrong
- **THEN** the final output is the verdict naming that conflict, not the
  later stage's success line, and the exit code is non-zero

#### Scenario: A clean run says so explicitly
- **WHEN** every stage completes with no conflicts and no findings
- **THEN** the verdict states that nothing needs attention, and the exit
  code is zero

#### Scenario: Warnings alone do not fail the run
- **WHEN** the only items produced are warnings (e.g. no `memory` server
  configured, or drift on an agent Trellis does not manage)
- **THEN** they appear in the verdict under a heading distinguishing
  them from blocking items, and the run exits zero

#### Scenario: Findings about an unmanaged agent are shown but labelled
- **WHEN** the verification stage reports a finding about an agent that
  is not in the managed set
- **THEN** the verdict shows it, marks it as concerning an unmanaged
  agent, and does not let it alone make the run exit non-zero

### Requirement: A reported conflict states the action that resolves it

The system SHALL accompany each blocking conflict in the verdict with a
concrete next action, distinct from a restatement of the problem, and
SHALL abbreviate a path under the operated-on home directory to a
`~`-prefixed form rather than printing it absolute.

#### Scenario: An existing non-Trellis file explains how to proceed
- **WHEN** `sync` reports a conflict because an agent's instructions
  file already exists and is not a Trellis-managed symlink
- **THEN** the verdict's entry for it names what to do about that file,
  not only that it was left untouched

#### Scenario: Paths under home are abbreviated
- **WHEN** a conflict names a path inside the home directory the run
  operated on
- **THEN** the verdict prints it with that prefix replaced by `~`

### Requirement: Stage progress is reported as the run proceeds, separately from the report

The system SHALL, when stdout is an interactive terminal and `--json` is
not set, emit a progress line naming each stage as it begins, including
its position in the total stage count. Progress output SHALL go to
stderr, leaving stdout carrying only the report itself.

#### Scenario: Redirecting stdout captures the report without progress noise
- **WHEN** a run's stdout is redirected to a file
- **THEN** that file contains the stage reports and the verdict, and no
  progress lines

#### Scenario: Non-interactive runs emit no progress
- **WHEN** `--json` is set, or stdout is not a TTY
- **THEN** no progress lines are emitted at all

### Requirement: A dry run offers to apply, and declining is the default

The system SHALL, at the end of a `--dry-run` on a real interactive
terminal, offer to perform the same run for real, with declining
selected by default so that confirming requires a deliberate choice.
Accepting SHALL re-plan rather than apply the already-computed plan.
`--json` runs and non-interactive terminals SHALL NOT be offered
anything and SHALL behave exactly as they do today.

#### Scenario: Declining leaves nothing written
- **WHEN** a `--dry-run` on a TTY ends and the offer is declined
- **THEN** nothing is written, and the exit code is what the dry run
  itself produced

#### Scenario: Accepting performs a fresh run, not a replay of the preview
- **WHEN** the offer is accepted
- **THEN** the flow runs again with writes enabled, re-resolving the
  plan against current state rather than applying the plan computed
  before the user read it

#### Scenario: A non-interactive dry run is unchanged
- **WHEN** `trellis onboard --dry-run --json` runs, or stdin/stdout is
  not a TTY
- **THEN** no offer is made and the output is exactly the dry run's own

### Requirement: `--json` exposes the verdict as structured data, additively

The system SHALL include the normalized verdict items in `--json`
output as a single array, each carrying its stage, severity, message,
and remediation where one exists. No existing field in `--json` output
SHALL change meaning or be removed by this change.

#### Scenario: A machine consumer reads one array instead of five report shapes
- **WHEN** `trellis onboard --json` runs and produces conflicts across
  more than one stage
- **THEN** every one of them appears in the single verdict array, each
  labelled with the stage it came from

#### Scenario: Existing consumers keep working
- **WHEN** a consumer reads any field that existed in `--json` output
  before this change
- **THEN** that field is present and means what it meant before

### Requirement: Interactive onboarding uses a styled prompt adapter

The system SHALL use one shared interaction adapter backed by a maintained
prompt library for source-agent selection, managed-agent selection, migration
category selection, and dry-run confirmation on a capable TTY. The adapter
SHALL return the same domain values as the existing orchestration contracts.

#### Scenario: Source selection uses a colored select prompt

- **WHEN** multiple present agents require a source choice on a capable TTY
- **THEN** onboarding shows a colored single-select prompt with concise agent
  summaries and returns the selected agent id after confirmation

#### Scenario: Managed selection uses a colored multiselect prompt

- **WHEN** the managed set is not supplied by `--manage` on a capable TTY
- **THEN** onboarding shows all five supported agents with aggregate status and
  returns the checked agent ids after confirmation

#### Scenario: Category selection only shows real categories

- **WHEN** the source has two or more real migration categories
- **THEN** the multiselect lists exactly those categories and no unrelated
  skill/server names

### Requirement: Interactive rendering does not change automation contracts

The system SHALL not initialize the prompt library for `--json`, piped input,
or a non-TTY invocation. Interactive chrome SHALL be written to stderr, while
reports and JSON payloads SHALL remain on stdout. Existing numbered fallbacks
and explicit refusal behavior SHALL remain unchanged.

#### Scenario: JSON output contains no prompt escape sequences

- **WHEN** `trellis onboard --json` runs
- **THEN** stdout is valid JSON and contains no interactive prompt or spinner
  output

#### Scenario: Non-TTY uses the existing fallback

- **WHEN** onboarding receives non-TTY input without enough explicit flags
- **THEN** it uses the existing numbered fallback or clean refusal and performs
  no guessed selection

### Requirement: Agent summaries are progressively disclosed

The system SHALL show agent identity, presence, aggregate skill/MCP counts, and
brief health status in onboarding choices. It SHALL NOT list individual skill
names in the interactive picker.

#### Scenario: A large skill set stays compact

- **WHEN** an agent has many skills
- **THEN** the prompt shows a count such as `36 skills` and remains within the
  terminal layout without enumerating skill names

### Requirement: Prompt cancellation is safe

The system SHALL restore terminal input state on cancellation or error, print a
clear cancellation message, and perform no canonical or agent configuration
writes.

#### Scenario: Ctrl+C during a prompt

- **WHEN** the user cancels any onboarding prompt
- **THEN** the terminal is restored, onboarding exits through its existing
  cancellation path, and no write plan is applied

### Requirement: Onboarding SHALL select individual capabilities

The system SHALL build an item-level inventory for skills, MCP servers, and
available memory entries before applying migration. On a capable TTY it SHALL
offer searchable multiselects; in non-interactive mode it SHALL accept explicit
lists or a selection file. Existing category-level flags SHALL remain valid.

#### Scenario: Select only a subset of skills

- **WHEN** the source exposes four skills and the user selects two
- **THEN** only those two are planned for canonical migration, while the other
  two remain untouched

#### Scenario: Select only a subset of MCP servers

- **WHEN** the source exposes six MCP servers and the user selects two
- **THEN** only those two are imported, synced, and verified

#### Scenario: A conflict affects one item only

- **WHEN** one selected skill conflicts with canonical and another selected MCP
  server is clean
- **THEN** the skill is reported as a conflict and the MCP server still follows
  its own plan

### Requirement: Onboarding SHALL resolve MCP routing per managed agent

The system SHALL allow each managed agent to use `direct`, `gateway`, or `hub`
delivery. Direct and gateway routes SHALL support a selected MCP subset. A
gateway SHALL expose only the upstream servers selected for that agent. A hub
route SHALL select the external endpoint but SHALL report that tool-level
filtering is owned by the external hub. Existing shorthand fields SHALL remain
backwards compatible.

#### Scenario: Codex uses gateway for a subset while Claude uses direct

- **WHEN** Codex is assigned gateway mode for `figma` and `mcp-router`, and
  Claude Code is assigned direct mode for `tanka`
- **THEN** Codex receives one gateway entry whose upstream set is exactly the
  two selected servers, while Claude receives only the direct `tanka` entry

#### Scenario: Existing gateway shorthand remains valid

- **WHEN** canonical has the existing `gateway.enabled` configuration and no
  explicit route map
- **THEN** the current gateway behavior is preserved without requiring a
  migration of the canonical file

### Requirement: Onboarding SHALL report unsupported memory sources explicitly

The system SHALL distinguish canonical memories, provider-backed runtime
memories, and native agent memory formats. It SHALL not represent an
unsupported native memory reader as an empty successful selection.

#### Scenario: Native memory has no reader

- **WHEN** a source agent has a private memory store with no Trellis reader
- **THEN** the inventory reports it as unsupported with an actionable message,
  and does not silently claim that the source has no memory

### Requirement: Re-running onboarding SHALL preserve item selection and routes

The system SHALL treat omitted fine-grained selections as “preserve current
canonical state”. Re-running onboarding SHALL not re-import previously
unselected items or reset per-agent MCP routes.

#### Scenario: Bare re-run is a no-op for selection

- **WHEN** a prior run selected two skills and assigned Codex gateway mode to
  two MCP servers, and the next run supplies no selection flags
- **THEN** the same desired state is retained and no unrelated item is added

### Requirement: MCP mode is resolved once per run, unchanged unless explicitly requested

The system SHALL support `--mcp-mode <direct|hub|gateway>` on `trellis
onboard`, with `--hub-url <url>` required when `--mcp-mode hub` is given
and `--gateway-agents <ids>` optional when `--mcp-mode gateway` is given
(omitted meaning every managed agent). When `--mcp-mode` is omitted
entirely, the run SHALL leave the mode already recorded in canonical
untouched and SHALL NOT prompt for one — this SHALL hold identically
whether canonical currently has no mode configured (a first run) or an
already-configured one (a later run), so that omitting the flag has one
consistent meaning regardless of which run this is.

Setting a mode SHALL be mutually exclusive with the other two: selecting
`hub` SHALL clear any existing `gateway` configuration and selecting
`gateway` SHALL clear any existing `hub` configuration; selecting
`direct` SHALL clear both.

`--hub-url` or `--gateway-agents` given without their matching
`--mcp-mode` value, or `--mcp-mode hub` given without `--hub-url`, SHALL
refuse the entire run rather than silently ignoring the flag or falling
back to a default.

#### Scenario: Omitting the flag on a fresh machine preserves the default
- **WHEN** `trellis onboard` runs with no `--mcp-mode` against a home
  where `servers.yaml` has no `hub`/`gateway` keys
- **THEN** the run proceeds in direct mode, unchanged, and no `hub`/
  `gateway` key is written

#### Scenario: Omitting the flag on a later run preserves what's already set
- **WHEN** `trellis onboard` runs with no `--mcp-mode` against a home
  where `servers.yaml` already has `gateway: { enabled: true }` from an
  earlier run
- **THEN** the run proceeds with gateway mode unchanged, and no write to
  `hub`/`gateway` occurs

#### Scenario: `--mcp-mode gateway` enables gateway mode for every managed agent
- **WHEN** `trellis onboard --mcp-mode gateway` runs with no
  `--gateway-agents`
- **THEN** `servers.yaml` is written with `gateway: { enabled: true }`
  and no `agents` key, and any existing `hub` key is removed

#### Scenario: `--mcp-mode gateway --gateway-agents` narrows to specific agents
- **WHEN** `trellis onboard --mcp-mode gateway --gateway-agents
  codex,pi` runs
- **THEN** `servers.yaml`'s `gateway.agents` is written as exactly
  `[codex, pi]`

#### Scenario: `--mcp-mode hub` without `--hub-url` refuses cleanly
- **WHEN** `trellis onboard --mcp-mode hub` runs with no `--hub-url`
- **THEN** the command refuses before writing anything, naming
  `--hub-url` as required

#### Scenario: `--mcp-mode hub --hub-url` writes the hub entry and clears gateway
- **WHEN** `trellis onboard --mcp-mode hub --hub-url
  https://hub.example.com` runs against a home with an existing
  `gateway: { enabled: true }`
- **THEN** `servers.yaml` is written with `hub: { url:
  https://hub.example.com }` and the `gateway` key is removed

#### Scenario: `--mcp-mode direct` clears both hub and gateway
- **WHEN** `trellis onboard --mcp-mode direct` runs against a home with
  an existing `hub` key
- **THEN** `servers.yaml`'s `hub` key is removed and no `gateway` key is
  written

#### Scenario: A stray mode-specific flag without its mode refuses
- **WHEN** `trellis onboard --hub-url https://hub.example.com` runs with
  no `--mcp-mode`
- **THEN** the command refuses rather than silently ignoring `--hub-url`

### Requirement: MCP mode changes go through Trellis's own writer, never hand-edited

The system SHALL provide a canonical writer for the top-level `hub`/
`gateway` keys in `servers.yaml` that preserves every other key's
existing formatting, matching the guarantee `upsertServerYaml` already
provides for individual server entries. The writer SHALL refuse (no
write) if `servers.yaml` does not exist or fails to parse, matching
`upsertServerYaml`'s existing refusal posture.

#### Scenario: An unrelated hand-authored comment survives a mode change
- **WHEN** `servers.yaml` has a comment above its `servers:` key and
  `trellis onboard --mcp-mode gateway` runs
- **THEN** the comment is still present afterward, unchanged

#### Scenario: A missing servers.yaml refuses instead of creating one implicitly
- **WHEN** `--mcp-mode` is given against a home where `~/.trellis/mcp/
  servers.yaml` does not exist
- **THEN** the command refuses, naming `trellis init` as the next step,
  the same message shape `upsertServerYaml` already produces for a
  missing file

### Requirement: The resolved MCP mode is reported without requiring a prompt

The system SHALL, on a non-`--json` run with stdout a real terminal,
print the mode the run resolved to and, when `--mcp-mode` was not given,
name the flag that would change it — informational only, never a
prompt requiring a keystroke to proceed. `--json` output SHALL include
the resolved mode and whether this run changed it, additively, with no
existing field changing meaning.

#### Scenario: An unchanged run still states the mode
- **WHEN** `trellis onboard` runs interactively with no `--mcp-mode`
- **THEN** the output includes a line stating the current mode and that
  `--mcp-mode` is how to change it, without waiting for any input

#### Scenario: A changed run states what changed
- **WHEN** `trellis onboard --mcp-mode gateway` runs against a home
  previously in direct mode
- **THEN** the output states the mode changed from direct to gateway

#### Scenario: `--json` exposes the resolved mode structurally
- **WHEN** `trellis onboard --mcp-mode hub --hub-url
  https://hub.example.com --json` runs
- **THEN** the JSON output includes the resolved mode and `changed:
  true`, alongside every field `--json` already produced before this
  change

#### Scenario: Non-interactive runs print no status line
- **WHEN** `--json` is set, or stdout is not a TTY
- **THEN** no mode status line is printed to stdout

### Requirement: The shared memory server is toggled once per run, unchanged unless explicitly requested

The system SHALL support `--memory <on|off>` on `trellis onboard`. When
omitted, the run SHALL leave `mcp.servers["memory"]` exactly as canonical
already has it — absent on a machine where it was never configured,
present on one where it already was — and SHALL NOT prompt for it,
identically on a first run and a later one.

`--memory on` SHALL write the default memory server definition
(`@modelcontextprotocol/server-memory`, with `static_env.MEMORY_FILE_PATH`
set) unless `"memory"` already exists in `mcp.servers` (a no-op) or
`"memory"` is listed in `known_host_injected`, in which case the run
SHALL refuse rather than write a definition that a later `mcp sync` would
refuse to propagate to any agent. `--memory off` SHALL remove the
`"memory"` entry from `servers.yaml` if present, and SHALL be a no-op if
it is already absent.

This resolution SHALL run before onboard's own `mcp sync` and `memory
sync` stages in the same run, so that enabling memory, syncing it to
every managed agent's native config, and populating it from canonical
`memories/*.md` all complete within one `trellis onboard --memory on`
run.

#### Scenario: Omitting the flag on a fresh machine leaves memory unconfigured
- **WHEN** `trellis onboard` runs with no `--memory` against a home
  where `servers.yaml` has no `"memory"` entry
- **THEN** the run proceeds with no memory server configured, and no
  write to `servers.yaml` occurs for it

#### Scenario: Omitting the flag on a later run preserves an already-enabled memory server
- **WHEN** `trellis onboard` runs with no `--memory` against a home where
  `servers.yaml` already has a `"memory"` entry from an earlier run
- **THEN** the run proceeds with that entry unchanged, and no write is
  attempted

#### Scenario: `--memory on` enables the default server and it reaches every agent in the same run
- **WHEN** `trellis onboard --memory on` runs against a home with no
  `"memory"` entry and no `"memory"` in `known_host_injected`
- **THEN** `servers.yaml` gains a `"memory"` entry with
  `static_env.MEMORY_FILE_PATH` set, and the same run's `mcp sync` stage
  writes it into every managed agent's native config

#### Scenario: `--memory on` populates the graph from canonical memories in the same run
- **WHEN** `trellis onboard --memory on` runs against a home with at
  least one file under `~/.trellis/memories/` and no prior `"memory"`
  entry
- **THEN** the same run's `memory sync` stage — previously a no-op on
  this home for lack of a configured server — writes that content into
  the graph file

#### Scenario: `--memory on` refuses when a host already injects a memory connector
- **WHEN** `trellis onboard --memory on` runs against a home where
  `known_host_injected` already lists `"memory"`
- **THEN** the command refuses before writing anything, explaining that a
  host on this machine is presumed to already inject a memory connector
  under that name

#### Scenario: `--memory off` removes an existing entry
- **WHEN** `trellis onboard --memory off` runs against a home with an
  existing `"memory"` entry
- **THEN** `servers.yaml`'s `"memory"` entry is removed

#### Scenario: `--memory off` on an already-absent entry is a no-op, not an error
- **WHEN** `trellis onboard --memory off` runs against a home with no
  `"memory"` entry
- **THEN** the run completes with `changed: false` and no write is
  attempted

#### Scenario: A TTY run states the memory status without prompting
- **WHEN** `trellis onboard` runs interactively with no `--memory`
- **THEN** the output includes a line stating whether memory is on or
  off and that `--memory` is how to change it, without waiting for any
  input

#### Scenario: `--json` exposes the resolved memory state structurally
- **WHEN** `trellis onboard --memory on --json` runs
- **THEN** the JSON output includes the resolved memory state and
  `changed: true`, alongside every field `--json` already produced
  before this change

### Requirement: Onboarding can select Kimi Runtime delivery

The system SHALL include Kimi Code in Agent summaries and allow a capability
selection to choose Kimi's Runtime delivery independently of other Agents.

#### Scenario: Kimi is selected without native Skill projection

- **WHEN** onboarding selects `kimi-code` with Runtime-only delivery
- **THEN** Kimi receives the Runtime MCP projection and no native Skill sync
  plan is generated for Kimi

### Requirement: Onboarding discovers and manages ZCode

The system SHALL include ZCode in onboarding summaries, migration-source
selection, managed-agent selection, and capability-delivery reporting. For a
compatible profile it SHALL recommend Runtime delivery and disclose whether
CLI execution is available.

#### Scenario: Compatible local ZCode is selected during onboarding
- **WHEN** onboarding finds a compatible public ZCode CLI
- **THEN** the user can add `zcode` to the managed set and sees Runtime
  delivery as the recommended capability mode
