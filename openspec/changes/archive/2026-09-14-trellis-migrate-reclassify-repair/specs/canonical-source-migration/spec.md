## MODIFIED Requirements

### Requirement: MCP server migration never silently overwrites differing content

The system SHALL compare the source agent's real MCP server definition
against any existing canonical entry of the same name before writing.
Identical content is a no-op (already migrated). A server name not yet
in canonical is created. A different definition under the same name is
either a safe reclassification or a conflict:

- **Safe reclassification**: every field outside `env`/`envAliases`/
  `staticEnv` is identical, and the two definitions' env values resolve
  to the exact same literal/reference text per key — only which of
  `env`/`envAliases`/`staticEnv` a value is filed under changed (e.g.
  after a migrate-read classification fix ships). This is applied
  automatically, the same as a create, and reported distinctly from
  both a create and a conflict.
- **Conflict**: anything else — reported, not overwritten.

#### Scenario: Re-running migrate after a successful MCP import is a no-op
- **WHEN** `trellis migrate --from <agent>` runs again after a prior
  successful import of the same MCP server, and the source agent's
  configuration for it hasn't changed
- **THEN** that server is reported as already migrated, and
  `~/.trellis/mcp/servers.yaml` is not modified for it

#### Scenario: An MCP server that already exists in canonical with a different definition is a conflict
- **WHEN** canonical source already has an MCP server of the same name
  whose definition differs from the source agent's real configuration in
  a way that isn't a pure env-classification shuffle (a real value
  change, a different command, an added/removed field)
- **THEN** the command reports a conflict for that server and does not
  overwrite the existing canonical entry

#### Scenario: A stale env-classification entry is safely repaired, not conflicted
- **WHEN** canonical already has an MCP server whose only difference
  from the freshly-read definition is that a value moved between
  `staticEnv` and `env`/`envAliases` while resolving to the exact same
  literal/reference text (e.g. a `staticEnv` entry containing
  `"${SOME_NAME}"` that now correctly reads as an `envAliases`/`env`
  reference to `SOME_NAME`)
- **THEN** the command updates that server's canonical entry to the
  newly-classified definition, reports it as a reclassification (not a
  create, not a conflict), and does not touch any other server
