## ADDED Requirements

### Requirement: A `${NAME}` env value is recognized as a reference regardless of whether NAME matches its own key

The system SHALL classify a stdio MCP server's env value as a reference
needing resolution whenever it matches exactly `${NAME}` for any valid
variable name — not only when `NAME` equals the key it's declared
under. A same-name reference (`KEY: "${KEY}"`) SHALL populate `env`
(unscoped, self-referencing) exactly as before this requirement existed;
a differently-named reference (`KEY: "${OTHER_NAME}"`) SHALL populate
`envAliases` (`{ KEY: "OTHER_NAME" }`) instead of being treated as a
literal. A value that is not exactly `${NAME}` — no wrapping braces, or
extra text before/after — remains a literal, unaffected by this
requirement.

#### Scenario: A differently-named reference migrates into envAliases, not staticEnv
- **WHEN** a source agent's real config declares an env entry
  `OPENAPI_MCP_HEADERS: "${NOTION_OPENAPI_MCP_HEADERS}"`
- **THEN** the migrated `McpServerDef` has
  `envAliases: { OPENAPI_MCP_HEADERS: "NOTION_OPENAPI_MCP_HEADERS" }`,
  and no `staticEnv` entry for that key

#### Scenario: A same-name reference still migrates into env, unchanged
- **WHEN** a source agent's real config declares an env entry
  `GITLAB_PERSONAL_ACCESS_TOKEN: "${GITLAB_PERSONAL_ACCESS_TOKEN}"`
- **THEN** the migrated `McpServerDef` has
  `env: ["GITLAB_PERSONAL_ACCESS_TOKEN"]`, exactly as before this
  requirement existed

#### Scenario: A genuinely literal value is still a literal
- **WHEN** a source agent's real config declares an env entry
  `TANKA_ENV: "sd-or"`
- **THEN** the migrated `McpServerDef` has `staticEnv: { TANKA_ENV:
  "sd-or" }`, unaffected by this requirement
