## 1. Runtime core

- [x] 1.1 Define the transport-independent `TrellisProvider` and
      `RuntimeContext` contracts.
- [x] 1.2 Implement `BuiltinRegistry` with provider-level failure isolation.
- [x] 1.3 Implement MCP handlers for tools, resources, and prompts using the
      official SDK, with capability declarations and list-change support.
- [x] 1.4 Wrap the existing `GatewayBackend` as an `UpstreamProvider` without
      duplicating connection, OAuth, timeout, or routing logic.
- [x] 1.5 Add the runtime entrypoint and preserve a compatibility alias for
      the existing gateway entry during migration.

## 2. Skill provider

- [x] 2.1 Implement scope-filtered `trellis.skills.search` metadata lookup.
- [x] 2.2 Implement `trellis.skills.read` with fingerprint and provenance.
- [x] 2.3 Implement the `trellis://skills/...` resource namespace.
- [x] 2.4 Implement bounded supporting-file reads with traversal, symlink,
      secret-file, and size-limit protection.
- [x] 2.5 Ensure no skill provider request spawns children, installs packages,
      or performs network access.

## 3. Delivery and upstream mounting

- [x] 3.1 Add per-agent delivery mode: native, runtime MCP, or both, with
      native as the default.
- [x] 3.2 Project one owned runtime entry through the existing adapters.
- [x] 3.3 Mount the selected upstream MCP route through the same runtime in
      direct/gateway-compatible modes.
- [x] 3.4 Add provider scope and runtime state to doctor/drift diagnostics.

## 4. Future memory seam

- [x] 4.1 Define the `MemoryProvider` contract without selecting a backend.
- [x] 4.2 Add a read-only canonical-memory provider and injectable test double.
- [x] 4.3 Document the future local-graph/OpenViking provider boundary and
      keep memory writes out of this change.

## 5. Tests and verification

- [x] 5.1 Test tool/resource/prompt registration and namespace isolation.
- [x] 5.2 Test scope filtering for all supported agents.
- [x] 5.3 Test traversal, symlink escape, secret-file refusal, and size limit.
- [x] 5.4 Test upstream failure isolation and gateway substitution.
- [x] 5.5 Test a real MCP client handshake and runtime tool/resource reads.
- [x] 5.6 Run full suite, typecheck, build, package verification, and the
      isolated Linux multi-agent runtime lab.
- [x] 5.7 Install real Codex, Claude Code, Kiro CLI, and pi binaries in a
      separate Linux image; verify Codex/Claude recognize the isolated
      `trellis-runtime` entry, while Kiro correctly reports login as the
      required next step before MCP listing.
- [x] 5.8 Run the steady-state multi-agent management lab covering
      convergence, idempotency, ownership preservation, memory sync, and
      safe capability removal.
- [x] 5.9 Run the sandbox scenario matrix, including expected collision
      failure and hanging-upstream isolation.
- [x] 5.10 With the host Codex authorization explicitly allowed, run a
      real Codex model session that invokes `trellis-runtime` and completes
      `shared-tool__echo` inside the isolated container.
- [ ] 5.11 Refresh pi authorization or run Kiro device login, then verify
      a real pi/Kiro model session invokes a Runtime MCP tool.
- [ ] 5.12 Run a real Claude Code model session only after explicit Claude
      authorization; Claude login remains intentionally deferred.
- [x] 5.13 With the host Codex authorization explicitly allowed, run a real
      Codex model session that discovers `trellis.memory.search` and then
      reads canonical content through `trellis.memory.read` inside the
      isolated container.
