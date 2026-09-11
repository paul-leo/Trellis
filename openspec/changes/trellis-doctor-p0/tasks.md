## 1. Resolve the open unknown first (gates task group 5)

- [ ] 1.1 Run `pi --skill <path-to-a-known-skill-dir>` non-interactively
      (`pi -p "..."` or similar) against a live pi install and confirm the
      skill actually loads
- [ ] 1.2 Open `pi config` (interactive TUI) and check for any skill-path
      setting; re-check `~/.pi/agent/settings.json` afterward for a key that
      wasn't present when checked during research (nothing was configured
      at that point)
- [ ] 1.3 Record the outcome (A: real discovery directory exists, or B:
      strictly `--skill`-flag-per-invocation) back into `design.md`'s D5
      section as the resolved decision, with the evidence that produced it

## 2. Shared probing library — `src/lib/`

- [ ] 2.1 `src/lib/mcpProbe.ts`: `probeMcpServer(def, env, timeoutMs=10000)`
      — spawn, send `initialize`, resolve on first `id:1` response or
      process exit, whichever first; capture stderr on failure
- [ ] 2.2 Unit test 2.1 against `@modelcontextprotocol/server-memory`
      (known-good, zero external dependencies) for the success path
- [ ] 2.3 Unit test 2.1 against a command that exits immediately (e.g.
      `node -e "process.exit(1)"`) for the exit-before-response path
- [ ] 2.4 Unit test 2.1 against a command that never responds (e.g. `sleep
      100`) for the timeout path, using a short timeout override so the test
      doesn't actually wait 10s
- [ ] 2.5 `src/lib/fsIdentity.ts`: `isSymlinkTo(path, target)` and
      `realpathDedupe(paths)`
- [ ] 2.6 Unit test: two ordinary directories with identical content are
      reported as two distinct entries, not deduplicated
- [ ] 2.7 Unit test: a real directory and a symlink to it are deduplicated
      into one entry
- [ ] 2.8 `src/lib/skillFile.ts`: `findSkillFile(dir)` returning
      `{ path, caseCorrect }` or `null`
- [ ] 2.9 Unit test: a directory containing only `skill.md` (lowercase)
      returns `caseCorrect: false`, distinguishable from `null`

## 3. Extend canonical types — `src/core/types.ts`

- [ ] 3.1 Add `AgentSnapshot` and its nested types (`skillRoots`,
      `mcpServers`, `instructionsFile`, `subagentsDir`) exactly as specified
      in `docs/implementation-plan.md` §0.2, adjusted for the P0-only field
      needs identified while building group 4
- [ ] 3.2 Add the "not comparable" skill-state marker needed for pi's
      snapshot under D5 outcome B, if that's what task 1 resolves to

## 4. Per-agent probes — `src/probes/` (build in this order)

- [ ] 4.1 `src/probes/claude-code.ts` — reads `~/.claude.json`
      (`mcpServers`), `~/.claude/skills`, `~/.claude/agents`,
      `~/.claude/CLAUDE.md`; validates the `AgentSnapshot` shape end-to-end
      before the other three probes commit to it
- [ ] 4.2 `src/probes/codex.ts` — shells out to `codex mcp list --json`
      (confirmed available, see design.md D2); skill root is
      `~/.agents/skills`; additionally checks whether `~/.codex/skills`
      independently contains any non-symlink skill directories (the exact
      duplication class already found and fixed once in this environment)
- [ ] 4.3 `src/probes/kiro.ts` — `~/.kiro/settings/mcp.json`,
      `~/.kiro/skills`, `~/.kiro/steering/CLAUDE.md`
- [ ] 4.4 `src/probes/pi.ts` — implementation depends on task 1's outcome;
      do not write this before task 1 is complete

## 5. `trellis doctor` command — `src/commands/doctor.ts`

- [ ] 5.1 `runDoctor(opts: { json?: boolean })` — calls all four probes via
      `Promise.allSettled`; one agent erroring must not blank the other
      three's results
- [ ] 5.2 Cross-agent drift comparison (same skill name, different
      realpath) per `capability-drift-detection`'s first requirement
- [ ] 5.3 Within-agent duplication detection per its second requirement
- [ ] 5.4 MCP name collision detection against `known_host_injected` per its
      third requirement, with the specific failure-class message (e.g.
      Codex's `url is not supported for stdio`) included when known
- [ ] 5.5 Human-readable table output (✅/⚠️/❌ per row)
- [ ] 5.6 `--json` output emitting the full snapshot + findings array,
      with no table text mixed in
- [ ] 5.7 Non-zero exit code on any finding or probe failure; zero only on
      a fully clean run

## 6. Wire into the CLI

- [ ] 6.1 Replace `src/cli.ts`'s `doctor` stub case with a real call to
      `runDoctor`, preserving `--json` flag passthrough

## 7. Acceptance verification against this machine's known state

- [ ] 7.1 Run `trellis doctor` on this machine and confirm it independently
      reports the Codex `openspec-*` skill duplication as **already clean**
      (it was fixed by hand during research) — a false positive here means
      the duplication logic doesn't actually match what was fixed
- [ ] 7.2 Confirm it reports any current MCP server name collision against
      `known_host_injected`, if one currently exists on this machine, or
      confirms clean if none does
- [ ] 7.3 Confirm a synthetic lowercase `skill.md` (created temporarily in a
      scratch directory, not a real agent's skill root) is caught by the
      case-sensitivity check, then remove the scratch directory
- [ ] 7.4 If task 1 resolved to outcome A (pi has a real discovery
      directory), confirm the pi probe reports real data; if outcome B,
      confirm it reports "not comparable" rather than zero
