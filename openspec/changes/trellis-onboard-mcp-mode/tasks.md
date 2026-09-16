## 1. Canonical writer for mode (precondition)

- [x] 1.1 `src/core/canonical.ts`: add a `McpMode` type (`{ kind:
      "direct" } | { kind: "hub"; url: string } | { kind: "gateway";
      agents?: AgentId[] }`) and `writeMcpModeYaml(path, mode):
      ServersYamlWriteResult`, `Document`-based (`parseDocument`/
      `setIn`/`delete`), same refusal posture as `upsertServerYaml` for
      a missing/unparseable file (design.md D2/D3)
- [x] 1.2 `test/unit/canonical.test.ts` (or sibling): each of the three
      modes writes the expected keys and clears the other two (design.md
      D3); an unrelated hand-authored comment survives; a missing file
      refuses with the same message shape `upsertServerYaml` already
      uses

## 2. Flag parsing and validation (mode)

- [x] 2.1 `src/cli.ts`: parse `--mcp-mode`, `--hub-url`,
      `--gateway-agents` for the `onboard` command, passed into
      `RunOnboardOptions`; update onboard's help text
- [x] 2.2 `src/commands/onboard.ts`: `RunOnboardOptions` gains
      `mcpMode?: string`, `hubUrl?: string`, `gatewayAgents?: string`.
      Validate: `mcpMode` (if given) is one of `direct`/`hub`/`gateway`;
      `hub` requires `hubUrl`; `gatewayAgents` (if given) reuses
      `parseManagedSelection`'s comma-separated-id grammar; either
      mode-specific flag given without its matching `mcpMode` refuses
      (design.md D4). Any failure returns the existing top-level-refusal
      shape (`verdict: []`, folded into the printed verdict like every
      other refusal)

      Deviation from the plan as written: `--gateway-agents` got its own
      `parseAgentIdList` (comma-separated ids only) instead of literally
      calling `parseManagedSelection`. That function's numbered-index
      shorthand refers to a candidate list shown on screen during a
      prompt — `--gateway-agents` is flag-only and never prompted, so
      there is no numbered list for a digit to mean anything against;
      reusing it as-is would have silently accepted "1,2" as agent
      shorthand for an ordering the user never saw. Same validation
      *shape* (unknown token refuses, listing valid ids), narrower
      grammar.
- [x] 2.3 `test/unit/onboard.test.ts`: invalid `--mcp-mode` value
      refuses with valid options listed; `--mcp-mode hub` without
      `--hub-url` refuses; `--hub-url`/`--gateway-agents` without a
      matching `--mcp-mode` refuses; `--gateway-agents` with an invalid
      token refuses using the same message shape `--manage` already
      produces

## 3. Mode resolution wired into the run

- [x] 3.1 `src/commands/onboard.ts`: read current mode from
      `loadCanonicalSource(homeDir).mcp` (`gateway`/`hub` →
      `"gateway"`/`"hub"`/`"direct"`) immediately after managed-set is
      written, before migrate (design.md D5). When `opts.mcpMode` is
      unset, resolved mode = current mode and `writeMcpModeYaml` is
      never called — no write, no diff, on either a first or a later run
- [x] 3.2 When `opts.mcpMode` is set and differs from current, call
      `writeMcpModeYaml` (skipped under `--dry-run`, matching every
      other write in this flow) and mark the run as having changed mode
- [x] 3.3 `OnboardResult` gains `mcpMode: { current: "direct" | "hub" |
      "gateway"; changed: boolean }` (design.md D7), included in
      `--json` output. (Also carries `previous`, additive beyond what
      was planned — needed by the status line's "changed from X"
      wording and harmless for `--json` consumers per the additive-only
      rule.)
- [x] 3.4 `test/unit/onboard.test.ts`: a run with no `--mcp-mode` against
      a fresh home resolves to `direct`/`changed: false`; the same run
      against a home with `gateway.enabled: true` already set resolves
      to `gateway`/`changed: false` with no write attempted; `--mcp-mode
      gateway` against a fresh home resolves to `gateway`/`changed:
      true` and the write lands; `--dry-run` with `--mcp-mode gateway`
      reports `changed: true` but writes nothing

## 4. Status line for mode (non-interactive, non-prompting)

- [x] 4.1 `src/commands/onboard.ts`: on a non-`--json` run with a real
      TTY, print one line stating the resolved mode — naming
      `--mcp-mode` as how to change it when unchanged, stating the
      before/after when changed (design.md D6). Suppressed under
      `--json` or when stdout is not a TTY
- [x] 4.2 `test/unit/onboard.test.ts`: the line appears on a TTY run and
      is absent from `--json` output and from a non-TTY run; no prompt
      is ever awaited for this line (the run completes without any
      mode-related input, matching D1)

## 5. Default memory server definition (precondition for the toggle)

- [ ] 5.1 `src/commands/memory.ts`: export `DEFAULT_MEMORY_SERVER_DEF`
      (`{ transport: "stdio", command: "npx", args: ["-y",
      "@modelcontextprotocol/server-memory"], staticEnv: {
      MEMORY_FILE_PATH: "~/.trellis/memories/graph.jsonl" } }`) alongside
      the existing `MEMORY_SERVER_NAME` constant (design.md D9)
- [ ] 5.2 `schema/servers.example.yaml`: update the comment on the
      commented-out `memory:` block to note this is also what `trellis
      onboard --memory on` writes, so the two don't silently drift apart
      in someone's mental model

