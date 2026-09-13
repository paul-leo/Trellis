## MODIFIED Requirements

### Requirement: The bridge resolves declared env values through the shared resolver, never raw ambient process.env directly

When connecting to a stdio MCP server, the bridge SHALL obtain each
declared `env` name's value, and each declared `envAliases` entry's
source-name value, via `resolveSecretEnv` (from `secret-env-resolution`)
rather than reading `process.env` inline — never merging an
`envAliases` value as a raw, unresolved literal the way `staticEnv` is
merged. This makes the bridge's own credential exposure controllable by
`secrets.policy.yaml`'s `env_file`, instead of unconditionally
inheriting everything the parent `pi` process's environment happens to
contain, and closes the gap where a differently-named reference
(misclassified before this change existed) would otherwise reach the
spawned server as an unexpanded literal placeholder string.

#### Scenario: With no env_file set, behavior is unchanged from before this requirement existed
- **WHEN** `secrets.policy.yaml` has no `env_file` field
- **THEN** the bridge's stdio connection still receives each declared
  name's value from `process.env`, identical to pre-existing behavior

#### Scenario: With env_file set, only that file's values reach the spawned server
- **WHEN** `secrets.policy.yaml` sets `env_file` to a path containing
  the values a server's declared `env` names need
- **THEN** the spawned MCP server subprocess receives those values, and
  the bridge never reads the parent `pi` process's own `process.env` for
  those names

#### Scenario: An envAliases entry is resolved by its source name and delivered under its target key
- **WHEN** a canonical server declares `envAliases: { OPENAPI_MCP_HEADERS:
  NOTION_OPENAPI_MCP_HEADERS }` and `NOTION_OPENAPI_MCP_HEADERS` has a
  real value in the resolved secrets source
- **THEN** the spawned MCP server subprocess receives that real value
  under the env var name `OPENAPI_MCP_HEADERS` — never the literal text
  `${NOTION_OPENAPI_MCP_HEADERS}`
