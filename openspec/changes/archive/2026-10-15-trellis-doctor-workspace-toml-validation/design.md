# Design

## Context

Current state:

- `trellis doctor` builds a workspace section via `collectWorkspaceDoctorSection(canonical)` (src/lib/workspaceDoctor.ts). For each managed agent it calls `unmarkedEntries(agentId, configPath, manifest.mcp?.[agentId] ?? {})` to list project-level MCP entries Trellis did not render.
- For Codex, `unmarkedEntries` reads the file as a string and regex-greps `^\[mcp_servers\.([^\]]+)\]\s*$` for headers. It never parses TOML, so a syntactically invalid file looks identical to a valid one — every entry in it is then (mis)reported as an unmigrated hint.
- The "don't bring in a general TOML parser" rule (lib/tomlSection.ts header comment) is about **round-tripping** for writes: tests with `@iarna/toml` and `smol-toml` showed those parsers drop comments and reformat arrays on parse→stringify. That rationale does not apply to a *read-only* validity check.
- The real incident motivating this change: `www/morphix/.codex/config.toml` had `enabled = false` and `enabled = true` in the same `[mcp_servers.morphix_dev]` table for ~19 hours; every Codex session on that project failed at startup. Nothing in Trellis flagged it.

## Goals / Non-Goals

**Goals:**

- Surface a hard "Codex will refuse to start" signal in `trellis doctor`, at the exact file+line the user needs to edit, before the next Codex session fails.
- Do so without any risk of Trellis writing to a file it does not own (the finding is diagnostic only).
- Do not regress the existing unmigrated-entry hint when the file is fine.

**Non-Goals:**

- JSON project config files (`.mcp.json`, `.pi/mcp.json`, `.kiro/settings/mcp.json`, `.kimi-code/mcp.json`, zcode's `zcode.json` / `.zcode/config.json`). Their existing `try { JSON.parse } catch → return []` already treats unparseable as unknown, and JSON syntax errors are uniformly understandable to the user without parser line/column help. Symmetric handling can be considered later as its own change.
- Auto-repair, auto-rewrite, or suggest-rewrite of the broken file.
- Validating anything beyond TOML syntax (e.g. "this URL is invalid", "this auth shape is wrong"). Syntax only.

## Decisions

### D1: Parse with `smol-toml`, parse-only, never round-trip

Add `smol-toml` as a dependency and use it to parse the file once inside `unmarkedEntries`' Codex branch. On success, discard the parsed AST and continue with the existing regex for header extraction (which preserves today's exact section-header semantics). On failure, capture `err.line` / `err.column` / `err.message` and report them.

**Why a parser at all:** TOML's "same key twice in one table" rule cannot be detected with regex without re-implementing the grammar (multiline arrays, nested tables, quoted keys containing dots). The failure mode that motivated this change is exactly one regex cannot see.

**Why discard the AST on success:** switching header extraction to the parsed AST would change behavior in edge cases (dotted keys like `[mcp_servers."foo.bar"]`, single-quoted keys, out-of-order tables). The regex was already validated against real fixtures; a new extraction path is new risk. Keep what works.

**Alternative considered:** hand-rolled "duplicate key in same table" detector on top of `lib/tomlSection.ts`'s table-header finder + bare-key regex. Rejected — would still miss other TOML errors Codex itself rejects (bad string escapes, unterminated arrays, invalid dates), and re-implements a spec-compliance problem we explicitly chose not to own when we picked `smol-toml` for parse-only use.

**Alternative considered:** shell out to `python3 -m tomllib`. Rejected — introduces a runtime dependency on system Python on every supported platform, and doctor is packaged as a Node CLI.

### D2: New finding kind `workspace-toml-invalid`, distinct from `parse-diagnostic`

`parse-diagnostic` (existing) is about **agent-global probe** results whose static config is suspect — a different layer. Reusing it for "a project file Trellis has no ownership over, but that breaks Codex" muddies the finding's meaning and its remediation guidance.

Add `workspace-toml-invalid` to `FindingKind`. The finding's `message` includes: file path, parser line/column, reason, and an explicit remediation line: "not rendered by Trellis — fix by hand and re-run `trellis doctor`". Add it to `EXIT_NONZERO_KINDS` per the spec (the file being broken is itself fatal for the agent — exactly what doctor exists to catch before the session does).

### D3: Suppress the unmigrated hint when the file is unparseable

Inside `unmarkedEntries`'s Codex branch: on parse failure, do **not** return the regex-extracted list as `string[]`. Instead return a discriminated result — `{ kind: "invalid-toml", line, column, reason }` — and let `collectWorkspaceDoctorSection` either omit the file from the `unmigrated` list or mark it explicitly as uninspectable. The spec leaves the choice open; the implementation will omit it, because the syntax finding already names the file and a duplicate hint would add noise.

This is the "don't mislead the user" half of the spec. Without it, a broken file produces both a `workspace-toml-invalid` finding *and* a "these N entries are unmigrated, run `migrate --workspace`" hint — the second is wrong advice when migrate itself would fail on the same syntax error.

### D4: Surface through the existing workspace section, not a new top-level section

`runDoctor` already builds `workspace = collectWorkspaceDoctorSection(canonical)` when a workspace is in scope, and prints it as a dedicated section. Add `workspaceTomlFindings: Finding[]` to `WorkspaceDoctorSection` (usually empty), and render them alongside the section's other rows. `--json` consumers already receive the workspace section verbatim, so adding a field there keeps the JSON shape stable-adjacent (append-only).

### D5: Run even when `canonical` is absent

`runDoctor` currently gates the workspace section on `canonical?.workspace`. Change the gate to: a workspace root is discoverable (via `findWorkspaceRoot`) **regardless** of whether `~/.trellis/` loaded. When canonical is absent, build a minimal `CanonicalSource` with an empty workspace layer and only the `root` set, so `collectWorkspaceDoctorSection` still runs its file inspection. (This aligns with the spec's third scenario: a user managing only project skills in `.agents/skills/` — no global Trellis install — still gets the warning.)

## Risks / Trade-offs

- **New dependency (`smol-toml`).** Small, zero-native, well-typed. Already evaluated as round-trip-unsafe for writes in `lib/tomlSection.ts`'s history, which this change explicitly respects by using it parse-only. Bundle size impact is trivial for a CLI.
- **Double parse (AST + regex) per doctor run on Codex workspaces.** Acceptable — the file is a few KB, doctor is interactive.
- **False-positive risk:** a file that parses under `smol-toml` but Codex rejects (or vice versa). Mitigation: `smol-toml` is TOML 1.0 compliant; Codex uses `toml` (Rust) which is also 1.0. Any divergence is a bug in one parser, not a class of false positives we can design around.
- **Behavior change:** a `trellis doctor` run that previously exited 0 on a workspace with a broken hand-edited Codex config now exits non-zero. This is the point of the change, and matches the spec's "Non-zero exit on any finding" contract.
- **Edge case: file unreadable (EACCES, is-a-directory).** Treated the same as parse failure — one finding kind, reason carried verbatim. No separate handling needed.
