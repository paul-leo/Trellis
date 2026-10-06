# Proposal

## Why

The MCP Skills extension (`io.modelcontextprotocol/skills`, SEP-2640) is Final.
It lets a server publish Agent Skills over the Resources primitive, with a file
manifest (URI, SHA-256, size) per skill that hosts must verify. Trellis already
serves its skills over MCP, but in its own shape: three tools plus
`trellis://skills/<name>/SKILL.md` resources. A host that understands the
convention cannot use them, and nothing in the output lets a host verify what it
read.

Two facts bound what can be done today:

- The extension is declared only through `server/discover`, introduced with
  protocol revision 2026-07-28. The specification gives no declaration or
  fallback for the `initialize` handshake. The MCP SDK Trellis depends on speaks
  at most 2025-11-25 and has neither `server/discover` nor `skills/*`.
- The runtime's upstream backend aggregates tools only (runtime design D4), so a
  skill published by an upstream server is silently dropped today.

## What Changes

- Serve each in-scope canonical skill as `skill://<name>/SKILL.md` and its
  supporting files as `skill://<name>/<path>` through `resources/list` and
  `resources/read`, alongside the existing `trellis://skills/…` resources and
  tools (which stay).
- Compute a manifest per skill from the bytes actually served: every file's URI,
  `sha256:<hex>` digest and byte size, within the extension's limits.
- Implement `skills/list` and `skills/get` handlers returning the specified
  entry shape and cache fields, so a client that does negotiate the extension
  gets a conforming server.
- Declare the extension only where the negotiated protocol can carry it; on
  revisions that cannot, declare nothing and behave as an ordinary resource
  server, which the specification explicitly allows.
- Record, as constraints for a later change, how upstream skills must be
  relayed.

## Capabilities

### New Capabilities

- `skills-over-mcp-serving`: Trellis serves canonical Skills with verifiable
  manifests in the shape the Skills extension defines.

## Impact

- `src/lib/skillProvider.ts` and `src/lib/mcpRuntime.ts`; a small manifest
  helper. No change to what is on disk or to native skill delivery.
- Non-goals (separate changes): relaying upstream skills through the gateway,
  adopting `server/discover` and stateless transport (blocked on the SDK), and
  materializing an upstream skill into the local skills directory.
