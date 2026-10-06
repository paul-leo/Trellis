# MCP hosting and duplicate governance

Use one canonical source, a gateway for ordinary MCP connections, and explicit
authorization ownership for remote OAuth. This workflow applies to v0.12.0.
The related OpenSpec change describes reusable governance tooling; that tooling
is planned, not an additional installed CLI command.

## Inventory before changing discovery

Inspect `trellis manage list`, `trellis mcp list --json`,
`trellis skill list --json`, `trellis doctor --json`, and both sync previews:

```sh
trellis sync skills --dry-run --json
trellis mcp sync --dry-run --json
```

Compare native configurations with the canonical source and ownership ledger.
Compare repository Skills with their canonical contents and resolved paths.
Keep account values and credentials inside the comparison process; reports
need names, source paths, and equality flags only.

| Finding | Treatment |
| --- | --- |
| Native definition exactly matches a working gateway upstream | Select the native entry for backed-up removal. |
| Same command, different account, environment, endpoint, or arguments | Keep both until the operator chooses the authoritative configuration. |
| Multiple Agent links point to the same canonical Skill | Retain shared delivery links; they are not extra physical copies. |
| Identical repository and shared Skills are both enabled | Suppress the selected local discovery path where the Agent supports it. |
| External entry has no equivalent verified source | Preserve it outside the consolidation plan. |

Ordinary `mcp sync` removes entries only when the ledger proves ownership and
the entry still matches what Trellis wrote. A matching unowned entry is not
automatically adopted or deleted. An explicitly selected operator cleanup can
reuse Trellis's merger and backup system; it must check the inspected snapshot
and preserve unrelated entries. Record the backup run ID.

## Consolidate Skills without removing portable project files

Keep the shared canonical Skill available across projects. Codex can disable
an identical repository copy by its absolute `SKILL.md` path in the operator's
local `~/.codex/config.toml`:

```toml
[[skills.config]]
path = "/path/to/repository/.codex/skills/example-skill/SKILL.md"
enabled = false
```

Verify through Codex's read-only `skills/list` interface that one shared copy
stays enabled, including from a different working directory. Keep repository
files for contributors without the same global configuration. Reload the
native client after applying the change. A host-specific configuration home
and an already loaded catalog need separate verification.
[Codex documentation](https://learn.chatgpt.com/docs/build-skills#enable-or-disable-local-codex-skills).

Check each other Agent's discovery behavior before applying analogous controls.
Claude Code resolves a same-named personal/project Skill in favor of the personal
source, so matching project files alone do not establish duplicate active
discovery. [Claude Code precedence](https://code.claude.com/docs/en/skills#resolve-skills-that-share-a-name).
Keep executable helper paths working. v0.12.0 selects native/MCP Skill delivery
per Agent; it does not select delivery separately for individual Skills. Scope
narrowing also removes a Skill from that Agent's Runtime catalog, so it cannot
hide native discovery while retaining Runtime access.

## Target connection policy

| Connection | Target |
| --- | --- |
| Ordinary stdio or API-key MCP | Gateway/runtime with existing Agent scope and environment bindings. |
| OAuth accepted under an independent Trellis identity | Explicit `owner: trellis` after registration, grant, and live verification. |
| OAuth restricted to approved clients | The provider-supported Agent's native connection until Trellis has an approved registration. |

Gateways are spawned per Agent session. Shared definitions and hosted
credentials do not create one machine-wide upstream process. Native Agent
credentials remain in that Agent's custody.

Sentry accepts compatible MCP clients and supports organization/project-scoped
endpoints. Supabase explicitly supports dynamic client registration and can
limit its tool feature groups. These are suitable first pilot candidates.
[Sentry](https://mcp.sentry.dev/),
[Supabase](https://supabase.com/docs/guides/ai-tools/mcp).

Morphix publishes a registration endpoint and is a candidate for a fresh grant;
metadata alone does not establish policy. Figma restricts access to clients in
its approved catalog; a registration endpoint does not remove that restriction.
[Figma policy](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/#which-mcp-clients-are-supported).

## Stage 1: ordinary MCP routing

Use existing per-Agent route controls or an onboarding capability-selection
file. Preserve the managed set, selected servers, and Skill delivery modes.
A route-only selection can exclude new migrations:

```yaml
skills: none
mcp_servers: none
memories: none
memory_migration: none
mcp_routes:
  codex:
    mode: gateway
    servers: [browser-tools, sentry]
```

Use the actual current server set, not this illustrative list. Preview the full
onboarding transaction before apply; sync, memory, secret-audit, and verification
stages still run. Preserve unrelated native entries and Agent-owned OAuth. Do
not narrow scope or change Skill delivery incidentally during route migration.

## Stage 2: an isolated OAuth pilot

`auth.owner` belongs to a canonical server definition. Changing it changes the
owner for every receiver; it is not a per-Agent setting.

For one Agent, create a separate label such as `sentry-hosted-pilot`, scope it
to that Agent, and reuse the intended endpoint without broadening its project
or organization scope. Select explicit Trellis ownership. Include the pilot
label in that Agent's gateway route and exclude the original label there.
Other Agents keep the original native connection.

A human completes the grant through desktop Authorize or the CLI after
ownership and route checks:

```sh
trellis mcp set sentry-hosted-pilot --auth oauth --auth-owner trellis
trellis mcp sync --dry-run --json
trellis mcp auth sentry-hosted-pilot --force
```

This assumes the pilot and compatible route already exist. Verify
resource/issuer-bound storage, live initialization, tool/resource discovery,
and one intended read-only operation. Do not copy Agent credentials, old
unbound tokens, or credentials from another label into the pilot.

## Stage 3: primary cutover

Ensure every receiver has a compatible gateway/runtime route before changing
the primary owner. Preview the change, authorize the primary label independently,
and verify it before retiring the pilot. Keep native credential stores intact;
a pilot token is not copied to the primary token file.

On registration or grant failure, preserve the native route and report the
provider's remediation. A gateway never starts browser authorization itself.
Desktop hosted authorization provides progress, cancellation, and retry.
Native authorization uses the relevant Agent's supported flow.

## Acceptance and rollback

Report these separately:

- Configuration: no relevant pending sync items or conflicts.
- Native discovery: selected duplicates gone or disabled; shared source enabled.
- Credentials: owner, resource/issuer binding, expiry/refresh metadata, and
  storage permissions; no credential values in reports.
- Live readiness: initialization, discovery, and the selected read-only check.
- Lifecycle: the verification client and its own processes close within a
  bounded timeout.

A default doctor does not handshake upstreams. A token file does not prove
authorization. Keep machine inventories, account choices, commands, and backup
IDs in local governance records outside the repository.

```sh
trellis rollback RUN_ID --dry-run --json
trellis rollback RUN_ID
```

Restore in reverse application order. Preserve later edits by reporting
rollback conflicts rather than forcing restoration.

## Tool catalog optimization is separate

The gateway currently connects selected upstreams at startup and exposes their
full tool lists. Native entry consolidation can remove duplicate discovery
while leaving the gateway's catalog unchanged. Measure entry count, tool
count, enabled Skill count, and readiness separately.

Use upstream controls first: Supabase's feature groups/project scope and
Sentry's organization/project endpoint can limit tools. Per-tool filtering and
lazy discovery need follow-up implementation; v0.12.0 has no such controls.
