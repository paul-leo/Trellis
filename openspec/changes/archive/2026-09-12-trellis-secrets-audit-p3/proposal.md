# trellis-secrets-audit-p3

## Why

Two real incidents already on record (docs/research.md "Secrets") motivate a
linter, not just a convention: a GitLab PAT stored under the *wrong variable
name* in a generated MCP config (a naming bug the P2 pre-write literal-value
guard cannot catch — it only rejects values that look like a credential, not
names that don't match what's expected), and `MCPR_TOKEN` existing in three
divergent values across three different config files simultaneously, one
silently invalid. `trellis secrets audit` (P3) closes this: it reads every
MCP-capable agent's *actual output file* (not the canonical source — the
point is catching what actually landed on disk, including anything the
adapter didn't write) and fails non-zero on either a literal-credential-shaped
value or a variable name outside the declared allow-list.

## What Changes

- `src/core/canonical.ts`: parse `~/.trellis/secrets.policy.yaml` into
  `CanonicalSource.secretsPolicy` (`allowedVars`, `rejectPatterns` compiled
  from string patterns). Missing file → empty policy, not an error — same
  precedent as `mcp/servers.yaml`.
- `src/lib/envVarNames.ts`: extracts the environment-variable **names** an
  agent's real MCP config file declares — `mcpServers.*.env` object keys for
  Claude Code/Kiro's JSON, `env_vars = [...]` array values for Codex's TOML
  — without a general parser (JSON.parse for JSON; a narrow, single-purpose
  line regex for TOML, same "don't build more than what's needed" posture as
  `src/lib/tomlSection.ts`, which this module does not depend on or reuse —
  audit is read-only, section-splicing is not a read-only concern).
- `src/commands/secretsAudit.ts`: for each present, MCP-capable agent
  (Claude Code, Codex, Kiro — not pi, which has no static generated MCP
  config file to audit, see P4), reads the real file and runs two checks:
  a whole-file scan against `secretsPolicy.rejectPatterns`, and every
  declared env var name against `secretsPolicy.allowedVars`. Reports
  findings, non-zero exit on any.
- `trellis secrets audit` wired into `src/cli.ts`'s existing `secrets` stub.

## Capabilities

- **New**: `secrets-audit` — scans real, on-disk MCP config output for
  literal-credential-shaped values and env var names outside the declared
  allow-list; fails non-zero on any finding; never mutates anything.
- **Modified**: `canonical-source-loading` — adds `secrets.policy.yaml`
  parsing to the existing global-only load contract.

## Impact

No new runtime dependency. JSON is parsed with the existing native
`JSON.parse`; TOML env-var-name extraction is a few-line regex over one
line shape (`env_vars = [...]`), not a parser — the round-trip-fidelity
concern that ruled out TOML libraries for P2's *write* path does not apply
here, since audit never writes anything back, but a full parser is still
more machinery than this one narrow extraction needs.
