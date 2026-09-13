## 1. Allowlist-based real-home snapshot builder

- [x] 1.1 `src/lib/realHomeSnapshot.ts`: `REAL_HOME_ALLOWLIST` (every path
      each probe is confirmed to read) and `buildRealHomeSnapshot(sourceHome,
      destHome)`
- [x] 1.2 Symlinks are dereferenced during copy (design.md D2)
- [x] 1.3 A `dest`-already-exists guard skips a redundant copy for a
      case-insensitive-filesystem duplicate allowlist entry (design.md D3)
- [x] 1.4 `test/unit/realHomeSnapshot.test.ts`: file copy, directory copy,
      missing-path skip, non-allowlisted-path exclusion, symlink
      dereferencing, case-insensitive duplicate handling, allowlist content
      assertions — all against synthetic temp directories only

## 2. Secrets-audit gate

- [x] 2.1 `scripts/prepare-real-sandbox.ts`: builds the snapshot, runs
      `trellis init`'s own fill-in-what's-missing logic against it, then
      gates on `runSecretsAudit({ homeDir: snapshotDir })` — refuses (no
      further step) on any finding
- [x] 2.2 `scripts/sandbox.sh` gains `--real`, additive only — default
      fixture-mode behavior unchanged

## 3. Migrate-source symmetry (closing P11's named gap)

- [x] 3.1 `test/unit/migrateSources.test.ts`: codex, kiro, and pi each
      verified as a migrate source using that probe's own real dotfile
      paths

## 4. Verification

- [x] 4.1 Full project-wide test suite passes (304/304 before this
      change's own new tests; confirm the post-change count includes them
      with zero regressions)
- [x] 4.2 `buildRealHomeSnapshot` and `prepare-real-sandbox.ts` actually run
      once against a real, in-use machine (not just synthetic fixtures) —
      found and fixed the two real bugs task 1.2/1.3 describe; the
      secrets-audit gate correctly refused on that real run due to a
      genuine, pre-existing gap in that machine's own
      `secrets.policy.yaml` (not a bug in this change) — named explicitly
      in design.md's Risks section, not silently worked around
- [x] 4.3 The existing fixture-based `scripts/sandbox.sh` (no `--real`)
      re-run end-to-end against Docker after this change, confirming no
      regression to the default path

## 5. Documentation

- [x] 5.1 `docs/roadmap.md`'s P13 entry updated from "(planned)" to "done
      and archived" with the real archive path, once this change is
      archived
