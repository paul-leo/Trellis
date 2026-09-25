# Tasks

## 1. Agent identity and static discovery

- [x] 1.1 Add `zcode` to Agent identity, lifecycle, route, Runtime, and CLI validation surfaces; verify management accepts `zcode` and existing Agent ids remain stable.
- [x] 1.2 Implement profile-aware, read-only ZCode probing for official, community-CLI, and configuration-only installations; verify fixture tests never read credentials or session stores.

## 2. Runtime-first configuration adapter

- [x] 2.1 Implement nested `mcp.servers` planning, JSON merge, ownership-ledger create/repair/removal, and backup coverage for each ZCode profile; verify unrelated settings and hand-edited entries survive.
- [x] 2.2 Implement Runtime-only native-Skill control ownership and safe restoration; verify shared `~/.agents/skills` cannot bypass a ZCode scope restriction.
- [x] 2.3 Implement ZCode AGENTS symlink projection and verification; verify user-authored `~/.zcode/AGENTS.md` reports a conflict.

## 3. Canonical and command integration

- [x] 3.1 Register the ZCode adapter in sync, MCP sync, secrets audit, Runtime gateway validation, and capability delivery; verify Runtime delivery emits exactly one `trellis mcp-runtime --agent zcode` entry.
- [x] 3.2 Add ZCode static Skill, instructions, and nested MCP migration support; verify secret references follow the existing safe migration path.
- [x] 3.3 Include ZCode in onboarding and doctor summaries, runtime drift, and capability selection; verify a compatible CLI is presented as Runtime-first and a desktop-only profile is configuration-only.

## 4. CLI chat and delegation

- [x] 4.1 Add public-CLI capability gating and ZCode structured output parsing to delegated calls; verify `response` and `sessionId` support one-shot and resumed calls.
- [x] 4.2 Extend GUI chat target handling for ZCode stream-json events and raw unknown events; verify a ZCode result is rendered and its session is retained.

## 5. Verification and documentation

- [x] 5.1 Add focused unit/integration fixtures for profile selection, nested configuration ownership, Runtime isolation, migration, and stream parsing; verify the targeted tests pass.
- [x] 5.2 Update user documentation, install hints, and prior unsupported-ZCode notes; verify docs describe current local and official profile boundaries accurately.
- [x] 5.3 Run typecheck, full test suite, build, package verification, and strict OpenSpec validation; record the no-model local CLI validation separately from a billed model turn.
