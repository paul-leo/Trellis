# Design

## Context

See proposal.md. The runtime has a provider registry and the local backend owns
upstream connections. SDK v1 is also used by probes and test fixture servers.

## Goals / Non-Goals

Serve and connect both protocol eras and relay declared skills. Skill activation,
installation and arbitrary cross-server reads are outside this change.

## Decisions

1. Adopt the stable v2 client/server packages at the connection and runtime
   boundaries. Keep legacy dependencies only where unmigrated consumers need
   them; do not pass SDK class instances across versions. Use official
   `serveStdio` with legacy serving and client `versionNegotiation: auto`.
   A dependency bump alone does not enable modern traffic.
2. Advertise the Skills extension in modern discovery. Register its methods
   with explicit schemas and preserve old Trellis tools and resources.
3. Extend GatewayBackend with optional resource and skill operations. Inspect
   upstream capabilities before listing tools; a resource-only server is valid.
   Only a declared Skills extension is treated as an upstream skill catalog.
4. Map each upstream URI to a reversible source namespace whose final path
   segments stay intact, so relative references still resolve. Rewrite entry,
   manifest and response URIs consistently; preserve frontmatter and content
   bytes/digests. Keep the upstream label and original URI in provenance metadata.
   Accept reads only for resources registered from that upstream's listings or
   skill manifests. Skill get supports direct lookup via a mapped URI.
   The outer response retains Trellis identity; upstream identity stays in
   provenance. Relayed reads use private caching.
5. Bound listings, use complete pagination and isolate failures per upstream.
   No speculative file reads while listing. Skill reads validate manifest size
   and digest before returning bytes; changed content fails until entry refresh.
   Stdio framing is bounded at 128 MiB to accommodate JSON escaping of a valid
   16 MiB file; decoded skill manifests retain their 16 MiB total limit.

## Risks / Trade-offs

- Protocol migration changes SDK types and lifecycle → legacy integration tests
  and real modern stdio/client tests, including process cleanup.
- URI mapping changes visible URIs → one shared mapper for catalogs and reads;
  collision and relative-path tests.
- Broken upstream metadata → reject that skill with a diagnostic, not the whole
  catalog. Do not interpret a matching digest as trust or approval.

## Migration Plan

Install v2 dependencies, migrate boundaries, add relay, validate both eras and
existing tests. No user config migration is needed. Rollback restores prior
runtime behavior without altering canonical skills.
