## 1. Shared helper (D1)

- [x] 1.1 `src/lib/mcpMigrateRead.ts`: extract `resolvedEnvTextMap(def:
      McpServerDef): Record<string, string>` from
      `renderJsonServerEntry`'s existing inline `nameRefs`/`aliasRefs`/
      `staticEnv` spread logic. Export it.
- [x] 1.2 `src/adapters/jsonMcp.ts`'s `renderJsonServerEntry`: call
      `resolvedEnvTextMap(def)` instead of re-deriving the same map
      inline. Existing render tests must pass unmodified (pure refactor,
      no behavior change).

## 2. Safe-reclassification detection (D2)

- [x] 2.1 `src/commands/migrate.ts`: new `isSafeReclassification(existing:
      McpServerDef, def: McpServerDef): boolean` — destructure both to
      `{ env, envAliases, staticEnv, ...rest }`, compare `rest` with
      `deepEqual`, compare `resolvedEnvTextMap(existing)` vs
      `resolvedEnvTextMap(def)` with `deepEqual`. Both must hold.
- [x] 2.2 Unit tests: identical-except-classification pair → true; a
      difference in `command`/`args`/`url`/`headers`/`enabled`/`agents`
      alongside an otherwise-identical env classification → false; an
      identical classification with a genuinely different resolved value
      → false.

## 3. `"reclassify"` action (D3, D4)

- [x] 3.1 `src/commands/migrate.ts`: add `"reclassify"` to
      `MigrateAction`. In `planMcpServer`, when `existing !== undefined`
      and not `deepEqual(existing, def)`: check
      `isSafeReclassification(existing, def)` first — if true, return
      `{ kind: "mcp", name, action: "reclassify", detail: "same value,
      only its internal classification changed — safe to update",
      mcpDef: def }`; otherwise fall through to the existing conflict
      path, unchanged.
- [x] 3.2 `applyMigratePlan`: extend the `item.action !== "create"` guard
      to also accept `"reclassify"` (same `upsertServerYaml` call as
      `"create"` already uses).
- [x] 3.3 Unit tests: a stale `staticEnv` entry whose text matches what
      the fresh read now classifies as `envAliases` is reported as
      `"reclassify"` and, on a real (non-dry-run) apply, updates
      `servers.yaml` to the new classification. A `--dry-run` run reports
      it without writing. A genuine conflict (real value differs) still
      reports `"conflict"` and is not applied — regression-checks D4.

## 4. Real-machine verification (not a substitute for the tests above)

- [x] 4.1 After 1–3 ship, run `trellis migrate --from claude-code --only
      mcp` for real on this machine and confirm notion's canonical entry
      updates from `static_env: { OPENAPI_MCP_HEADERS: "${...}" }` to
      `env_aliases: { OPENAPI_MCP_HEADERS: NOTION_OPENAPI_MCP_HEADERS }`,
      reported as a reclassification, and every other already-migrated
      server (harness-solo, tanka-sensors, mcp-router, figma, sentry,
      gitlab, chrome-devtools, tanka) is untouched (still
      `already-migrated`).
- [x] 4.2 Re-run `trellis mcp sync` and confirm notion's entry in every
      managed agent's native config now carries the resolved reference
      correctly (this was already fixed by
      `trellis-migrate-env-var-alias`'s write-path/pi-bridge work — this
      step only confirms the previously-stuck canonical data now flows
      through it).

## 5. Docs

- [x] 5.1 `docs/roadmap.md`: new entry, noting this closes the "a
      classification fix doesn't repair already-migrated data" gap found
      immediately after `trellis-migrate-env-var-alias` shipped.
