# MCP authorization ownership

Each Agent-owned connection is authorized by that Agent. Trellis does not read,
copy or refresh its credentials. Existing `auth: oauth` and metadata-bearing
OAuth entries default to `owner: agent`. Runtime delivery also retains these
native OAuth entries beside the Trellis runtime.

The MCP desktop view labels native state as unknown and shows the relevant Agent
entry or guidance. A stray Trellis token does not change that state. The view's
credential badge describes stored credentials, not connection health.

## Explicit Trellis hosting

For providers that accept a Trellis registration, opt in per server:

```yaml
auth:
  kind: oauth
  owner: trellis
  # Optional provider-published client identifier:
  # client_id: YOUR_REGISTERED_CLIENT_ID
  # client_secret_env: YOUR_CLIENT_SECRET_VARIABLE
```

Or run `trellis mcp set NAME --auth oauth --auth-owner trellis`, then sync.
Gateway or runtime delivery must be enabled for the receiving Agent. Plain
direct routing reports a conflict rather than moving Trellis's identity into a
native connection. `--auth-owner agent` returns the server to native ownership.
The desktop owner selector previews a plan and requires Apply before changing
canonical configuration and syncing it.

Remote connections without an OAuth classification can choose an owner directly
in the desktop selector. Its No OAuth classification option clears that setting;
neither choice starts a grant automatically.

The hosted desktop Authorize button launches the existing PKCE flow in the
system browser. Progress is observable, cancellation closes the callback, and
timeouts/provider failures permit retry. Repeated clicks share one active job.
Tokens are saved in the existing per-server 0600 store, never sent to the UI.
A changed endpoint/auth configuration during the grant prevents persistence.
Authorization actions require a trusted desktop/development Origin.

New credentials retain their MCP resource and authorization-server issuer.
Authorization, exchange and refresh send the resource indicator; callback issuer
is checked when supplied or advertised as required. A changed resource cannot
receive its previous bound credential. The final save shares the refresh lock,
so a cancelled grant cannot overwrite a concurrent refresh.

The gateway can silently refresh its own hosted credentials; it never opens a
browser. Agents with native connections continue using their own flows.

## Verification

Run core tests and typecheck, GUI sidecar tests/typecheck and GUI smoke tests.
`npm run test:oauth-browser --workspace @trellis/gui` additionally uses installed
Google Chrome headlessly with a local authorization-server fixture. It exercises
real browser CORS, PKCE callback, progress, cancellation, retry and owner
confirmation without contacting a real provider or using personal credentials.
Desktop packaging and installed-app acceptance happen after these checks.
