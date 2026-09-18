# Design

## Goals / Non-Goals

**Goals:**

- Let a first-time user make a reasonable choice from the terminal without
  knowing Trellis internals.
- Put the recommended choice first and visibly mark it.
- Explain MCP mode in terms of process ownership, deployment, and failure
  scope, not just implementation names.
- Preserve a no-surprise re-run: omitted mode flags never reset an existing
  mode.

**Non-Goals:**

- Do not change the meaning of `--mcp-mode`, `--selection`, or `--manage`.
- Do not automatically start or configure an external Hub.
- Do not add a full-screen TUI or a separate onboarding state machine.

## Decisions

### D1 — Recommendations are contextual labels, not hidden writes

Interactive pickers show a `推荐` marker and a short reason. The selected
value remains the user's choice; only the initial ordering/default is guided.
CLI flags and selection files bypass interactive recommendations entirely.

### D2 — Gateway is the local Trellis recommendation

For the MCP route picker, the recommended option is:

> Gateway（推荐：本机统一托管） — Trellis 在本机会话中启动一个 MCP
> 入口，负责连接和管理后端服务器；不需要额外部署服务。

Direct and Hub remain available with explicit descriptions:

- Direct: each Agent connects to each MCP server itself; simplest when no
  central management is wanted.
- Hub: each Agent connects to one external HTTP MCP endpoint; choose it only
  when that Hub is already running and its URL is configured.

### D3 — Recommendations across the onboarding flow

- Source picker recommends the present Agent with the most real migratable
  content and labels the reason.
- Managed-agent picker marks installed/present agents as recommended and
  existing managed agents as already selected.
- Migration category and item pickers explain that the initial all-selected
  state is the recommended safe import; users can deselect items.
- Dry-run apply keeps the existing safe default of not applying automatically,
  but explains that reviewing first is recommended.

### D4 — Picker API supports descriptive options without changing semantics

The terminal picker accepts display labels and an optional initial index. It
still returns the original semantic index, so adapters and tests do not depend
on rendered copy.

## Verification

- Unit tests assert recommendation ordering/labels for all interactive picker
  categories and the three MCP mode descriptions.
- Existing picker interaction tests continue to return the same semantic
  indices.
- Full tests, typecheck, build, package verification, and strict OpenSpec
  validation pass.
