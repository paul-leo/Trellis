# Spec Delta

## Purpose

Let users add and update GitHub-hosted Agent Skills with familiar CLI syntax
while retaining Trellis as the sole persistent source and delivery authority.

## ADDED Requirements

### Requirement: Remote Skill add accepts a GitHub source and named Skill

The system SHALL provide `trellis add <source> --skill <name>`, where
`<source>` is GitHub `owner/repository` shorthand or an HTTPS GitHub
repository URL. It SHALL discover the named Skill by its directory containing
an exact-case `SKILL.md`, then import that complete directory into
`~/.trellis/skills/<name>/`.

#### Scenario: A nested named Skill is imported
- **WHEN** a user runs `trellis add mattpocock/skills --skill loop-me` and
  the repository contains `skills/in-progress/loop-me/SKILL.md`
- **THEN** Trellis imports the complete `loop-me` directory into its canonical
  Skill store and reports the resolved source subdirectory

#### Scenario: A source contains no matching named Skill
- **WHEN** the selected source contains no exact matching Skill directory
- **THEN** the command exits non-zero, names the available Skill names, and
  creates no canonical Skill or provenance record

### Requirement: Remote content is fetched without execution and validated before import

The system SHALL fetch remote source content into temporary storage, never
execute files, install dependencies, or invoke source-provided scripts. It
SHALL reject a selected Skill whose entry file is missing, has the wrong case,
or resolves outside the fetched repository through a symbolic link.

#### Scenario: A repository contains an executable helper script
- **WHEN** a selected Skill directory includes a script or executable file
- **THEN** Trellis copies it as Skill content and does not execute it during
  discovery, import, or validation

#### Scenario: A Skill entry escapes the fetched repository
- **WHEN** a selected `SKILL.md` is a symbolic link whose resolved target lies
  outside the fetched repository
- **THEN** Trellis refuses the import with no canonical write

### Requirement: A remote import remains within the managed Agent boundary

The system SHALL treat an omitted `--agent` selector as an unscoped canonical
Skill, reaching the current managed set. `--agent <ids>` SHALL record the
named managed Agent ids as the Skill scope; `--agent '*'` SHALL resolve to the
current managed set. A requested id outside the managed set SHALL cause the
command to refuse before writing.

#### Scenario: A scoped remote Skill reaches only its selected managed Agent
- **WHEN** `trellis add owner/repo --skill review --agent zcode` succeeds and
  ZCode is managed
- **THEN** sync delivers the Skill only through ZCode's applicable native or
  Runtime path

#### Scenario: An unmanaged target is refused
- **WHEN** a user requests `--agent codex` while Codex is not managed
- **THEN** Trellis exits non-zero and leaves canonical content and Agent files
  unchanged

### Requirement: Remote Skill provenance is durable and reproducible

The system SHALL record each imported remote Skill in
`~/.trellis/skills.lock.json` with its canonical Skill name, normalized source
URL, requested branch or ref, resolved immutable commit, source subdirectory,
and digest of the imported directory. The record SHALL never contain a
credential or a local absolute path.

#### Scenario: A GitHub default branch is resolved to a commit
- **WHEN** a user imports a Skill without passing `--branch`
- **THEN** the lock records the default requested ref and the exact resolved
  commit used for the canonical content

#### Scenario: Canonical content collides with a different source
- **WHEN** a canonical Skill exists with different content or an incompatible
  provenance record
- **THEN** Trellis reports a conflict and does not overwrite the Skill or its
  provenance record

### Requirement: Tracked remote Skills can be checked and updated safely

The system SHALL provide `trellis update [skills...]` for remote Skills with
provenance records. It SHALL compare fetched content with the lock and the
current canonical directory, report a plan, and update only when canonical
content still matches the locked digest. Existing Skill scope SHALL survive an
update.

#### Scenario: A remote change produces an update plan
- **WHEN** a tracked source resolves to a newer commit with changed selected
  Skill content and canonical content still matches its lock digest
- **THEN** `trellis update <name> --dry-run` reports the incoming commit and
  no local file is changed

#### Scenario: A local canonical edit blocks remote replacement
- **WHEN** a user has edited a tracked canonical Skill since its last import
- **THEN** `trellis update <name>` reports a conflict and leaves that Skill and
  its lock entry intact

### Requirement: Compatibility flags retain Trellis ownership semantics

The remote add command SHALL accept `--branch`, `--skill`, `--agent`,
`--global`, `--yes`, `--dry-run`, and `--json`. `--global` SHALL mean the
existing user-level Trellis canonical store. The command SHALL reject
project-local installation and `--copy`, because either would create a Skill
source outside Trellis canonical ownership.

#### Scenario: A skills-CLI-shaped global command stays canonical
- **WHEN** a user runs `trellis add owner/repo --skill review --global`
- **THEN** the Skill is imported into `~/.trellis/skills/` and not into
  `~/.agents/skills/` or a project directory
