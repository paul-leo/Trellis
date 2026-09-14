## Why

`trellis migrate --only mcp`'s conflict check (`planMcpServer`) compares
the freshly-read `McpServerDef` against canonical's existing entry with
plain `deepEqual` — any structural difference is a hard conflict,
"resolve by hand." This means when Trellis's own migrate-read
classification logic improves (as `envAliases` just did:
`trellis-migrate-env-var-alias`), re-running migrate on already-migrated
data does NOT pick up the fix — it reports a conflict instead, because
the old `staticEnv` entry and the newly-classified `envAliases` entry are
structurally different `McpServerDef`s, even though they represent the
exact same source value, just filed under a more precise field now.
Confirmed on this real machine: notion's canonical entry is still the
stale, broken `staticEnv` shape from before the fix, and re-running
migrate refuses to update it.

This defeats the entire point of the fix for anyone who migrated before
it shipped: "migrate, then it just works" only holds for a fresh
migration, not for repairing one that predates a classification
improvement.

## What Changes

- `planMcpServer` gains a narrow, precise "safe reclassification" check:
  when the *only* difference between an existing canonical entry and a
  freshly-read one is that a value moved between `staticEnv` (literal)
  and `env`/`envAliases` (reference) while remaining the exact same
  underlying `${...}` text, this is not a real conflict — it's the same
  value, more correctly classified. A new `MigrateAction` value
  (`"reclassify"`) is applied automatically, the same as `"create"`, and
  reported distinctly so it's visibly different from a brand-new addition.
- Any other structural difference (a real value change, a different
  command, a genuinely new/removed field) still conflicts exactly as
  before — this does not weaken the existing "never silently overwrite a
  real customization" guarantee anywhere.

## Capabilities

### Modified Capabilities
- `canonical-source-migration`: `planMcpServer`'s conflict detection
  distinguishes a safe reclassification from a real conflict, and
  `applyMigratePlan` applies a `"reclassify"` item the same way it
  applies `"create"`.

## Impact

- `src/commands/migrate.ts`: `MigrateAction` gains `"reclassify"`;
  `planMcpServer` gains the safe-reclassification check;
  `applyMigratePlan`'s `item.action !== "create"` guard extends to allow
  `"reclassify"` through the same `mcp` branch.
- No change to `mcp sync`'s own write path, `McpServerDef`'s shape, or
  any adapter.
