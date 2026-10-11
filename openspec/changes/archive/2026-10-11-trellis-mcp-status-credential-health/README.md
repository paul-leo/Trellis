# trellis-mcp-status-credential-health

Make `trellis.mcp.status` fully answer an Agent's "what MCPs do I have
and what's wrong": structured tool counts on gateway upstreams, plus
credential health for OAuth-classified servers that bypass the gateway
entirely.

- [proposal.md](proposal.md) — why this exists, what changes
- [design.md](design.md) — D1–D5: `credential` not `status`, one
  classifier with expiry surfaced, strictly read-only, plan-derived
  server set, additive output shape
- [specs/mcp-auth-guidance/spec.md](specs/mcp-auth-guidance/spec.md) —
  spec delta (ADDED requirements on the status tool's owning capability)
- [tasks.md](tasks.md) — implementation checklist

Key constraint carried from earlier designs: the status tool never
contacts a token endpoint and never refreshes — interactive
authorization remains exclusively `trellis mcp auth`
(mcp-gateway-hosting design.md D9), renewal remains `trellis mcp renew`
(trellis-mcp-oauth-renew).
