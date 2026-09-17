## Why

`trellis migrate --from <agent>` refuses to import any MCP server whose
definition contains a value matching a known credential shape
(`glpat-`, `sk-`, `ghp_`, `mcpr_` — `findLiteralSecret` in
`src/adapters/mcpPlan.ts`, called from `planMcpServer` in
`src/commands/migrate.ts`). Found via real-machine dogfooding: kiro's
own `~/.kiro/settings/mcp.json` has a real, live `mcp-router` server
whose `env.MCPR_TOKEN` is a literal 37-character token, not a `${VAR}`
reference — kiro's JSON format has no structural way to tell the two
apart, so `splitJsonEnvMap` (`src/lib/mcpMigrateRead.ts`) classifies it
as `staticEnv`, and `findLiteralSecret` correctly flags it.

The refusal itself is correct — canonical must never hold a literal
credential, and this project has already paid for getting that wrong
once (`docs/research.md`: `MCPR_TOKEN` existed in three divergent
values across `secrets.env`/`config.toml`/`kiro/mcp.json`
simultaneously, one silently invalid). But today the *only* path
forward is fully manual: rewrite the value in the source agent's own
config to `${VAR}`, add the name to `secrets.policy.yaml`'s
`allowed_vars`, and make sure the real value resolves from somewhere —
three separate hand-edits across two files, for something the tool
already has every piece of information needed to do automatically. A
`staticEnv` entry's dict key (`MCPR_TOKEN`) is already the natural
variable name; there's nothing left to ask the user.

## What Changes

- `trellis migrate` no longer refuses an MCP server for a literal
  secret found specifically in `staticEnv` — it extracts it instead:
  the real value moves to a dedicated, git-ignored file
  (`~/.trellis/mcp/servers.local.env`, a sibling of `servers.yaml` — or
  whatever file `secrets.policy.yaml`'s `env_file` already points at,
  if one is already configured), canonical's `servers.yaml` entry gets
  a `${NAME}` reference instead of the literal, and
  `secrets.policy.yaml` gains that name in `allowed_vars` (and
  `env_file`, if it wasn't already set).
- A literal secret found in `command`, `url`, `args`, or `headers`
  (not `staticEnv`) is unaffected — still refused, exactly as today.
  Those locations have no natural variable name to extract to; naming
  them is deliberately out of scope here.
- `migrate` still never writes to the source agent's own config file.
  The source (e.g. kiro's real `mcp.json`) keeps its literal value
  forever — `secrets audit` will keep flagging that file on every
  future run, which is correct: it's the source's own file, outside
  Trellis's write scope, and cleaning it up is the user's call, not
  this tool's.
- The real value never appears in any Trellis output — not in
  `--dry-run` preview text, not in `--json`, not in a conflict message.
  Only the variable name is ever printed.
- `trellis init`'s bootstrap (or the extraction step itself — design.md
  settles which) ensures `~/.trellis/.gitignore` protects the local
  secrets file, so it can never land in git by omission.

## Capabilities

### New Capabilities

(none — this deepens `canonical-source-migration`, which already
defines migrate's MCP-import behavior)

### Modified Capabilities

- `canonical-source-migration`: the existing (previously undocumented —
  a real gap this proposal also closes) literal-secret refusal
  narrows to `command`/`url`/`args`/`headers` only; a `staticEnv` match
  gets a new, distinct extraction path instead.

## Impact

- Changed: `src/commands/migrate.ts` (`planMcpServer` gains the
  extraction path and a new `MigrateAction`, `applyMigratePlan` performs
  the multi-file write), `src/core/canonical.ts` (a writer for
  `secrets.policy.yaml`'s `env_file`/`allowed_vars`, mirroring
  `writeMcpModeYaml`'s `Document`-based approach; a small append-or-noop
  writer for the dotenv-format local secrets file), `src/commands/init.ts`
  (ensures `~/.trellis/.gitignore` protects the local secrets file).
- Changed: `openspec/specs/canonical-source-migration/spec.md` via this
  change's own spec delta — including backfilling a requirement for the
  existing (previously undocumented) `command`/`url`/`args`/`headers`
  refusal, since this change narrows what it covers.
- Changed: `docs/getting-started.md` (documents the extraction
  behavior and where the local secrets file lives), `docs/roadmap.md`.
- Unchanged by design: `migrate` still never writes to a source agent's
  own config; `sync`/`mcp sync`'s own behavior (they already write
  `${VAR}` references correctly and are untouched); `resolveSecretEnv`
  (`src/lib/secretEnv.ts`) — the extraction writer produces the exact
  plain `KEY=value` line shape it already parses, no new file format.
