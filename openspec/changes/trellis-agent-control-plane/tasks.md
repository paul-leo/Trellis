# Tasks

## 1. Runtime control plane

- [x] 1.1 Define the Runtime status schema for requesting Agent identity,
      managed state, delivery, route, provider health, and safe counts.
- [x] 1.2 Add Agent listing/status capability with installed vs managed vs
      reachable vs healthy distinctions and secret redaction.
- [x] 1.3 Add InstructionsProvider read-only tool/resource backed by canonical
      `agents.md`, with bounded/path-safe reads.
- [x] 1.4 Integrate existing MCP status/remediation into the control-plane
      status model, including OAuth restart guidance and router degraded state.

## 2. Built-in Trellis Skill and onboarding

- [x] 2.1 Add the package-owned `trellis-runtime` awareness Skill and native /
      Runtime-only delivery rules for every supported Agent.
- [x] 2.2 Update onboarding to show Trellis awareness, Global instructions,
      Skills, Memory, MCP authorization, and delivery mode as distinct
      capability groups.
- [x] 2.3 Ensure repeated onboarding reports native vs Runtime delivery and
      avoids duplicate `trellis-runtime` Skill exposure.

## 3. Memory and authorization semantics

- [x] 3.1 Expose canonical Memory count, external Memory backend state, and
      read-only Runtime Memory status without confusing empty content with an
      unavailable provider.
- [x] 3.2 Define and test the authorization state machine for OAuth, env-backed
      stdio, and MCP router/downstream provider authentication.
- [x] 3.3 Add user/Agent recovery guidance and new-session/reconnect state to
      status output without allowing Gateway to open browsers.

## 4. Task handoff contract

- [x] 4.1 Define durable task records, statuses, claim leases, handoff history,
      context references, and secret/prompt-injection filtering.
- [x] 4.2 Add read-only task listing/inspection first; add mutation operations
      only with explicit policy and audit history.
- [x] 4.3 Keep Agent execution and process launching out of the first handoff
      implementation; document the future RPC/client boundary.

## 5. Verification and rollout

- [x] 5.1 Add unit and MCP protocol tests for Runtime status, Instructions,
      Memory state, auth remediation, and task lease conflicts.
- [x] 5.2 Validate Kimi, Claude Code, Codex, Kiro, and pi in the multi-Agent
      sandbox with native, Runtime-only, and both delivery modes.
- [x] 5.3 Run full tests, typecheck, build, package verification, and strict
      OpenSpec validation before enabling mutation-capable handoff.
