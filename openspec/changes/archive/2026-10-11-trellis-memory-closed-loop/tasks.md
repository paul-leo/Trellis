# Tasks

## 1. Memory capability model and onboarding

- [x] 1.1 Define a structured Memory readiness model covering backend
      configured, graph path readiness, canonical count, delivered Agents, and
      write authority; verify serialization contains no secret values.
- [x] 1.2 Extend onboarding's interactive capability selection and summary to
      present Memory as an explicit enable/keep-disabled choice while
      preserving `--memory on|off` and no-op repeat behavior; verify both TTY
      and `--json` outputs.
- [x] 1.3 Connect Memory enablement to the existing transaction and
      self-verification path so `onboard --memory on` verifies the canonical
      server, managed Kimi/pi delivery, and graph sync before finalizing; add
      rollback coverage for each blocking failure.
- [x] 1.4 Document the safe rollout boundary and ensure dry-run onboarding
      never writes the developer's real `~/.trellis`, Kimi, or pi state.

## 2. Runtime and shared backend behavior

- [x] 2.1 Expose the structured Memory readiness state through Runtime status
      and the built-in `trellis-runtime` Skill; verify missing backend,
      configured-empty graph, and ready graph are distinct states.
- [x] 2.2 Ensure Gateway/Runtime mounts exactly one configured Memory MCP
      upstream for managed Kimi Code and pi, preserving upstream write tools
      and the existing timeout/auth/failure isolation behavior; verify no
      second per-Agent graph is created.
- [x] 2.3 Add explicit confirmation and untrusted-content tests for any
      Trellis-owned Memory mutation surface; verify missing confirmation never
      writes, executes text, or launches an Agent.
- [x] 2.4 Keep `trellis memory sync` and `trellis memory extract` ownership,
      conflict, relation, and non-Trellis preservation rules intact; verify
      Runtime status links users to the explicit extraction command without
      running it implicitly.

## 3. Kimi Code and pi acceptance lab

- [x] 3.1 Add an isolated sandbox fixture that enables Memory only through
      `trellis onboard --memory on`, uses one deterministic graph path, and
      verifies the generated canonical/native plans for Kimi Code and pi.
- [x] 3.2 Drive the real MCP protocol for Kimi Code and pi Runtime/Gateway
      entries: create a unique test entity through the shared Memory backend,
      read it from the other Agent, and clean up without touching the host.
- [x] 3.3 Add a failure scenario for graph conflicts, missing backend, and
      upstream startup failure; verify other MCP tools remain available and
      onboarding reports a recoverable blocking verdict.
- [x] 3.4 Run the sandbox acceptance through a portable host command with no
      dependency on `rg`, host Agent credentials, or real HOME paths.

## 4. Native-memory boundary and documentation

- [x] 4.1 Make onboarding explicitly report that unsupported native/private
      Agent memory was not imported; verify no keychain, transcript, or
      undocumented memory directory is read.
- [x] 4.2 Document the two supported directions — canonical-to-graph sync and
      explicit graph-to-canonical extraction — and the Kimi/pi shared graph
      contract in the architecture and getting-started docs.

## 5. Verification and rollout gate

- [x] 5.1 Add unit and MCP protocol tests for readiness states, onboarding
      idempotency, cross-Agent shared writes, extraction discoverability, and
      rollback.
- [x] 5.2 Run full tests, typecheck, build, package verification, strict
      OpenSpec validation, and the complete sandbox matrix.
- [x] 5.3 Produce a no-write real-home dry-run for Kimi/pi and record the exact
      apply command as the only next-step rollout; do not execute the apply in
      this change.
