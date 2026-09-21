# Design

## Context

See proposal.md - Why. Relevant existing plumbing this builds on:

- `src/lib/mcpRuntime.ts` (`BuiltinRegistry`) already dispatches tool calls to whichever `TrellisProvider` owns the tool name, inside a per-agent `trellis mcp-gateway --agent <id>` stdio process (`src/commands/mcpGateway.ts`). Adding a provider here is the established extension point (`SkillProvider`, `RuntimeMemoryProvider`, `TaskProvider`, etc. are all siblings registered the same way).
- `src/lib/taskStore.ts` / `src/lib/taskProvider.ts` already give us a durable, file-backed (`~/.trellis/tasks/tasks.json`), `confirm:true`-gated mutation pattern with lease/claim semantics — the exact shape needed for both the "explicit confirmation" and "durable audit trail" requirements.
- Real-machine verification (`--help` on each CLI) confirmed non-interactive/headless invocation for Claude Code (`-p/--print`, `--output-format json`), Codex (`codex exec`), Kimi Code (`-p, --prompt`, `--output-format text|stream-json`), and pi (`--print, -p`, `--mode json|rpc`). `kiro-cli` is not present on the verification machine, so Kiro support is unknown and out of scope for this change.

## Goals / Non-Goals

**Goals:**
- Let a managed Agent delegate a one-shot prompt to another managed Agent's own headless mode, surfaced as an ordinary MCP tool call
- Keep routing decisions in the calling Agent's own model — no new decision-making orchestrator process or Agent
- Make "who can be delegated to and what they're good at" declarative and discoverable, not hardcoded
- Prevent runaway delegation cycles and keep an audit trail of what happened

**Non-Goals:**
- Cross-machine or cross-network delegation (no mirasim, no A2A protocol adoption)
- A resident daemon/always-on process beyond the existing per-session gateway
- Streaming/interactive delegated sessions (v1 is single prompt in, single result out)
- Any visualization/GUI surface (separate future change)
- Bringing Kiro into scope (its headless capability is unverified)

## Decisions

