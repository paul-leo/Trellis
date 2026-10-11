# Tasks

## 1. Remote source and provenance foundation

- [x] 1.1 Add GitHub shorthand/URL normalization, ref resolution, temporary fetch, exact `SKILL.md` discovery, and symlink-containment validation; verify fixture repositories cover nested discovery, missing names, malformed entry files, and zero code execution.
- [x] 1.2 Add the versioned Trellis remote-Skill provenance lock with canonical directory digests, atomic read/write, and credential-free serialization; verify records round-trip and reject malformed data safely.

## 2. Canonical import and scope

- [x] 2.1 Add a plan/apply remote canonical importer that compares imported content, creates the Skill and provenance record in one backup session, and synchronizes only after successful canonical application; verify identical, conflicting, and dry-run cases.
- [x] 2.2 Add `--agent` and `--agent '*'` scope resolution against managed Agents, including safe `scope.yaml` edits; verify an unmanaged Agent is rejected before any canonical or native write.
- [x] 2.3 Add `trellis add <source> --skill <name>` CLI parsing with GitHub-source, `--branch`, `--list`, `--global`, `--yes`, `--dry-run`, and JSON behavior; verify `--copy` and project-local semantics refuse with clear guidance.

## 3. Update and lifecycle

- [x] 3.1 Add `trellis update [skills...]` planning that resolves a tracked ref, compares lock/current/fetched content, preserves scope, and reports unchanged, update, and conflict outcomes; verify an edited canonical Skill is never overwritten.
- [x] 3.2 Apply a remote update through one backup session that replaces the canonical directory and provenance record, then syncs Skills; verify rollback restores the prior directory and lock record together.
- [x] 3.3 Extend Skill listing JSON and human output with remote provenance while retaining existing local Skill list behavior; verify no credentials or temporary paths appear.

## 4. Documentation and release validation

- [x] 4.1 Document the `npx trellis add mattpocock/skills --skill loop-me` migration path, managed-Agent targeting, source review, provenance, update, and rollback behavior; verify all documented commands and examples parse.
- [x] 4.2 Run targeted source/import/update/rollback tests, the full suite, typecheck, build, package verification, and strict OpenSpec validation; verify no agent-native path is written before the canonical import succeeds.
