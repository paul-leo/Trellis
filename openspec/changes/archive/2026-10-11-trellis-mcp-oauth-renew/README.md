# trellis-mcp-oauth-renew

Scheduled, non-interactive renewal of stored OAuth tokens, plus credential
health reporting in `trellis doctor` and a documented launchd setup.

- [proposal.md](proposal.md) — why this exists, what changes
- [design.md](design.md) — D1–D7: reuse of `ensureFreshToken`, derived
  statuses, scheduler throttling, read-only doctor, explicit-classification
  scope, exit codes, no runtime behavior change
- [specs/mcp-oauth-renewal/spec.md](specs/mcp-oauth-renewal/spec.md) — spec
  delta (ADDED requirements)
- [tasks.md](tasks.md) — implementation checklist

Key constraint carried from earlier designs: renew never opens a browser
and never performs an initial grant — that remains `trellis mcp auth`
(mcp-gateway-hosting design.md D9).
