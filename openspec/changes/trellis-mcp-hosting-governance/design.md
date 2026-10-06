# Design

## Context

See `proposal.md` for motivation. v0.12.0 already supports per-Agent routes, explicit OAuth ownership, native or MCP Skill delivery, and backed-up writes. A native MCP entry outside the ownership ledger is intentionally preserved by ordinary sync. Skill delivery is selected per Agent; individual Skills currently have scope selection, not separate native/MCP delivery policies.

## Goals / Non-Goals

**Goals:** identify redundant discovery paths, retain one authoritative source where selected, and make hosting migrations observable and reversible.

**Non-Goals:** changing credentials owned by an Agent, automatically authorizing restricted providers, adding a shared resident gateway process, or claiming that gateway aggregation reduces the number of exposed tool schemas.

## Decisions

### D1. Classify before removing

A governance inventory compares effective transport, command/arguments, endpoint, non-secret environment bindings, and credential variable names. It classifies exact duplicates, different identities/configurations, shared-file links, and unknown external entries separately. Values needed for equality remain inside the process; reports contain names and equality flags.

Normal sync keeps its ownership protection. An unowned duplicate is removable only through an explicit selection tied to an inspected configuration snapshot. Its replacement path must be verified before removal. Account differences require an authoritative-source choice. The apply step checks that the snapshot has not changed and records the write through the existing backup system. Fabricating ledger ownership to make sync remove an entry is rejected.

### D2. Keep portable Skill files and disable redundant local discovery

Shared canonical Skills remain available in other projects. For a verified identical repository copy, use the Agent's supported path-specific disable mechanism where available. Keep repository files available to contributors who do not share the operator's global configuration. Codex supports `[[skills.config]]` overrides; verification uses its public `skills/list` interface to check that exactly one shared copy remains enabled. Other Agents need their own supported adapter behavior before claiming the same result.

No switch to MCP-only Skill delivery is part of duplicate removal. Skills with executable helpers must retain working filesystem references until a separate delivery migration validates them. Host-specific `CODEX_HOME` overlays and an already loaded session catalog are distinct from the default native configuration and must be reported as separate verification boundaries.

### D3. Use mixed MCP hosting

Ordinary stdio/API-key connections use Trellis gateway routes within their existing scopes. Agent-owned OAuth remains native. Providers that accept Trellis registration can opt into `auth: { kind: oauth, owner: trellis }` after an independent grant and live MCP discovery succeed. A registration endpoint alone is not evidence that registration is allowed.

Sentry and Supabase are suitable first candidates based on their official policies. Morphix is a candidate based on published metadata and needs a fresh independent grant. Figma remains native while Trellis lacks an approved client registration. Source links and the operator runbook are in `docs/mcp-hosting-governance.md`.

### D4. Pilot OAuth with a separate canonical label

`auth.owner` applies to a server definition for every receiving Agent. A one-Agent pilot therefore uses a separate server label and token store, scoped to that Agent. Its route includes the pilot label and excludes the original label for that Agent only. Other Agents retain the original connection and credentials.

Once authorization, resource/issuer binding, tool/resource discovery, and a read-only operation pass, broaden compatible gateway routes and explicitly change the primary server's owner. Reauthorize the primary label independently. Do not copy a pilot token, an old unbound Trellis token, or another Agent's credential into the primary store. Remove a pilot only after replacement verification succeeds.

### D5. Preserve routing scope and measure tools independently

The first route migration preserves each Agent's current eligible server set and Skill delivery mode. Scope reduction is a later explicit choice. External native entries remain outside the migration unless selected and verified.

A gateway starts separately per Agent session and currently exposes all connected upstream tools. Report native entry counts, upstream tool counts, enabled Skill counts, and startup/readiness separately. Use upstream feature-group/project filters where supported. Per-tool filters and lazy tool discovery are follow-up capabilities, not options claimed to exist in v0.12.0.

### D6. Separate config convergence, credential state, and live readiness

Acceptance needs a clean relevant sync preview, a default `doctor` report, and a separate live check. Neither a token file nor a zero-finding doctor report proves upstream access. Native authorization stays unknown when the Agent has no official status interface. Live checks list capabilities and perform only selected read-only operations; they must close the verification client and its processes with a bounded timeout.

## Risks / Trade-offs

- A native entry may represent a second account despite using the same command → require equality checks and an explicit account choice.
- A host injects or regenerates configuration → distinguish native default configuration from the host overlay and verify again after reload.
- OAuth ownership is global per server → use a source-isolated pilot and validate every receiving route before primary cutover.
- Provider policy changes → record evidence and date; do not turn a historical provider matrix into an authorization guarantee.
- Rollback overwrites later edits → use existing per-path conflict checks; never force a conflicting restore.
- Aggregation retains large tool catalogs → quantify it and use provider filters before implementing tool-level discovery.

## Migration Plan

1. Inventory canonical state, native discovery paths, ownership records, and host overlays without resolving credentials into reports.
2. Select verified duplicates; check their replacement gateway or shared Skill source; apply backed-up changes and verify effective native discovery.
3. Plan ordinary MCP gateway routes with exactly the existing server set per Agent. Preserve native OAuth, unrelated entries, and current Skill delivery.
4. Pilot one eligible OAuth provider on one Agent under a separate label. Complete the grant as a human and validate the new connection.
5. Enable compatible routes for all receivers before changing the primary owner. Complete the primary grant and verify it before retiring the pilot.
6. Record private evidence and explicit backup run IDs. On failure, restore affected configuration by run ID; preserve Agent credentials and use a fresh native authorization only if that Agent requires it.

The local duplicate cleanup can be completed independently. OAuth migration, reusable governance tooling, other-Agent Skill discovery suppression, and tool catalog filtering remain separately tracked work.
