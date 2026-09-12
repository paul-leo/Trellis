## 1. Resolve the open unknown first (gates task group 5) — DONE

- [x] 1.1/1.2 superseded — see note below, not run as originally planned
- [x] 1.3 Recorded: outcome A, `~/.pi/agent/skills`. See `design.md` D5.

Resolved by direct source read of the installed
`@earendil-works/pi-coding-agent` package's unminified `dist/` tree
(`core/skills.js` + `config.js`) instead of the live `pi --skill`/`pi
config` behavioral test originally planned in 1.1/1.2 — the source is
literally the code that decides this and is available unminified, which is
stronger evidence than an inferred-from-behavior test, and avoids spending
a real model invocation (`pi -p` triggers an actual LLM call) on a question
the source already answers unambiguously. See `design.md` D5's "Method
note" for why this substitution is scoped to this one question, not a
standing replacement for behavioral testing generally.

## 2. Shared probing library — `src/lib/`

- [x] 2.1 `src/lib/mcpProbe.ts`: `probeMcpServer(def, env, timeoutMs=10000)`
      — spawn, send `initialize`, resolve on first `id:1` response or
      process exit, whichever first; capture stderr on failure
- [x] 2.2 Unit test 2.1 against `@modelcontextprotocol/server-memory`
      (known-good, zero external dependencies) for the success path
- [x] 2.3 Unit test 2.1 against a command that exits immediately (e.g.
      `node -e "process.exit(1)"`) for the exit-before-response path
- [x] 2.4 Unit test 2.1 against a command that never responds (e.g. `sleep
      100`) for the timeout path, using a short timeout override so the test
      doesn't actually wait 10s
- [x] 2.5 `src/lib/fsIdentity.ts`: `isSymlinkTo(path, target)` and
      `realpathDedupe(paths)`
- [x] 2.6 Unit test: two ordinary directories with identical content are
      reported as two distinct entries, not deduplicated
- [x] 2.7 Unit test: a real directory and a symlink to it are deduplicated
      into one entry
- [x] 2.8 `src/lib/skillFile.ts`: `findSkillFile(dir)` returning
      `{ path, caseCorrect }` or `null`
- [x] 2.9 Unit test: a directory containing only `skill.md` (lowercase)
      returns `caseCorrect: false`, distinguishable from `null`

## 3. Extend canonical types — `src/core/types.ts`

- [x] 3.1 Add `AgentSnapshot` and its nested types (`skillRoots`,
      `mcpServers`, `instructionsFile`, `subagentsDir`) exactly as specified
      in `docs/implementation-plan.md` §0.2, adjusted for the P0-only field
      needs identified while building group 4
- [x] 3.2 Not needed — D5 resolved to outcome A, no "not comparable" marker

## 4. Per-agent probes — `src/probes/` (build in this order)

- [x] 4.1 `src/probes/claude-code.ts` — reads `~/.claude.json`
      (`mcpServers`), `~/.claude/skills`, `~/.claude/agents`,
      `~/.claude/CLAUDE.md`; validates the `AgentSnapshot` shape end-to-end
      before the other three probes commit to it
- [x] 4.2 `src/probes/codex.ts` — shells out to `codex mcp list --json`
      (confirmed available, see design.md D2); skill root is
      `~/.agents/skills`; additionally checks whether `~/.codex/skills`
      independently contains any non-symlink skill directories (the exact
      duplication class already found and fixed once in this environment)
- [x] 4.3 `src/probes/kiro.ts` — `~/.kiro/settings/mcp.json`,
      `~/.kiro/skills`, `~/.kiro/steering/CLAUDE.md`
- [x] 4.4 `src/probes/pi.ts` — implementation depends on task 1's outcome;
      do not write this before task 1 is complete

## 5. `trellis doctor` command — `src/commands/doctor.ts` (see note below on 5.4)

**Note added after a real-machine run**: MCP handshake probing turned out
not to be default-safe — probing every configured server serially took
minutes on a machine with a dozen-plus servers and spawned real processes
reaching real external services with real credentials (OAuth connectors,
`chrome-devtools-mcp --autoConnect`). Made it opt-in via `--probe-mcp`
(off by default); default `trellis doctor` only does structural checks
(collision/duplication/drift/case), none of which spawn anything. See
docs/architecture.md "MCP handshake probing is opt-in".

- [x] 5.1 `runDoctor(opts: { json?: boolean })` — calls all four probes via
      `Promise.allSettled`; one agent erroring must not blank the other
      three's results
- [x] 5.2 Cross-agent drift comparison (same skill name, different
      realpath) per `capability-drift-detection`'s first requirement
- [x] 5.3 Within-agent duplication detection per its second requirement
- [x] 5.4 MCP name collision detection against `known_host_injected` per its
      third requirement, with the specific failure-class message (e.g.
      Codex's `url is not supported for stdio`) included when known
- [x] 5.5 Human-readable table output (✅/⚠️/❌ per row)
- [x] 5.6 `--json` output emitting the full snapshot + findings array,
      with no table text mixed in
- [x] 5.7 Non-zero exit code on any finding or probe failure; zero only on
      a fully clean run

## 6. Wire into the CLI

- [x] 6.1 Replace `src/cli.ts`'s `doctor` stub case with a real call to
      `runDoctor`, preserving `--json` flag passthrough

## 7. Acceptance verification against this machine's known state

- [x] 7.1 Run `trellis doctor` on this machine and confirm it independently
      reports the Codex `openspec-*` skill duplication as **already clean**
      (it was fixed by hand during research) — a false positive here means
      the duplication logic doesn't actually match what was fixed
- [x] 7.2 Confirm it reports any current MCP server name collision against
      `known_host_injected`, if one currently exists on this machine, or
      confirms clean if none does
- [x] 7.3 Confirm a synthetic lowercase `skill.md` (created temporarily in a
      scratch directory, not a real agent's skill root) is caught by the
      case-sensitivity check, then remove the scratch directory
- [x] 7.4 If task 1 resolved to outcome A (pi has a real discovery
      directory), confirm the pi probe reports real data; if outcome B,
      confirm it reports "not comparable" rather than zero

**Evidence from the actual run** (`npx tsx src/cli.ts doctor`, default —
no `--probe-mcp` — against this real machine):
- 7.1: `codex` reported ✅ clean, zero findings — the `openspec-*`
  duplication fix holds.
- 7.2: real collision found and reported, not synthetic —
  `MCP server "sentry" is statically configured but also appears in
  known_host_injected` on both `claude-code` and `kiro` (Codex's own
  config has no static `sentry` entry, consistent with it instead relying
  on mirasim's runtime injection for that server — no collision there).
- 7.3: covered by `test/unit/skillFile.test.ts`'s synthetic case, and
  independently confirmed against real state — the run also caught a
  genuine wrong-case skill (`e2e-test`) already present on this machine.
- 7.4: `~/.pi/agent/skills` genuinely does not exist yet on this machine
  (pi has no global skills configured here) — probe correctly reports
  `skillRoots: []` (checked, found none) rather than fabricating data,
  confirmed via `--json` output.

This run also caught the real MCP-handshake-by-default problem that led
to the "MCP handshake probing is opt-in" design change recorded above —
itself a demonstration of `doctor` (and the process of trying to use it)
doing its job.
