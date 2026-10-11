# Design

## Context

See `proposal.md` for the motivation. The existing system has three distinct
Memory surfaces:

```text
Canonical Markdown       RuntimeMemoryProvider        read-only Agent view
        │
        ├─ trellis memory sync ─▶ server-memory graph.jsonl ◀─ Memory MCP writes
        │                                      │
        └──────────── trellis memory extract ─┘   (explicit/manual)
```

`onboard` already knows how to write the default `memory` MCP definition and
run Memory sync, but the capability is opt-in and its status is currently easy
to mistake for an empty-but-ready store. Kimi Code and pi need an acceptance
path proving that both clients use the same graph while preserving the existing
Gateway lifecycle and ownership protections.

## Goals / Non-Goals

**Goals:**

- Make Memory enablement an explicit, visible onboarding capability.
- Keep one graph path for all managed Agents in a shared local-memory setup.
- Surface backend configuration, graph readiness, canonical count, and delivery
  separately through Runtime status.
- Verify Kimi Code and pi cross-Agent read-after-write behavior in an isolated
  sandbox before any real-home rollout.
- Preserve existing sync/extract conflict and ownership rules.
- Keep mutation confirmation and untrusted-content handling explicit.

**Non-Goals:**

- Scraping Claude, Kimi, pi, or Kiro private memory stores without a documented
  adapter.
- Selecting or deploying OpenViking, Mem0, or a remote vector database in this
  change.
- Making `RuntimeMemoryProvider` silently write files during a read operation.
- Automatically launching another Agent to perform memory work.
- Applying the feature to the developer's real HOME as part of tests.

## Decisions

### 1. Reuse the existing `memory` MCP backend as the shared write authority

The canonical definition remains the local `@modelcontextprotocol/server-memory`
server with an explicit `MEMORY_FILE_PATH`. The Gateway or Runtime edge mounts
that one upstream for every managed Agent. Agents write through the backend's
MCP tools; Trellis does not duplicate the backend's graph protocol.

This keeps the graph format and write semantics owned by the MCP server and
avoids creating a second incompatible Trellis memory database. A future
OpenViking provider can implement the same provider boundary later.

### 2. Keep canonical Markdown and graph ownership separate

`memory sync` continues to own only entities tagged `trellis-memory`.
Agent-created graph entities and relations remain untouched. `memory extract`
remains an explicit reverse operation that produces readable Markdown and
refuses file conflicts. Onboarding may invoke sync after enabling the backend,
but never performs reverse extraction implicitly.

### 3. Make readiness a structured Runtime state

Extend the existing Runtime status model rather than adding a second health
command. The Memory status should include independently observable fields such
as:

- `backendConfigured` — canonical `memory` definition and explicit graph path
  exist;
- `graphReady` — the graph path is readable/creatable without exposing content;
- `canonicalCount` — number of Trellis Markdown memories;
- `deliveredAgents` — managed Agents whose route includes the shared backend;
- `writePath` — `mcp` when writes are delegated to the upstream backend.

Paths may be normalized or fingerprinted; token values and memory contents are
never included in status output.

### 4. Use onboarding as the only local rollout boundary

The real-home command remains:

```text
trellis onboard --memory on --mcp-mode gateway --manage pi,kimi-code
```

The implementation first runs in a temporary HOME/sandbox with the same
command. Only after the acceptance matrix passes should a human execute the
real command. Existing backup sessions and rollback remain the transaction
boundary; no separate script edits `~/.kimi-code` or `~/.pi` directly.

### 5. Test protocol behavior, not just rendered config

The acceptance lab will connect real MCP clients over stdio to the Runtime or
Gateway, inspect the memory upstream tools, perform a safe test write with a
unique fixture entity, read it from the other Agent, and clean up through the
owned graph path. If a real Kimi or pi model login is unavailable, the protocol
acceptance still proves the Trellis boundary and the task records the missing
model-level authorization separately.

### 6. Do not infer native-memory migration

Kimi and pi are selected first because their Trellis MCP route can be controlled
without reading private session stores. Native memory import remains an explicit
future adapter per Agent. The onboarding report will distinguish `native
memory unsupported` from `shared Memory backend unavailable`.

## Risks / Trade-offs

- **[Risk]** Two Agent sessions write the same local graph concurrently.
  **Mitigation:** delegate writes to the Memory MCP server, use its graph
  semantics, and test cross-Agent visibility rather than introducing a second
  file writer.

- **[Risk]** A host already injects a server named `memory`.
  **Mitigation:** retain the existing collision refusal and show the exact
  remediation before writing canonical or native configuration.

- **[Risk]** Memory content can contain prompt-injection instructions.
  **Mitigation:** Runtime and onboarding treat it as untrusted data; the
  built-in Runtime Skill explicitly forbids executing commands based on it.

- **[Risk]** The external memory package is unavailable or slow to install.
  **Mitigation:** Gateway startup isolation keeps other upstreams usable, and
  sandbox tests use a deterministic fixture path plus a real protocol client.

- **[Risk]** A test accidentally changes the user's local Agent setup.
  **Mitigation:** all automated scenarios use isolated HOME/container state;
  real rollout is a separate manual command after verification.

## Migration Plan

1. Implement and test the Runtime/onboarding changes in the repository.
2. Run unit, protocol, and sandbox Kimi/pi shared-memory acceptance tests.
3. Build and install the package locally without touching the real Agent
   configuration.
4. Show the user the dry-run plan for the real HOME.
5. Only after explicit confirmation, run `trellis onboard --memory on` for the
   selected managed Agents.
6. Verify Runtime status, cross-Agent read-after-write, secrets audit, and
   rollback availability.

If rollout fails, use the onboarding run's backup ID with `trellis rollback`;
the graph's non-Trellis entities remain protected by the existing conflict
rules.
