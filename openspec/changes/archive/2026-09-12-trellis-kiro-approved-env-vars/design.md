## Context

Found by reading Kiro's real, installed extension source directly
(`/Applications/Kiro.app/Contents/Resources/app/extensions/kiro.kiro-agent/dist/extension.js`),
not documentation or assumption:

```js
function Nz(t, e) {                                   // expandEnvironmentVariables
  if (typeof t === "string") {
    let a = ... vscode.workspace.getConfiguration("kiroAgent").get("mcpApprovedEnvVars", []);
    return t.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (l, u) => {
      if (a && !a.includes(u)) { /* record as unapproved */ return l; }  // returns literal, unresolved
      let d = o?.[u] ?? process.env[u];
      return d !== undefined ? d : (n ? "" : l);
    });
  }
  if (Array.isArray(t)) return t.map(r => Nz(r, e));
  if (t && typeof t === "object") { /* recurse into every value, including headers[].value */ }
  return t;
}
```

This runs on the whole parsed `mcp.json` object tree (recursively,
including a server's `headers` array entries, not just `env`) before
Kiro's own zod schema validation, and again just before spawning. A name
absent from `kiroAgent.mcpApprovedEnvVars` is never substituted — no
error, no log the average user would see, just a literal `${VAR}` string
handed to the spawned server, which then fails to authenticate.

On this real machine, `~/Library/Application Support/Kiro/User/settings.json`
has no `kiroAgent.mcpApprovedEnvVars` key at all (confirmed by direct
read) — an empty allow-list, the default state for anyone who hasn't
manually added to it via Kiro's own settings UI.

## Goals / Non-Goals

**Goals**
- Any env var name Trellis's Kiro adapter references via `${VAR}` in
  `~/.kiro/settings/mcp.json` actually resolves at runtime, without a
  human having to separately discover and populate this setting by hand.
- Purely additive: never remove or reorder an existing entry in
  `kiroAgent.mcpApprovedEnvVars`, never touch any other key in a file
  that holds hundreds of unrelated editor preferences.

**Non-Goals**
- `headers`-based names (out of scope — separate change, no `headers`
  field exists in `McpServerDef` yet).
- Non-macOS paths (Non-Goals in proposal.md).
- Any UI/prompt-based flow — this is a config generator, not an
  interactive settings manager; if Kiro's own UI later requires
  confirming new entries interactively, that's outside what a config
  write can satisfy, and is called out as an open question, not solved
  here.

## Decisions

### D1 — A new `AdapterPlanItem.kind`, not an extension of `kind: "mcp"`

`kind: "mcp"`'s write mechanism (JSON merge under `mcpServers`, or TOML
section splice) and target (an MCP-specific config file) don't fit this
surface at all — different file, different key (`kiroAgent.mcpApprovedEnvVars`,
a flat string array), different merge semantics (union of names, not a
per-server dict merge). A new kind, `"kiro-approved-env-vars"`, keeps
`kind` meaning "one write mechanism," consistent with why `"extension"`
got its own kind in P4 rather than being folded into `"skill"`.

`AdapterPlanItem` gains one new optional field, `approvedEnvVars?: string[]`
— the full, already-deduplicated array to write when `action === "create"`,
mirroring how `mcpWrite` carries `{name, def}` for `kind: "mcp"`.

### D2 — Names come from `resolveMcpPlan("kiro", canonical.mcp)`, not a raw scan of `canonical.mcp.servers`

Reusing the existing scope/collision-aware resolution (P2's
`resolveMcpPlan`) means a server that's scoped away from Kiro, or that's
refused as a `known_host_injected` collision, never contributes its env
names to the approved list either — Trellis shouldn't approve a
variable name for a server it isn't even writing into Kiro's config.

### D3 — Write path: parse whole file, union the one key, write whole file back

```
target: ~/Library/Application Support/Kiro/User/settings.json  (macOS only — see Non-Goals)
```

Same discipline as `jsonMcp.ts`'s `applyJsonMcp`: parse the whole object
(or `{}` if the file doesn't exist), spread every existing top-level key
through untouched, and only ever set
`merged["kiroAgent.mcpApprovedEnvVars"] = [...new Set([...existing, ...desired])]`
— existing entries are never dropped, order of pre-existing entries is
preserved (new names appended at the end via `Set` insertion order).

A JSON parse failure on this file (a real risk — it's a large,
hand-editable file with a real chance of being mid-edit or containing a
trailing-comma-style syntax error from some other tool) produces a
`"conflict"` plan item, never a silent overwrite of a file Trellis can't
safely parse.

### D4 — No-op detection before writing

`plan()` reads the current array (if any) and computes the same union;
if it already equals the existing array (as a set), no plan item is
emitted at all — re-running `trellis sync`/`trellis mcp sync` against an
already-correct machine reports nothing to do, same idempotency
guarantee every other adapter already provides.

## Risks / Trade-offs

- **This is the most invasive file Trellis has ever written to** — a
  general editor settings file, not something scoped to Kiro's agent
  behavior alone. Mitigated by the strictly additive, single-key,
  whole-file-preserved write discipline above, and by scoping this
  change narrowly (one key, never anything else in that file).
- **Kiro's own settings UI might expect changes to flow through its own
  API/IPC rather than a direct file write** (common in Electron/VS-Code-
  family apps for cache-consistency reasons) — this project has not
  verified whether a direct file write while Kiro is running is picked
  up live or requires a restart. Recorded as an Open Question, not
  assumed either way.

## Migration Plan

Fully additive and backward compatible — a machine with no Kiro-managed
secrets sees no plan item at all (empty desired-names set).

## Open Questions

- Does Kiro need to be restarted to pick up a settings.json change made
  while it's running, or does it hot-reload (common for VS-Code-family
  settings)? Not verified — call this out in the command's own output
  rather than silently assume either answer.
- Should `trellis doctor` also report Kiro's *current*
  `kiroAgent.mcpApprovedEnvVars` state as part of its read-only scan
  (visibility without requiring a `sync` run)? Left for a future change,
  not solved here.
