# Proposal

## Why

Problem: A project-scoped `.codex/config.toml` can contain a hard TOML syntax error (e.g. a duplicated `enabled` key inside one `[mcp_servers.*]` table) that makes Codex refuse to start with `TOML parse error at line X … duplicate key`. When this happens on a file Trellis did **not** render — typically a hand-edited workspace file or a `codex mcp add `generated file — there is no warning anywhere. The user only finds out the next time Codex refuses to open the project. This just cost a real debugging session on `www/morphix`, where the file had been silently broken since 2026-10-14 21:42 with every Codex session failing on load.

Trellis's promise is that once a project is managed, it surfaces agent-state problems before they bite. Drift, collision, unmigrated entries, invalid `${VAR}` references — all reported. But the doctor's workspace section currently walks the same project-level `.codex/config.toml` using **regex** (looking only for `[mcp_servers.<name>]` headers), so a file that is *syntactically invalid TOML* is indistinguishable from a valid file to doctor. An unparseable project file is exactly the signal a managed user expects doctor to catch, because from the user's point of view "the file Trellis watches" is broken.

## What Changes

- Extend doctor's workspace attribution so that when a project-scoped `.codex/config.toml` exists, it is additionally validated for **TOML parseability** before any section extraction. Failure produces a new finding with the parser's line/column and reason, phrased as "not rendered by Trellis, fix by hand".
- The check is **read-only** (never writes, never re-renders) and runs on the workspace doctor pass even when `~/.trellis/` global context is absent — a user managing only skills in `.agents/skills/` still gets the warning.
- When the TOML parse fails, treat section extraction for that file as "skipped, unknown entries" rather than silently returning an empty list: the existing *unmigrated* hint is upgraded to "could not inspect" so the user is not told "all entries are unmigrated" when in fact we don't know.
- JSON-based project MCP files (`.mcp.json`, `.pi/mcp.json`, `.kiro/settings/mcp.json`, `.kimi-code/mcp.json`, zcode project config) are **out of scope** for this change — their existing JSON `try { parse } catch → return []` already tolerates garbage by design; adding a syntax-finding there is a separate, symmetric change if wanted later.

## Capabilities

### New Capabilities
<!-- none — this is a strengthening of an existing capability, not a new one -->

### Modified Capabilities
- `capability-drift-detection`: add a requirement that doctor validates the workspace Codex project config's TOML syntax and reports a dedicated finding (distinct from `parse-diagnostic`, which is about agent-global probes) when the file cannot be parsed, regardless of whether Trellis rendered it.

## Impact

- Code: `src/lib/workspaceDoctor.ts` (add TOML validation step), `src/commands/doctor.ts` (surface the new finding kind, include it in non-zero-exit kinds), and the finding presentation layer (new label + remediation text).
- New dependency: a tolerant TOML parser restricted to *parse-only* usage (e.g. `smol-toml`). Used only to get line/column on failure — never to round-trip or rewrite the file (the existing `lib/tomlSection.ts` rationale still stands).
- Behavior: `trellis doctor` may now exit non-zero on a malformed project-level Codex config, even when Trellis owns nothing in that file. This is the intended behavior — the finding is itself the bug.
- Out of scope: any auto-repair or rewrite of the malformed file. The finding points at line/column and says "fix by hand"; Trellis does not touch a file it doesn't own.
