# Design

## D1: Renew reuses `ensureFreshToken` verbatim — no new OAuth logic

The refresh path in `src/lib/oauth/refresh.ts` already carries the
hard-won semantics: read → `isExpired` with skew → per-server lock →
re-read inside the lock → single refresh request → write via
write-then-rename. `trellis mcp renew` is an *orchestrator* over that
function across the canonical OAuth server set, nothing more. Any
renewal-specific smarts (e.g. pre-emptive refresh of a token that is
still valid) would create a second semantics that can drift from the one
the gateway actually relies on; the skew window inside `isExpired`
already is the pre-emption margin, and widening it is a `skewMs`
parameter, not new code.

## D2: Status classification is derived, not stored

Each server resolves to exactly one status, computed at report time from
the stored token file and (for non-dry-run) the token endpoint:

- `no-token` — nothing stored; renewal can do nothing; points at
  `trellis mcp auth`.
- `valid` — stored, not expired (within skew).
- `refreshed` — was expired (or within skew), refresh succeeded.
- `expired-renewable` — dry-run only: expired but a `refreshToken`
  exists, so a real run would attempt refresh.
- `refresh-failed` — refresh attempted and failed (network or grant
  rejected). Distinct re-authorization messaging from `needs-auth`
  because the grant may be revoked.
- `needs-auth` — stored but expired and no `refreshToken`, or refresh
  definitively rejected the grant.
- `unreadable` — token file failed the grandfathered
  malformed-entry/handling path (read returned undefined after existing
  on disk); treated as needing attention, never silently skipped.

Nothing is persisted: the next run recomputes from the same source of
truth the gateway reads, so doctor and renew can never disagree with
what a session will actually experience.

## D3: Launchd throttling, not in-process scheduling

Trellis has no daemon (mcp-gateway-hosting design.md D2's whole point).
Periodic renewal is the platform scheduler's job: a launchd plist running
`trellis mcp renew --json` writes to a log file. The plist carries a
`ThrottleInterval` so a machine waking from sleep with a backlog runs
once, not N times — refresh endpoint hammering is the failure mode that
gets refresh tokens revoked by rate-limiting providers, which is worse
than the disease. The command itself is already safe to run concurrently
(the per-server lock serializes refreshes; two overlapping runs degrade
to one doing the work and one reading the fresh token).

## D4: Doctor integration is read-only

`mcp renew` mutates (it refreshes). `trellis doctor` is documented as a
read-only scan and stays that way: its OAuth section reads token files
and classifies without ever contacting a token endpoint. An expired
credential might be refreshed by the next gateway call — that is fine;
doctor's job is to surface "your stored credential is currently dead or
dying", and the finding text says exactly that, naming `trellis mcp
renew` (attempt silent refresh now) and `trellis mcp auth <name>`
(re-authorize) as the two remediations.

The new finding kind `oauth-expired` joins `EXIT_NONZERO_KINDS`:
a credential that will 401 on next use is exactly the class of thing
doctor exists to catch before it happens (mirroring the rationale
comment on `detectCollisions`).

## D5: Scope is canonical `auth: oauth` servers only — no inference

Consistent with mcp-auth-routing-policy's core requirement: OAuth
classification is explicit. Renew iterates `servers.yaml` entries where
`isOAuthAuth(def.auth)` is true. A server with a token file but no OAuth
classification is not touched (and orphan token files are not renew's
problem — scope creep that would couple this change to a cleanup
feature). A server classified OAuth with no token file gets `no-token`
status, which is the correct actionable report.

## D6: Exit codes compose with schedulers

- `0` — every classified server resolved to `valid` or `refreshed`
  (including the vacuous case of zero OAuth servers).
- `1` — any server is `refresh-failed`, `needs-auth`, `no-token`, or
  `unreadable`.

`no-token` failing the run is deliberate: a classified-but-never-
authorized server is a misconfiguration the user asked to be told about.
Scripting that wants "only warn" consumes `--json` and decides itself.

## D7: No gateway/pi-bridge behavior change

Nothing in the runtime path changes: `withOAuthHeader` keeps refreshing
before calls exactly as today. Renew is purely additive — it moves the
*first* refresh attempt earlier (to a scheduled, observable context) and
makes failures visible outside a session. If renew never runs, every
existing behavior is preserved bit-for-bit.
