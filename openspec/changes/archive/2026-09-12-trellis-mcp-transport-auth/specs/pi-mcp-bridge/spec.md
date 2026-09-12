## ADDED Requirements

### Requirement: The bridge passes resolved headers into remote connections

The bridge SHALL resolve an `http`/`sse`-transport server's `headers`
field values (each a `${VAR}` reference) via `resolveSecretEnv`
(trellis-secrets-env-management) and pass the resolved map as
`requestInit.headers` when connecting.

#### Scenario: A resolved header reaches the remote server's request
- **WHEN** a canonical `http`-transport server declares
  `headers: { Authorization: "Bearer ${TOKEN}" }` and `TOKEN` resolves to
  a real value
- **THEN** the bridge's connection to that server includes an
  `Authorization: Bearer <value>` header on its requests

### Requirement: sse-transport servers connect via a dedicated SSE client

The bridge SHALL connect an `sse`-transport server using the MCP SDK's
`SSEClientTransport`, not `StreamableHTTPClientTransport`, with the same
resolved-headers handling as the `http` path.

#### Scenario: An sse-transport server is registered the same way as an http one
- **WHEN** a canonical server has `transport: "sse"`
- **THEN** the bridge connects via `SSEClientTransport` and registers its
  tools identically to how an `http`-transport server's tools are
  registered
