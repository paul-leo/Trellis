# Tasks

## 1. Renderer

- [x] 1.1 `src/adapters/piMcp.ts`: `piRenderer(def)` — stdio →
  `{command, args, env?}` with `${VAR}` env references; http →
  `{url, headers?}`; agent-owned OAuth http → bare `{url}`; no `type`
  field anywhere
- [x] 1.2 Unit tests pinning the shape against the observed pi 1.1.0
  mcp.json format (stdio with env refs, http with headers, bare OAuth
  url, sse → conflict item)

## 2. Adapter

- [x] 2.1 `PiAdapter.plan`: parse probed pi version; ≥ 1.1.0 → plan
  mcp.json items via `planJsonMcp` (ownership ledger wired like
  claude-code's); < 1.1.0 or unparseable → today's bridge-only plan
- [x] 2.2 Version-gated bridge removal: when native delivery activates
  and the Trellis-owned bridge symlink exists, plan its removal,
  ordered after the mcp.json items; skip removal when any mcp.json item
  conflicted
- [x] 2.3 `PiAdapter.verify`: mcp.json drift checks (missing/altered
  desired entries, stale Trellis-owned entries, surviving bridge symlink
  under native delivery); user entries never flagged
- [x] 2.4 Unit tests: version gate both directions, ordering assertion,
  duplicate-prevention (bridge removal planned iff native written),
  merge preservation of a pre-existing user entry (`mailbox` fixture)

## 3. Sync UX

- [x] 3.1 Sync reporter: pi mcp.json changes append "restart pi or run
  /reload to pick up MCP changes"

## 4. Specs and docs

- [x] 4.1 Spec delta: `mcp-server-sync` ADDED requirement (pi native
  delivery + version gate + migration semantics)
- [x] 4.2 Spec delta: `pi-mcp-bridge` requirements marked superseded for
  pi ≥ 1.1.0, pending the follow-up deletion change
- [x] 4.3 Fix stale "pi has no native MCP client" claims:
  `src/adapters/pi.ts` header, `docs/research.md`
- [x] 4.4 `docs/getting-started.md`: pi section rewritten for native
  delivery incl. `pi mcp login` for agent-owned OAuth servers
- [x] 4.5 `docs/mcp-oauth-renewal.md`: ownership table gains pi row
  (agent-owned → `pi mcp login`, trellis-owned → runtime, unchanged)

## 5. Verification

- [x] 5.1 `npx tsx --test` full suite green; typecheck; build
- [x] 5.2 Sandbox integration: fixture HOME + canonical, gateway mode →
  mcp.json has the `trellis` runtime entry and agent-owned direct
  entries, bridge symlink removed, second sync idempotent, user entry
  preserved byte-for-byte; direct and hub routes likewise
- [x] 5.3 Sandbox integration: pi < 1.1.0 fixture → bridge plan
  unchanged, mcp.json untouched
- [x] 5.4 Real machine, read-only: `trellis sync --dry-run` pi section
  review (must show mcp.json create/update + bridge symlink removal,
  `mailbox` untouched)
- [x] 5.5 Real machine, authorized: real sync → `pi mcp list` lists the
  runtime entry connected with tools (end-to-end proof), `mailbox` still
  connected, bridge extension gone from `~/.pi/agent/extensions/`
- [x] 5.6 Confirm no double tool registration in `pi mcp list` output

## 6. Ship

- [ ] 6.1 New branch off `origin/main` (after PR #5 merges), commit, PR
- [ ] 6.2 `openspec archive pi-native-mcp-migration --yes` after merge
- [ ] 6.3 File the follow-up change: delete `src/pi-bridge/`,
  `scripts/build-pi-bridge.mjs`, fallback gate, `pi-mcp-bridge` spec
