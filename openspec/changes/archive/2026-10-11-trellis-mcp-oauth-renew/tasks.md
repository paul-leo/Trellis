# Tasks

## 1. Status computation

- [x] 1.1 Add a shared per-server status classifier (server name + stored
  token → derived status per design.md D2), placed so both `mcp renew` and
  `doctor` consume the same computation (design.md D2's "never disagree"
  property depends on this being one function, not two).
- [x] 1.2 Unit tests for every status class in D2: `no-token`, `valid`,
  `expired-renewable`, `needs-auth` (expired, no refresh token),
  `unreadable` — against a scratch home, no network.

## 2. `trellis mcp renew` command

- [x] 2.1 `src/commands/mcpRenew.ts`: iterate canonical OAuth-classified
  servers, call the existing `ensureFreshToken` per server (design.md D1),
  collect statuses, print human and `--json` reports, exit code per
  design.md D6. No credential values in any output path.
- [x] 2.2 `--dry-run`: classify without network or writes; reports
  `expired-renewable` where a real run would refresh.
- [x] 2.3 Wire into `src/cli.ts` dispatch and the usage text's `mcp`
  section.
- [x] 2.4 Unit tests with a fake token endpoint (the existing
  `test/fixtures/fakeAuthServer.ts` pattern): valid no-op (assert zero
  endpoint hits), successful refresh (rotated token persisted),
  refresh-failed → non-zero + remediation text, no-token → non-zero,
  unclassified server with token file untouched, JSON output contains no
  token/secret strings, dry-run performs no writes and no endpoint hits.

## 3. Doctor integration

- [x] 3.1 Add `oauth-expired` to `FindingKind` and `EXIT_NONZERO_KINDS`;
  compute findings from the same classifier as task 1.1, read-only
  (design.md D4); render an OAuth section in `printReport`.
- [x] 3.2 Extend `test/unit/doctor.test.ts`: expired credential → finding +
  non-zero; valid → no finding; absent token on classified server →
  finding; token file present but server unclassified → no finding; no
  canonical source → section absent, doctor still works standalone;
  assert no network access (no fetch seam invoked).

## 4. Scheduler documentation

- [x] 4.1 `docs/` launchd setup: sample plist with `StartInterval` +
  `ThrottleInterval` (design.md D3), `--json` log redirection, install /
  kickstart / uninstall commands, and the explicit note that overlapping
  runs are safe because of the per-server refresh lock.

## 5. Validation

- [x] 5.1 Run the new unit tests plus the existing oauth/refresh, mcpAuth,
  doctor, and cli test files. (Full suite: 822/822 pass.)
- [x] 5.2 Typecheck and build.
- [x] 5.3 Real-machine smoke: `trellis mcp renew` and `trellis doctor`
  against a scratch home with an OAuth-classified server (the real home's
  canonical currently fails to load on a pre-existing `owner` key — see
  below); `--dry-run` reported `no-token` + remediation with exit 1,
  `--json` was credential-free, doctor rendered the OAuth section and
  exited 1 on the `oauth-expired` finding. No real token was refreshed
  (dry-run only).
- [x] 5.4 `openspec validate trellis-mcp-oauth-renew --strict`.

## Pre-existing issue found during smoke (out of scope here)

The real machine's `~/.trellis/mcp/servers.yaml` carries a human
annotation `owner: trellis` inside three `auth:` blocks, which
`canonical.ts`'s strict auth-shape validator rejects — meaning
`loadCanonicalSource` currently fails on this machine for **every**
command that loads canonical (not just renew). Fixing that (accept and
preserve unknown auth metadata keys, or strip them on load with a
warning) is a separate change; it was not folded into this one.
