# Proposal

## Why

Trellis today is CLI-only: understanding cross-Agent state (which Skills/MCP servers/Memory reach which Agent, what `doctor` flags, what a pending delegated call to another Agent is doing) means reading terminal output or JSON by hand. A visualization surface lowers that barrier — and to be worth building at all, it needs to actually let an operator *act* on what it shows (run `onboard`, `sync`, add/remove an MCP server or Skill, roll back), not just display it, otherwise it's a second, weaker copy of `trellis doctor`.

## What Changes

- New standalone package `@trellis/gui`: a Tauri v2 + React desktop app, developed in this same repository as an npm workspace member (not a separate repo) so it can depend on `agent-trellis`'s internal, not-yet-public command modules without forcing a premature public API commitment.
- New local control-plane: a Node.js sidecar process (compiled to a single-file binary per platform, spawned by the Tauri/Rust shell, bound to loopback only) that imports the existing `collect*Plan`/`apply*Plan` functions directly — `sync`, `mcp add/remove/sync`, `skill add/remove/sync`, `rollback`, `secretsAudit`, `onboard` — and exposes them over a local HTTP+WebSocket API, plus a `~/.trellis/**` file watcher that pushes change events for live UI refresh.
- Every mutating sidecar endpoint reuses the CLI's existing safety mechanics as-is: the already-typed `dryRun` option, the already-shared `src/lib/backup.ts` auto-backup path, and `onboard`'s existing prompt-injection seams (now satisfied by GUI dialogs instead of terminal prompts) — no new safety logic is invented, only a new caller of the existing one.
- React frontend (v1, macOS packaging only): read views for Agent status (`doctor`), MCP servers/routes, Skills, Memory, and secrets-audit results (names/pass-fail only, never values); write actions for `onboard`, `sync`, `mcp add/remove/sync`, `skill add/remove/sync`, `rollback`, each gated by a confirmation dialog that shows the same dry-run plan the CLI would print before applying it.
- Explicitly out of scope for v1: a delegated-call timeline view (data source is `trellis-agent-bridge`'s still-unbuilt audit trail, task group 4 of that change — not this one), Windows/Linux packaging, and any expansion of `agent-trellis`'s public SDK barrel.

## Capabilities

### New Capabilities
- `gui-sidecar-api`: the local control-plane's behavioral contract — what it exposes, how it binds/authorizes access, and the safety guarantees (dry-run visibility, explicit confirmation, automatic backup, no bypass of existing write paths) every mutating endpoint must uphold regardless of which underlying Trellis operation it fronts.

### Modified Capabilities
None. `trellis-sdk`'s existing requirement ("the SDK barrel SHALL NOT re-export anything from `src/adapters/*` or `src/commands/*`") stays intact — `@trellis/gui`'s sidecar imports those modules directly as an in-repo workspace member, not through the public `agent-trellis` package export, so no existing public contract changes.

## Impact

- New directory/package: `packages/gui/` (or equivalent workspace path) containing the Tauri project (`src-tauri/`), the React app, and the sidecar server source; `package.json` gains an npm `workspaces` field it does not have today.
- No changes to `agent-trellis`'s existing CLI commands, adapters, or public SDK exports — the sidecar is a new caller of existing internal functions, not a modification of them.
- New build/CI surface: Rust toolchain, Tauri CLI, a Node-to-single-binary compile step (`@yao-pkg/pkg`/`bun build --compile`/equivalent) for the sidecar, and macOS code-signing/notarization for distributable builds.
- New runtime dependency for anyone building/running the GUI: Rust + Cargo (developers only — end users of the packaged app need nothing extra, per the sidecar/bundling design).
