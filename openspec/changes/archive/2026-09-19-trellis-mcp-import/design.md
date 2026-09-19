# Design

## Import boundary

Read one JSON file with a top-level `mcpServers` object. Accepted entries are
the standard command/args/env or type/url/headers shape. The source is always
read-only.

## Credential handling

- Exact `${NAME}` values become `env` or `env_aliases` references.
- Credential-like literal `env` values are written to
  `~/.trellis/mcp/servers.local.env` as
  `TRELLIS_<SERVER>_<TARGET_KEY>`, and the canonical definition maps the
  original target key to that generated source name through `env_aliases`.
- Non-secret literal env values become `static_env`.
- Credential-looking values in args, command, URL, or headers are conflicts;
  args have no portable interpolation contract and headers are not uniformly
  supported by every native adapter. The importer never stores them in
  canonical.
- Secret writes update `secrets.policy.yaml`, `.gitignore`, and the shell env
  source through the existing idempotent, backup-aware helpers.

## De-duplication

The importer first compares the source name with the canonical name:

1. Same semantic definition: already-present, no write.
2. Same name but different non-secret definition: conflict, no write.
3. Different names with the same semantic identity: duplicate, no write.
4. Otherwise create.

Semantic identity includes transport, command, non-secret args/url, auth,
enabled state, scope, static values, and environment/header target names, but
not secret values or generated secret variable names. Existing canonical
definitions and secrets always win; an import never overwrites them.

## Transaction

The real import uses one `BackupSession` for canonical YAML, local env,
secrets policy, `.gitignore`, and shell rc writes. Dry-run performs no writes
and reports only names, actions, and redacted remediation.