## 6. Flag parsing and validation (memory)

- [x] 6.1 `src/cli.ts`: parse `--memory` for the `onboard` command,
      passed into `RunOnboardOptions`; update onboard's help text
- [x] 6.2 `src/commands/onboard.ts`: `RunOnboardOptions` gains
      `memory?: string`, validated as `on`/`off` (design.md D12), same
      top-level-refusal shape as an invalid `--mcp-mode` value on failure

## 7. Memory resolution wired into the run

- [x] 7.1 `src/commands/onboard.ts`: read whether `mcp.servers["memory"]`
      exists from canonical, immediately after mode resolution, before
      migrate (design.md D11)
- [x] 7.2 `opts.memory === "on"`: no-op if already present; refuse the
      whole run if `"memory"` is in `known_host_injected`, naming the
      reason (design.md D10); otherwise call
      `upsertServerYaml(serversYamlPath, "memory",
      DEFAULT_MEMORY_SERVER_DEF)` (skipped under `--dry-run`)
- [x] 7.3 `opts.memory === "off"`: no-op if already absent; otherwise
      call `removeServerYaml(serversYamlPath, "memory")` (skipped under
      `--dry-run`)
- [x] 7.4 `opts.memory` unset: resolved state = current state, no writer
      call at all, on either a first or a later run (mirrors 3.1's rule
      for mode)
- [x] 7.5 `OnboardResult` gains `memory: { current: "on" | "off";
      changed: boolean }` (design.md D13), included in `--json` output
      (also carries `previous`, same additive rationale as 3.3)
- [x] 7.6 `test/unit/onboard.test.ts`: a run with no `--memory` against a
      fresh home resolves to `off`/`changed: false`, no write; the same
      against a home with an existing `"memory"` entry resolves to
      `on`/`changed: false`, no write; `--memory on` against a fresh home
      writes the default def and resolves `on`/`changed: true`; `--memory
      on` against a home with `"memory"` in `known_host_injected` refuses
      before writing anything; `--memory off` against an already-absent
      entry resolves `changed: false`; `--dry-run` with `--memory on`
      reports `changed: true` but writes nothing

## 8. One-run composition with existing sync/memory-sync stages

- [x] 8.1 `test/unit/onboard.test.ts`: `trellis onboard --memory on`
      against a scratch home with at least one managed agent and at
      least one file under `memories/` — in the SAME run — the `mcp
      sync` stage's report includes the new `"memory"` entry for every
      managed agent, and the `memory sync` stage (previously reporting
      `configured: false` on this home) reports real sync items instead
      of its unconfigured message. No second `trellis onboard` call
      needed to observe either.

## 9. Documentation

- [x] 9.1 `docs/getting-started.md`: document `--mcp-mode`, `--hub-url`,
      `--gateway-agents`, `--memory`, and that omitting any of them
      always preserves whatever is already configured
- [x] 9.2 `docs/architecture.md`: note that `trellis onboard --mcp-mode
      <value>` / `--memory on` is how gateway/hub mode and the memory
      server are enabled — not hand-editing `servers.yaml`
- [x] 9.3 `docs/roadmap.md`: this change's entry once implemented

## 10. Full-suite verification

- [x] 10.1 Full project-wide test suite passes with zero regressions
      (557/557)
- [x] 10.2 Typecheck and build succeed
- [x] 10.3 A real `trellis onboard --mcp-mode gateway --dry-run` against
      a scratch home previews the change without writing; a real
      (non-dry-run) run against a scratch home actually flips
      `servers.yaml`, and a following `trellis onboard` with no
      `--mcp-mode` reports `gateway`/`changed: false` — all verified
      against the built `dist/cli.js`, not just unit tests
- [x] 10.4 A real `trellis onboard --memory on` against a scratch home
      actually adds the `"memory"` entry, syncs it to every managed
      agent (confirmed: `.claude.json`'s `mcpServers` gained `memory`),
      and populates the graph from existing canonical `memories/*.md`
      (confirmed: `graph.jsonl` gained the real entity) — all in that
      one run.

      Surfaced one real, pre-existing bug outside this change's own
      scope, root-caused and fixed as a follow-up in the same session
      (not part of this change's own tasks 1–8, since the bug lives in
      `src/lib/envVarNames.ts`/`secretsAudit.ts`, code this change never
      touches): `extractJsonEnvVarNames` read every KEY under a written
      server's `env` object as a name needing `secrets.policy.yaml`
      `allowed_vars` membership — correct for `env`/`envAliases`
      (rendered as a `${NAME}` reference) but wrong for `static_env`
      (rendered as its literal value, never a reference at all, already
      protected by the separate `reject_patterns` scan). Fixed by
      extracting names from each value's `${...}` occurrences instead of
      from keys — a literal `static_env` value has none and contributes
      nothing; this also fixed a second, previously-undiscovered bug in
      the same function: an `envAliases` entry's value is `${sourceName}`
      (different from its own key), so the old key-based read was
      checking the wrong name against `allowed_vars` for every
      `envAliases` usage in this codebase's history. Regression tests in
      `test/unit/envVarNames.test.ts` and `test/unit/secretsAudit.test.ts`
      (end-to-end, reproducing this exact real run). Re-verified against
      the built CLI after the fix: the same `--memory on` run now ends on
      "✅ nothing needs attention"
