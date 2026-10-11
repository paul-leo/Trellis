# Design

## Context

See `proposal.md` for motivation. Today `migrate` plans Skills, instructions,
and MCP only. `onboard` can enable the shared Memory MCP backend, but its
`memory sync` stage only consumes canonical Markdown; it does not read a
source Agent's native memory. The local machine confirms that Claude Code has
Markdown project-memory directories, while Kimi/pi expose sessions rather than
a documented memory file format.

## Goals / Non-Goals

**Goals:**

- Add an explicit source-memory choice to onboarding.
- Import one safe, documented source format first: Claude Code project-memory
  Markdown for the current workspace.
- Show unsupported Kimi/pi/Kiro native stores without scraping them.
- Keep source-memory import independent from `--memory on|off` shared-backend
  configuration.
- Reuse existing migration plans, backup sessions, conflict reporting, and
  canonical memory sync.

**Non-Goals:**

- Parsing Kimi/pi session logs or caches as memory.
- Importing Kiro Total Recall SQLite without a documented, versioned adapter.
- Copying OAuth credentials, Keychain entries, or chat transcripts.
- Automatically importing every project under `~/.claude/projects`.

## Decisions

### 1. Introduce a NativeMemoryAdapter boundary

Add a small adapter contract that returns safe `NativeMemoryCandidate` records:

```text
sourceAgent, sourceId, sourcePath, displayName, content, status
```

The adapter is read-only and must return bounded Markdown content. The initial
Claude adapter derives the current workspace project key using the existing
Claude project directory convention, but only accepts an exact matching
directory and Markdown files. No fuzzy search across projects is performed.

Kimi Code and pi adapters initially return an explicit unsupported result for
their session stores. This is more honest than treating session transcripts as
durable memory.

### 2. Extend migration plans with a memory kind

`MigrateKind` gains `memory`. Its plan items reuse `sourceContent`, deterministic
canonical target names, conflict/remediation fields, and the existing backup
apply path. A source-specific prefix is included in the target slug to avoid a
Claude memory named `MEMORY` colliding with a user-authored canonical memory.

The plan never stores or prints hidden credentials. Source content is only read
for the explicit candidate path and is bounded before appearing in an apply
operation.

### 3. Add independent onboarding choices

The interactive flow presents two separate single-select choices:

```text
迁移已有记忆       保持不迁移 / 迁移支持的记忆
共享 Memory 后端   保持当前 / 开启 / 关闭
```

The first choice controls `MigrateKind.memory`; the second remains the existing
`--memory on|off` state machine. Automation receives equivalent flags, for
example `--memory-migrate on|off`, while omission preserves the current state.

If no adapter finds candidates, the migration choice reports the unsupported or
empty state and does not create a fake “successful migration” item.

### 4. Use canonical Markdown as the review boundary

Each imported file gets a short provenance header containing the source Agent,
source identifier, and import timestamp. The body remains readable Markdown.
Users can review or edit it before running `trellis memory sync`. Existing
canonical files are compared byte-for-byte; differing content is a conflict,
never an overwrite.

### 5. Preserve the existing transaction boundary

Onboarding collects the source-memory plan before opening its backup session,
applies it with the same session as other capabilities, then runs existing sync,
Memory sync, audit, and doctor stages. A blocked verdict triggers the current
automatic rollback. Dry-run uses the same plan but no writes.

## Risks / Trade-offs

- **[Risk]** Claude's project-key convention changes.
  **Mitigation:** require an exact directory match and report no candidate
  rather than guessing; keep the adapter isolated for future updates.

- **[Risk]** Imported Markdown contains instructions or secrets.
  **Mitigation:** display provenance, keep content in canonical reviewable
  files, run the existing secrets audit, and treat memory as untrusted context.

- **[Risk]** Users expect Kimi/pi sessions to become memory automatically.
  **Mitigation:** report unsupported explicitly and leave those stores untouched.

- **[Risk]** A large memory file slows onboarding.
  **Mitigation:** enforce a bounded adapter read size and report an actionable
  refusal when exceeded.

## Migration Plan

1. Implement the adapter and migration-kind plan/apply path.
2. Add interactive and non-interactive choice tests plus rollback tests.
3. Add a sandbox Claude-memory fixture and unsupported Kimi/pi scenarios.
4. Run full tests, package verification, and sandbox matrix.
5. Produce a real-home dry-run showing the exact source-memory candidates.
6. Only after explicit user confirmation, run the real onboarding command.

## Open Questions

None for this change. Kimi/pi native session import is intentionally a future
adapter and does not block the current supported-source contract.