**1. Tool schema and output normalization.** Each capable target gets one tool, e.g. `agent_bridge_run_codex` (name derived from the target's Agent id, normalized to satisfy `^[a-zA-Z0-9_-]+$` — the same constraint `mcp-gateway-hosting` already imposes on every exposed tool name). Input: `{ prompt: string, timeoutMs?: number, cwd?: string, confirm: true }`. Output envelope: `{ status: "completed" | "failed" | "timeout", output: string, durationMs: number, targetAgent: string }`. The provider is responsible for translating each CLI's native invocation and output shape (parsing `--output-format json` where the target supports it, otherwise capturing raw stdout as `output`) into this one envelope, so the caller never needs to know which CLI is underneath.
   - *Alternative considered*: expose each CLI's native flags/output format directly. Rejected — that pushes CLI-specific knowledge onto every caller and breaks the "discoverable, not hardcoded" goal.

**2. Capability list location and format.** New file `~/.trellis/mcp/agent-bridge.yaml`, sibling to `servers.yaml`. Each entry: managed Agent id (must already exist in `managed.yaml`), an `invoke` command template (binary + non-interactive flags, e.g. the verified `-p`/`exec` forms), a default `timeoutMs`, and a free-text `tags` list (e.g. `["code-review", "large-context"]`) used only to enrich the exposed tool's MCP description — not validated against a taxonomy. Hand-editable, same trust model as `servers.yaml`.
   - *Alternative considered*: fold this into `agents.md` or `managed.yaml`. Rejected — those describe *what Trellis manages*, not *what one Agent may invoke another for*; keeping it separate avoids overloading either file's existing meaning.

**3. Delegation depth limit.** Default max depth = 2 (an invocation may itself delegate one further hop, but no more). The current depth is passed to the spawned child process via an environment variable (e.g. `TRELLIS_DELEGATION_DEPTH`), incremented by the provider before spawning. This avoids needing a live shared registry of "who's currently mid-call" — depth travels with the process chain itself. Configurable per-deployment via a top-level `maxDepth` field in `agent-bridge.yaml`.
   - *Alternative considered*: a central live registry tracking active call chains (needed for detecting true cycles, not just depth). Rejected for v1 — adds a stateful service for a problem a simple depth cap already bounds adequately; revisit if real usage shows depth-capping insufficient.

**4. Timeout and retry policy.** Each capability entry's `timeoutMs` bounds its own invocation (default 120000ms if unset). On timeout, the provider sends `SIGTERM` then `SIGKILL` after a grace period and returns `status: timeout`. No automatic retry — retrying an Agent that may have already made file edits or run commands risks double-applying side effects; the calling Agent's own model decides whether to retry based on the returned status.

**5. Explicit confirmation gate.** Reuses the exact `confirm: true` pattern `TaskProvider`'s mutating tools already require, rather than inventing a second consent mechanism, since spawning another Agent CLI is a real-side-effect action, not a read-only lookup.

**6. Audit trail storage.** Reuses `taskStore.ts`'s existing file-backed persistence (`~/.trellis/tasks/tasks.json` or a sibling file using the same module) to record each delegated call as a record with caller/target/timestamp/outcome. `trellis doctor` gains a summary section reading from the same store. No new storage engine.

**7. Depth propagation is implemented, not deferred.** `readDelegationDepth()` reads `TRELLIS_DELEGATION_DEPTH` from `process.env` (default 0), and `AgentBridgeProvider` refuses a call once that reaches the target's `maxDepth` (default `DEFAULT_MAX_DELEGATION_DEPTH = 2`) — before ever calling `runDelegatedCall`, so a refused call spawns nothing. `runDelegatedCall` sets the spawned child's `TRELLIS_DELEGATION_DEPTH` to `depth + 1`; because `spawn` inherits the rest of `process.env`, this value survives into whatever the child's own tooling (its own `trellis mcp-gateway`, if it spawns one) launches next, without a live shared registry.

**8. Persona: native placeholder first, prompt-prefix fallback.** A target's argv template may include a `{persona}` placeholder alongside `{prompt}`; when present, the effective persona (call override, else target default) substitutes there — e.g. pi's `--system-prompt {persona}`. When a template has no such placeholder, the effective persona is prepended to the prompt as `[Persona: <persona>]\n\n<prompt>` instead. This means every target gets persona support with zero required CLI-specific mapping code — the config author decides whether their target has a native slot to use.
   - *Alternative considered*: hardcode a native system-prompt flag per known CLI (`--append-system-prompt` for Claude Code, `--system-prompt` for pi, etc.). Rejected — it reintroduces exactly the per-CLI special-casing the tool schema and output-normalization design already avoid, for a feature that degrades acceptably via prompt-prefixing anyway.

**9. Session continuity via a distinct resume template, not implicit flag injection.** A completed call's `json`/`stream-json` output is scanned (in addition to the existing text-extraction scan) for a top-level `session_id`/`sessionId` string, returned as the result's `sessionId`. A target's capability declaration may separately provide `resumeArgs` — used instead of `args` whenever a caller supplies a `sessionId`. Supplying a `sessionId` against a target with no `resumeArgs` fails immediately with a clear reason rather than silently falling back to a fresh call (a silent fallback would look like a continued conversation while actually starting over — worse than a loud failure). This does not reopen the "no streaming/interactive sessions" Non-Goal: each call, resumed or not, is still one prompt in, one result out — resumption only changes which conversation state the target CLI loads before answering.

**10. Real-sandbox findings, folded back into the design rather than left as open questions:**
   - Codex's `exec` refuses to run in a directory it doesn't trust unless `--skip-git-repo-check` is passed — confirmed live, not documented in `--help`'s visible portion. Any `agent-bridge.yaml` template for Codex needs this flag.
   - Kimi Code's OAuth credential alone is insufficient for a real call: model/provider registration lives in `config.toml`. Resolved by bridging that file too, read-only, alongside the credential — same disposable-container lifetime as every other bridged file here. Real call verified end to end.
   - Claude Code's OAuth token lives in the macOS Keychain, not a file, on a Mac (it does use a plain `~/.claude/.credentials.json` file on Linux/CI, which is what a CI runner would actually have) — so the file-bridging verification mechanism this design reuses for Codex/pi/Kimi Code cannot reach it on a macOS development machine specifically. **Deliberately not resolved by Keychain extraction**: the only discoverable entry under the expected service name held this installation's Sentry/Figma *MCP* OAuth tokens, not the account-level token — the wrong secret entirely, extracted, inspected structurally without ever printing a value, and immediately shredded once misidentified. Finding the right entry would mean continuing to search a user's Keychain for credentials unrelated to this feature, which is out of scope for an automated change to perform on the user's behalf. The correct unblock is operator-initiated: `claude setup-token` (or `CLAUDE_CODE_OAUTH_TOKEN` if already set) produces a portable value the operator hands to the bridge explicitly, rather than Trellis extracting anything from OS-level secret storage itself. Production delegation to Claude Code is unaffected either way — it spawns whatever `claude` binary and its ambient auth resolve to; this is purely a verification-sandbox gap.

## Risks / Trade-offs

- [Risk] A target Agent's headless output format changes between CLI versions, silently breaking the normalization layer → Mitigation: capability entries are versioned by explicit CLI invocation string in `agent-bridge.yaml`, not auto-detected; a broken parse falls back to raw-text `output` rather than throwing, and `trellis doctor` surfaces a parse-failure count so it's noticed quickly.
- [Risk] Two Agents both start deep delegation chains concurrently, causing subprocess fan-out and resource pressure → Mitigation: depth cap (Decision 3) bounds worst-case fan-out per chain; per-call timeout (Decision 4) bounds how long any single chain can hold resources. A global concurrency limit is deferred as an open question below.
- [Risk] Kiro users see no delegation capability and may expect one → Mitigation: proposal and this design explicitly scope Kiro out; `trellis doctor` should note Kiro as "delegation: unverified" rather than silently omitting it.
- [Trade-off] Synchronous-only calls mean a caller's gateway session blocks for the duration of the delegated call (up to `timeoutMs`) → Accepted for v1 per the proposal's scope (async execution via `taskStore` polling is explicitly future work, not required now).

## Migration Plan

Purely additive — no existing canonical file format changes, no existing tool behavior changes. Rollout is: ship the provider disabled unless `agent-bridge.yaml` exists (absence = zero behavior change for existing installs). No rollback beyond deleting the file / provider registration, mirroring how other optional providers already behave.

## Open Questions

- Should there eventually be a global (cross-chain) concurrency cap on simultaneous delegated calls, or is per-chain depth + per-call timeout sufficient in practice? Deferred until real usage data exists; doesn't change this change's specs or tasks.
