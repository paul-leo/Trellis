# Scheduled OAuth renewal — `trellis mcp renew`

The gateway/runtime edge already refreshes OAuth tokens silently before
every upstream call. `trellis mcp renew` moves that renewal *earlier*: run
on a schedule, it refreshes whatever is expiring and reports — with a
non-zero exit code — anything that needs a human, before an Agent session
discovers it as a 401.

```
trellis mcp renew              # refresh what's expiring, report health
trellis mcp renew --dry-run    # report only; no token-endpoint call
trellis mcp renew --json       # machine-readable (no credential material)
```

Scope is canonical OAuth servers with an explicit `owner: trellis` —
classification is explicit (mcp-auth-routing-policy), and ownership decides
whose problem the credential is (trellis-desktop-oauth-ownership): an
agent-owned server (the default, e.g. scalar `auth: oauth`) is authorized by
the Agent's own client, never reads Trellis's token store, and is neither
renewed nor reported here — for pi ≥ 1.1.0 that client-side authorization is
`pi mcp login <name>`, stored in pi's own `~/.pi/agent/mcp-auth.json`. The command never opens a browser and never
performs an initial grant; that remains `trellis mcp auth <name>`
(mcp-gateway-hosting design.md D9). Exit code: `0` when every Trellis-owned
server is valid or refreshed, `1` when any needs `trellis mcp auth`, has
never been authorized, or has an unreadable credential file.

`trellis doctor` reports the same per-server health read-only (no network,
no writes) and surfaces an `oauth-expired` finding — contributing to a
non-zero doctor exit — for credentials that are expired or absent.

## launchd setup (macOS)

Trellis has no daemon; periodic renewal belongs to the platform
scheduler. Save this as `~/Library/LaunchAgents/com.trellis.mcp-renew.plist`,
adjusting the `trellis` path (`which trellis`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trellis.mcp-renew</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/trellis</string>
    <string>mcp</string>
    <string>renew</string>
    <string>--json</string>
  </array>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>ThrottleInterval</key>
  <integer>600</integer>
  <key>StandardOutPath</key>
  <string>/tmp/trellis-mcp-renew.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trellis-mcp-renew.log</string>
</dict>
</plist>
```

Then:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.trellis.mcp-renew.plist
launchctl kickstart gui/$(id -u)/com.trellis.mcp-renew   # run once now
launchctl bootout gui/$(id -u)/com.trellis.mcp-renew     # uninstall
```

Why these knobs:

- **`ThrottleInterval`** (design.md D3) caps how close together runs may
  be. A machine waking from sleep with a launchd backlog runs once, not N
  times — refresh-endpoint hammering is the failure mode that gets refresh
  tokens revoked by rate-limiting providers, which is worse than the
  disease this job exists to prevent.
- **`StartInterval` of 6h** is comfortably inside typical refresh-token
  lifetimes (days to months) while keeping token-endpoint traffic near
  zero: a valid token is a no-op *read*, so most runs make no network
  calls at all.
- **Overlapping runs are safe**: refresh is serialized by the per-server
  lock (`src/lib/oauth/lock.ts`). A second concurrent run waits, then
  reads the token the first one just wrote.
- **`--json` to a log** gives you a parseable trail. A `1` exit means
  "something needs `trellis mcp auth <name>`" — the JSON names which.

Check on demand: `trellis doctor` shows the same per-server credential
health.
