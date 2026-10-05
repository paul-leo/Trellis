# Tasks

## 1. Core scope editing

- [x] 1.1 `collectSkillScopePlan` / `applySkillScopeWithSync` in `src/commands/skill.ts`:
      selectors, managed-agent validation, full-set normalization, built-in and
      unknown-name refusal, backup session, cascade sync.
- [x] 1.2 `collectMcpScopePlan` / `applyMcpScopeWithSync` in `src/commands/mcp.ts`
      with the same rules, writing `agents:` via `upsertServerYaml`.
- [x] 1.3 CLI wiring and help text in `src/cli.ts` for `skill scope` and
      `mcp scope` (`--agents`, `--all`, `--none`, `--dry-run`, `--json`).

## 2. Credential status

- [x] 2.1 Add `authStatus` / `authExpiresAt` to `McpListEntry` and
      `collectMcpListPlan`, derived from the token store for OAuth-classified
      servers only; print it in the text listing.

## 3. Sidecar

- [x] 3.1 `GET /managed` in `routes/read.ts`.
- [x] 3.2 `skill-scope` and `mcp-scope` plan/apply operations in
      `routes/planApply.ts`.

## 4. GUI

- [x] 4.1 Shared agent-toggle component and a staged-selection hook.
- [x] 4.2 SkillsView and McpView: toggles, save through the confirm modal.
- [x] 4.3 McpView: credential badge and the `trellis mcp auth <name>` remedy.
- [x] 4.4 AgentsView: agent tag on findings.
- [x] 4.5 i18n keys, English and Chinese.

## 5. Verification and packaging

- [x] 5.1 Unit tests: selectors, validation, normalization, refusal cases, dry run,
      ownership-gated MCP removal, credential states, no-secret output, a stray
      token file, sidecar routes, GUI smoke.
- [x] 5.2 Full test suite, typecheck, build, package verification.
- [ ] 5.3 Rebuild the sidecar and the desktop app; confirm in the running app that
      the icon matches sibling icons and the codex ENOENT finding is gone.
