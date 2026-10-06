# Local validation

Validated on 2026-10-06 in an isolated branch based on origin/main
`1d3a15ac8287b6863223333550562c0cf649e7ee`, using its own installed dependencies.
The original working tree was not edited.

| Check | Result |
| --- | --- |
| Root `npm test` | 850 passed, 0 failed |
| Root `npm run typecheck` | Passed |
| Root `npm run build` | Passed |
| GUI `sidecar:test` | 52 passed, 0 failed |
| GUI `sidecar:typecheck` | Passed |
| GUI `test:smoke` | 9 passed, 0 failed |
| GUI `build` (frontend TypeScript and Vite) | Passed |
| GUI `test:oauth-browser` | 1 passed, with real headless Google Chrome |
| Both OpenSpec changes, strict validation | Passed |
| `npm run verify-pack`, isolated install without dev dependencies | Passed |

The browser test uses a local authorization server with enforced PKCE. It checks
native credential isolation, hosted authorization, status refresh, cancellation,
retry, owner confirmation and enabling/clearing OAuth from an unclassified
remote connection. No real provider login or personal credential was used.

Protocol tests cover modern-only stdio peers, legacy peers, modern discovery and
wire metadata, source-bound equal-named skills, direct lookup, pagination without
prefetch, manifest refresh, provenance and an 11 MiB resource exceeding the old
default frame limit. OAuth tests cover resource indicators, callback issuer,
changed configuration, timeout and cancellation while waiting for a refresh lock.

Two pre-existing timing-sensitive tests were stabilized: success-path fake shell
fixtures use a separate startup allowance while the 200ms deadline test remains;
the watcher debounce test waits for actual event delivery before its quiet window.

Limits: dynamic skill manifests are declined. Native Agent credential state is
reported as unknown instead of inferred from Trellis's token store. Stdio frames
are bounded at 128 MiB to support JSON escaping of a valid 16 MiB skill file;
decoded skill manifests keep the 512-file/16-MiB limits.

Desktop application packaging, installed-app acceptance, version publication and
replacement of `/Applications` are deferred.

Logs retained locally:
- `/tmp/trellis-mr-850-root.log`
- `/tmp/trellis-mr-52-sidecar.log`
- `/tmp/trellis-mr-9-smoke.log`
- `/tmp/trellis-desktop-final-closure.log`
- `/tmp/trellis-mr-verify-pack.log`
