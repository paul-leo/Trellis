# Tasks

## 1. Agent identity and probe

- [x] 1.1 Add `kimi-code` to Agent types, stable ordering, scope/management
      validation, and user-facing install hints; verify existing Agent tests
      remain green.
- [x] 1.2 Implement a read-only Kimi probe for binary/version, `mcp.json`
      server summaries, Kimi Skill roots, and diagnostics; verify no secret
      values are returned.

## 2. Kimi Runtime adapter

- [x] 2.1 Implement the Kimi JSON MCP adapter with ownership-ledger-gated
      `trellis-runtime` create/repair/remove and preserve unrelated entries;
      verify backup coverage and idempotency.
- [x] 2.2 Add Kimi Runtime delivery parsing to capability selection and
      onboarding; verify Kimi uses Runtime-only delivery without native Skill
      plan items.
- [x] 2.3 Add the `trellis kimi` launcher with empty `--skills-dir` isolation,
      argument forwarding, binary resolution, and clear failure messages;
      verify native roots are absent in an isolated Kimi session.

## 3. Runtime and Kimi optimization

- [x] 3.1 Ensure Runtime context and gateway upstream resolution accept
      `kimi-code` without changing other Agent behavior; verify tool/resource
      scope and provider failure isolation.
- [x] 3.2 Render Kimi's `deferred` Runtime MCP option and document the optional
      Kimi tool-select flag without making it required; verify generated JSON
      passes Kimi's own doctor/parse path.

## 4. Sandbox and local verification

- [x] 4.1 Install the real Kimi Code binary in the Agent sandbox and verify
      version, isolated config, launcher, and `mcp.json` recognition.
- [x] 4.2 Run official MCP client handshake against Kimi Runtime for Skill,
      Memory, and selected upstream tools/resources; verify no native Skill
      duplication.
- [x] 4.3 Run full tests, typecheck, build, package verification, and strict
      OpenSpec validation; record real Kimi model verification separately if
      authorization is available.

## 5. Documentation

- [x] 5.1 Document Kimi Runtime-first onboarding, `trellis kimi`, native vs
      Runtime delivery, and rollback behavior.
