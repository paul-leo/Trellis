## 1. Doctor's known_host_injected fix (D3) — do this first, it's small and independent

- [x] 1.1 `src/commands/doctor.ts`'s new `resolveKnownHostInjected(opts)`:
      explicit override wins; else tries `loadCanonicalSource(opts.homeDir)`
      and uses its real `known_host_injected`; falls back to
      `DEFAULT_KNOWN_HOST_INJECTED` on any failure (no canonical source).
      `runDoctor` calls it before `collectDoctorReport` — `doctor.ts`'s own
      exported signatures otherwise unchanged.
- [x] 1.2 Test: real canonical source with a distinct `known_host_injected`
      value is used, not the hardcoded default.
- [x] 1.3 Test: no canonical source still falls back to
      `DEFAULT_KNOWN_HOST_INJECTED`, unchanged from before this change.

## 2. `trellis init` command

- [x] 2.1 `src/commands/init.ts`: `collectInitReport`/`runInit`, per-file
      idempotent create-only-what's-missing for `agents.md`,
      `mcp/servers.yaml`, `secrets.policy.yaml`.
- [x] 2.2 Templates: `agents.md` placeholder pointing at `trellis migrate`;
      `mcp/servers.yaml` with empty `servers`/`known_host_injected` plus
      explanatory comments; `secrets.policy.yaml` with `reject_patterns`
      read live from `schema/secrets.policy.example.yaml` (parsed YAML,
      not hand-retyped — confirmed they can't drift).
- [x] 2.3 `mcp/`, `skills/`, `agents/`, `memories/` directories created
      (empty is harmless; `loadCanonicalSource` already treats a missing
      directory as empty).
- [x] 2.4 Probes all four agents after ensuring the skeleton; prints a
      `trellis migrate --from <agent>` pointer for each present one (the
      migrate command itself doesn't exist yet — the message names it
      anyway since the next change is expected to land immediately after).
- [x] 2.5 Wired into `src/cli.ts`: `trellis init`, `--json` support.
- [x] 2.6 `printUsage()` updated.

## 3. Tests

- [x] 3.1 Fresh scratch `$HOME`: `init` creates the full skeleton;
      `sync`/`mcp sync`/`secrets audit` (called directly, not just
      smoke-tested via CLI) all resolve without a "no canonical source"
      throw against that same home.
- [x] 3.2 Byte-for-byte unchanged on re-run (content compared, not just
      "didn't crash"; mtime also asserted unchanged).
- [x] 3.3 Partially-initialized home: hand-written `agents.md` content
      survives untouched; only the missing files get created.
- [x] 3.4 `scope.yaml` never created, confirmed via a dedicated test.
      (Bonus, not originally listed: a fifth test asserts all four agent
      pointers correctly report "not detected" against an empty scratch
      home.)

## 4. Sandbox verification

- [x] 4.1 Ran in the real Docker sandbox (`docker/sandbox.Dockerfile`,
      rebuilt). First run surfaced a real bug: neither this Dockerfile nor
      `pi-sandbox.Dockerfile` copied `schema/`, so `init` crashed with
      `ENOENT` reading `schema/secrets.policy.example.yaml` — both
      Dockerfiles fixed (`COPY schema ./schema`), re-ran clean: `init`
      created the skeleton, `doctor`/`sync`/`mcp sync`/`secrets audit` all
      ran against it with real, expected findings (not "no canonical
      source" refusals).

## 5. Docs and archive

- [x] 5.1 `docs/roadmap.md` entry added (not a numbered "P" phase, same
      convention as the two prior non-roadmap entries).
- [x] 5.2 README Quick Start rewrite deliberately held for the broader doc
      cleanup pass after `trellis migrate` lands — tracked there, not
      forgotten.
- [x] 5.3 `openspec validate --strict` clean; full suite (162/162 after
      this change) passing; typecheck clean. One run flaked at 161/162
      under heavy concurrent subprocess load (this suite spawns many real
      child processes) — an immediate re-run passed 162/162 clean; treated
      as the same class of load-dependent flake documented in
      `trellis-mcp-connect-timeout`'s own tasks.md, not a regression.
- [x] 5.4 Archived.
