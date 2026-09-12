## 1. `src/sdk.ts` — the curated barrel (design.md D1)

- [x] 1.1 Re-exports `loadCanonicalSource`.
- [x] 1.2 Re-exports `CanonicalSource`, `SkillRef`, `AgentProfile`,
      `MemoryEntry`, `McpConfig`, `McpServerDef`, `HubConfig`,
      `SecretsPolicy`, `AgentId`, `Scope`, `Transport`, `ALL_AGENTS`,
      `resolveScope`.
- [x] 1.3 `test/unit/sdk.test.ts`'s third test: checks the barrel's own
      import/export-from lines (not the whole file text — an early
      version of this test naively substring-matched the whole file and
      false-failed on the file's own doc comment, which mentions
      "adapters/" as prose explaining what's excluded; fixed to check
      only actual import lines) for any `adapters/`/`commands/` path, and
      asserts none of `planSymlinks`/`resolveMcpPlan`/`applyJsonMcp`/
      `upsertSection`/every adapter class appear among the barrel's
      runtime exports.

## 2. `package.json` — `"exports"` (design.md D2/D3)

- [x] 2.1 Added `"exports"` (`"."` → `dist/sdk.js` with a `"types"`
      condition to `dist/sdk.d.ts`), plus `"main"`/`"types"` fallbacks,
      alongside the existing `"bin"` entry.
- [x] 2.2 Confirmed via `npm pack --dry-run`: `dist/sdk.js`/`dist/sdk.d.ts`
      are included with no `"files"` change needed.

## 3. Verification

- [x] 3.1 `test/unit/sdk.test.ts`: importing `../../src/sdk.js` and
      calling `loadCanonicalSource` against a scratch fixture returns the
      expected shape; `ALL_AGENTS`/`resolveScope` behave correctly.
- [x] 3.2 `scripts/verify-sdk-export.sh`: builds the real package, packs
      a real tarball, installs it into a throwaway scratch project, and
      imports `agent-trellis` via the bare specifier — genuine
      `node_modules` "exports"-map resolution, not source-relative
      `tsx` resolution. Ran successfully: `loadCanonicalSource` resolves
      as a function, `ALL_AGENTS` resolves to the correct array. Kept as
      a reusable script (not a one-off manual check) so a future change
      to the `"exports"` map can be re-verified the same way.
