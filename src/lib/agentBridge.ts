/**
 * Cross-Agent delegation (trellis-agent-bridge): lets a managed Agent call
 * another managed Agent's own verified non-interactive/headless mode as a
 * one-shot subprocess call, so each Agent's strengths can be used without a
 * central orchestrator or any cross-machine protocol.
 *
 * Configuration lives at `~/.trellis/mcp/agent-bridge.yaml`, sibling to
 * `servers.yaml`, and is fully optional — its absence means zero behavior
 * change (design.md Migration Plan).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ALL_AGENTS, type AgentId } from "../core/types.js";

export type AgentBridgeOutputFormat = "text" | "json" | "stream-json";
export type StreamProtocol = "claude" | "zcode";

export interface AgentBridgeTargetConfig {
  /** Binary to spawn, e.g. "codex", "claude", "pi", "kimi". */
  command: string;
  /** Argv template for a fresh call. One element may be the literal
   * placeholder `"{prompt}"`, substituted with the caller's prompt (and
   * persona, if the target has no dedicated persona flag — see
   * `PERSONA_PLACEHOLDER`) at call time — covers a trailing positional
   * prompt (Codex, Claude Code, pi) and a flag-value prompt (Kimi Code's
   * `-p, --prompt <prompt>`) with the same shape. */
  args: string[];
  /** Argv template used instead of `args` when the caller supplies a
   * `sessionId` to resume — must reference `"{sessionId}"`. Omitting this
   * means the target does not support resuming a prior session; a call
   * that supplies `sessionId` against such a target fails with a clear
   * error rather than silently starting a fresh session. */
  resumeArgs?: string[];
  /** How to interpret stdout. Omit for plain text. */
  outputFormat?: AgentBridgeOutputFormat;
  /** Selects a verified event envelope for stream-json output. Omit for
   * Claude-compatible streams, which remains the existing default. */
  streamProtocol?: StreamProtocol;
  timeoutMs?: number;
  /** Free-text, informational only — surfaced in the exposed tool's
   * description so a caller can judge fit; never validated against a
   * taxonomy. */
  tags?: string[];
  /** Default persona/role text applied to every call to this target
   * unless a call overrides it. Substituted into `"{persona}"` when the
   * chosen argv template has that placeholder; otherwise prepended to the
   * prompt as a framing line, so every target gets persona support even
   * without a native system-prompt flag. */
  persona?: string;
}

export interface AgentBridgeConfig {
  targets: Partial<Record<AgentId, AgentBridgeTargetConfig>>;
  /** Maximum delegation chain depth before a call is refused, to bound
   * A→B→A (or longer) cycles. Defaults to `DEFAULT_MAX_DELEGATION_DEPTH`. */
  maxDepth?: number;
}

export const DEFAULT_DELEGATION_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_DELEGATION_DEPTH = 2;
/** Carries the current delegation depth down the real process tree — the
 * gateway that receives a delegated call inherits this from its spawning
 * shell, so depth travels with the chain itself without a live shared
 * registry (design.md Decision 3). */
export const DELEGATION_DEPTH_ENV = "TRELLIS_DELEGATION_DEPTH";

const PROMPT_PLACEHOLDER = "{prompt}";
const PERSONA_PLACEHOLDER = "{persona}";
const SESSION_PLACEHOLDER = "{sessionId}";
const FORCE_KILL_GRACE_MS = 5_000;

export function agentBridgePath(homeDir: string): string {
  return join(homeDir, ".trellis", "mcp", "agent-bridge.yaml");
}

/** Reads the current chain depth from an environment map (defaults to
 * `process.env`, injectable for tests). Anything absent or malformed
 * reads as depth 0 — the safe "not part of a chain yet" default. */
export function readDelegationDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELEGATION_DEPTH_ENV];
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

interface AgentBridgeTargetYaml {
  command?: string;
  args?: string[];
  resumeArgs?: string[];
  outputFormat?: string;
  streamProtocol?: string;
  timeoutMs?: number;
  tags?: string[];
  persona?: string;
}

interface AgentBridgeYaml {
  targets?: Partial<Record<string, AgentBridgeTargetYaml>>;
  maxDepth?: number;
}

const OUTPUT_FORMATS: readonly AgentBridgeOutputFormat[] = ["text", "json", "stream-json"];
const STREAM_PROTOCOLS: readonly StreamProtocol[] = ["claude", "zcode"];

export function loadAgentBridgeConfig(homeDir: string): AgentBridgeConfig {
  const path = agentBridgePath(homeDir);
  if (!existsSync(path)) return { targets: {} };
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as AgentBridgeYaml;
  if (parsed.maxDepth !== undefined && (!Number.isInteger(parsed.maxDepth) || parsed.maxDepth < 1)) {
    throw new Error(`agent-bridge.yaml: "maxDepth" must be a positive integer`);
  }
  const targets: AgentBridgeConfig["targets"] = {};
  for (const [agentId, raw] of Object.entries(parsed.targets ?? {})) {
    if (!raw) continue;
    if (!(ALL_AGENTS as readonly string[]).includes(agentId)) {
      throw new Error(`agent-bridge.yaml: "${agentId}" is not a supported Agent id`);
    }
    if (!raw.command || !Array.isArray(raw.args) || raw.args.length === 0) {
      throw new Error(`agent-bridge.yaml: target "${agentId}" must declare "command" and a non-empty "args"`);
    }
    if (raw.resumeArgs !== undefined && (!Array.isArray(raw.resumeArgs) || raw.resumeArgs.length === 0)) {
      throw new Error(`agent-bridge.yaml: target "${agentId}" has an invalid "resumeArgs"`);
    }
    if (raw.outputFormat !== undefined && !OUTPUT_FORMATS.includes(raw.outputFormat as AgentBridgeOutputFormat)) {
      throw new Error(`agent-bridge.yaml: target "${agentId}" has unknown outputFormat "${raw.outputFormat}"`);
    }
    if (raw.streamProtocol !== undefined && !STREAM_PROTOCOLS.includes(raw.streamProtocol as StreamProtocol)) {
      throw new Error(`agent-bridge.yaml: target "${agentId}" has unknown streamProtocol "${raw.streamProtocol}"`);
    }
    targets[agentId as AgentId] = {
      command: raw.command,
      args: raw.args,
      ...(raw.resumeArgs ? { resumeArgs: raw.resumeArgs } : {}),
      ...(raw.outputFormat ? { outputFormat: raw.outputFormat as AgentBridgeOutputFormat } : {}),
      ...(raw.streamProtocol ? { streamProtocol: raw.streamProtocol as StreamProtocol } : {}),
      ...(raw.timeoutMs ? { timeoutMs: raw.timeoutMs } : {}),
      ...(raw.tags ? { tags: raw.tags } : {}),
      ...(raw.persona ? { persona: raw.persona } : {}),
    };
  }
  return { targets, ...(parsed.maxDepth !== undefined ? { maxDepth: parsed.maxDepth } : {}) };
}

/** Shared SIGTERM→SIGKILL escalation used by both a timeout firing and a
 * caller-initiated cancellation (streaming only) — kept as one function so
 * the two call sites can never drift. */
function killWithEscalation(child: ChildProcess): void {
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_GRACE_MS);
  forceKill.unref?.();
}

function buildArgs(template: readonly string[], vars: { prompt: string; persona?: string; sessionId?: string }): string[] {
  return template.map((arg) => {
    if (arg === PROMPT_PLACEHOLDER) return vars.prompt;
    if (arg === PERSONA_PLACEHOLDER) return vars.persona ?? "";
    if (arg === SESSION_PLACEHOLDER) return vars.sessionId ?? "";
    return arg;
  });
}

/** Best-effort output extraction from a `json`/`stream-json` target's
 * stdout: the response text plus, when present, a session id the caller
 * can pass back as `sessionId` in a later call to resume this exact
 * conversation. A parse failure or unrecognized shape degrades to the raw
 * trimmed output with no session id, rather than throwing — a CLI's
 * output-format change should surface as a stranger answer, not a crash
 * (design.md Risks). */
function extractOutput(raw: string, outputFormat: AgentBridgeOutputFormat | undefined): { output: string; sessionId?: string } {
  const trimmed = raw.trim();
  if (outputFormat !== "json" && outputFormat !== "stream-json") return { output: trimmed };
  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  const lastLine = lines[lines.length - 1] ?? trimmed;
  try {
    const parsed = JSON.parse(lastLine) as unknown;
    if (typeof parsed === "string") return { output: parsed };
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      let output: string | undefined;
      for (const key of ["result", "output", "text", "response", "message"]) {
        if (typeof record[key] === "string") { output = record[key] as string; break; }
      }
      let sessionId: string | undefined;
      for (const key of ["session_id", "sessionId"]) {
        if (typeof record[key] === "string") { sessionId = record[key] as string; break; }
      }
      return { output: output ?? JSON.stringify(parsed), ...(sessionId ? { sessionId } : {}) };
    }
  } catch {
    // fall through to raw text
  }
  return { output: trimmed };
}

export interface DelegatedCallResult {
  status: "completed" | "failed" | "timeout";
  output: string;
  durationMs: number;
  targetAgent: AgentId;
  /** Present when the target reported one (best-effort extraction from
   * `json`/`stream-json` output). Pass back as `sessionId` in a later
   * call to continue this exact conversation, if the target has
   * `resumeArgs` configured. */
  sessionId?: string;
}

export interface RunDelegatedCallOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Overrides the target's default `persona` for this call only. */
  persona?: string;
  /** Resume a prior conversation instead of starting a fresh one.
   * Requires the target to have `resumeArgs` configured. */
  sessionId?: string;
  /** The chain depth *before* this call (0 for a call that isn't itself
   * part of a delegation chain). The spawned child sees `depth + 1`. */
  depth?: number;
}

/** Spawns the target's verified non-interactive invocation, enforces
 * `timeoutMs` with SIGTERM-then-SIGKILL escalation, and normalizes the
 * result into one envelope regardless of which CLI is underneath. Does
 * NOT itself enforce a depth ceiling — refusing at the limit is the
 * caller's job (AgentBridgeProvider), since only it knows the configured
 * `maxDepth`; this function only propagates whatever depth it's given. */
export async function runDelegatedCall(
  targetAgent: AgentId,
  target: AgentBridgeTargetConfig,
  prompt: string,
  opts?: RunDelegatedCallOptions,
): Promise<DelegatedCallResult> {
  const timeoutMs = opts?.timeoutMs ?? target.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
  const persona = opts?.persona ?? target.persona;

  let template: readonly string[] = target.args;
  if (opts?.sessionId) {
    if (!target.resumeArgs) {
      return { status: "failed", output: `agent "${targetAgent}" has no resumeArgs configured — cannot resume sessionId "${opts.sessionId}"`, durationMs: 0, targetAgent };
    }
    template = target.resumeArgs;
  }

  const hasPersonaSlot = template.includes(PERSONA_PLACEHOLDER);
  const effectivePrompt = persona && !hasPersonaSlot ? `[Persona: ${persona}]\n\n${prompt}` : prompt;
  const args = buildArgs(template, { prompt: effectivePrompt, persona, sessionId: opts?.sessionId });

  const childEnv = { ...process.env, [DELEGATION_DEPTH_ENV]: String((opts?.depth ?? 0) + 1) };
  const start = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(target.command, args, { cwd: opts?.cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });

    const killTimer = setTimeout(() => killWithEscalation(child), timeoutMs);

    const finish = (value: DelegatedCallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(value);
    };

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
    child.on("error", (err) => finish({ status: "failed", output: err.message, durationMs: Date.now() - start, targetAgent }));
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - start;
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        finish({ status: "timeout", output: (stdout || stderr).trim(), durationMs, targetAgent });
        return;
      }
      if (code !== 0) {
        finish({ status: "failed", output: (stderr || stdout).trim(), durationMs, targetAgent });
        return;
      }
      finish({ status: "completed", ...extractOutput(stdout, target.outputFormat), durationMs, targetAgent });
    });
  });
}

/** Best-effort structured interpretation of one line of a `stream-json`
 * target's stdout, covering the four shapes documented by the community
 * for Claude Code's non-interactive stream-json output (there is no
 * official Anthropic schema — see upstream issue #24612): a `system/init`
 * line, an `assistant` message carrying text or a `tool_use` block, a
 * `user` message carrying a `tool_result` block, and the final `result`
 * line. Anything that doesn't parse as JSON, or parses but doesn't match
 * one of these shapes, returns `undefined` — the caller falls back to
 * displaying the raw line rather than guessing. */
export type ParsedStreamEvent =
  | { kind: "init"; sessionId?: string }
  | { kind: "text-delta"; text: string }
  | { kind: "tool-call"; toolCallId: string; name: string; input: unknown }
  | { kind: "tool-result"; toolCallId: string; output: unknown }
  | { kind: "final"; output: string; sessionId?: string; protocol?: "zcode" };

export function tryParseClaudeStreamJsonLine(line: string): ParsedStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const record = json as Record<string, unknown>;

  if (record.type === "system" && record.subtype === "init") {
    const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;
    return { kind: "init", ...(sessionId ? { sessionId } : {}) };
  }

  if (record.type === "result") {
    const output = typeof record.result === "string" ? record.result : "";
    const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;
    return { kind: "final", output, ...(sessionId ? { sessionId } : {}) };
  }

  if (record.type === "assistant" || record.type === "user") {
    const message = record.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : undefined;
    if (!content) return undefined;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return { kind: "text-delta", text: b.text };
      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        return { kind: "tool-call", toolCallId: b.id, name: b.name, input: b.input };
      }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        return { kind: "tool-result", toolCallId: b.tool_use_id, output: b.content };
      }
    }
    return undefined;
  }

  return undefined;
}

/** ZCode's documented headless result envelope is deliberately distinct from
 * Claude-compatible streams: `{ type: "result", response, sessionId }`.
 * Intermediate ZCode protocol events evolve with the runtime, so unknown
 * records remain raw chunks rather than being guessed into false tool/text
 * events. */
export function tryParseZcodeStreamJsonLine(line: string): ParsedStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const record = json as Record<string, unknown>;
  if (record.type !== "result" || typeof record.response !== "string") return undefined;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  return { kind: "final", output: record.response, protocol: "zcode", ...(sessionId ? { sessionId } : {}) };
}

export interface StreamChunk {
  /** Raw text as received from the child, one line (no trailing newline). */
  raw: string;
  /** Present only when `outputFormat: "stream-json"` and the line matched
   * a recognized Claude Code shape — see `tryParseClaudeStreamJsonLine`. */
  parsed?: ParsedStreamEvent;
}

export interface DelegatedStreamResult {
  status: "completed" | "failed" | "timeout" | "cancelled";
  output: string;
  durationMs: number;
  /** Chat targets are identified by an arbitrary string id (`chat-agents.yaml`
   * has no `AgentId` constraint — see `chatAgents.ts`), unlike
   * `DelegatedCallResult.targetAgent` which is always a real managed Agent. */
  targetAgent: string;
  sessionId?: string;
}

export interface RunDelegatedCallStreamingOptions extends Omit<RunDelegatedCallOptions, "depth"> {
  /** Called once per line of stdout, as it arrives — not batched until the
   * process exits, unlike `runDelegatedCall`. */
  onChunk: (chunk: StreamChunk) => void;
  /** The chain depth before this call, same meaning as
   * `RunDelegatedCallOptions.depth`. */
  depth?: number;
  /** Aborting triggers the same SIGTERM→SIGKILL escalation as a timeout;
   * the returned result has `status: "cancelled"` instead of `"timeout"`. */
  signal?: AbortSignal;
}

/** Streaming counterpart to `runDelegatedCall`: same argv-building,
 * timeout escalation, and persona/session handling, but emits `onChunk`
 * for every line of stdout as it arrives instead of buffering until the
 * process exits, and supports cooperative cancellation via `signal`. Takes
 * a plain `string` target id (not `AgentId`) so it can serve both a future
 * streaming MCP delegation tool and today's GUI chat feature, whose
 * targets come from `chat-agents.yaml` and are not required to be one of
 * the fully-managed Agents in `ALL_AGENTS`. */
export async function runDelegatedCallStreaming(
  targetAgent: string,
  target: AgentBridgeTargetConfig,
  prompt: string,
  opts: RunDelegatedCallStreamingOptions,
): Promise<DelegatedStreamResult> {
  const timeoutMs = opts.timeoutMs ?? target.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS;
  const persona = opts.persona ?? target.persona;

  let template: readonly string[] = target.args;
  if (opts.sessionId) {
    if (!target.resumeArgs) {
      return {
        status: "failed",
        output: `agent "${targetAgent}" has no resumeArgs configured — cannot resume sessionId "${opts.sessionId}"`,
        durationMs: 0,
        targetAgent,
      };
    }
    template = target.resumeArgs;
  }

  const hasPersonaSlot = template.includes(PERSONA_PLACEHOLDER);
  const effectivePrompt = persona && !hasPersonaSlot ? `[Persona: ${persona}]\n\n${prompt}` : prompt;
  const args = buildArgs(template, { prompt: effectivePrompt, persona, sessionId: opts.sessionId });

  const childEnv = { ...process.env, [DELEGATION_DEPTH_ENV]: String((opts.depth ?? 0) + 1) };
  const start = Date.now();
  const isStreamJson = target.outputFormat === "stream-json";

  return new Promise((resolve) => {
    let settled = false;
    let lineBuffer = "";
    let stdoutAll = "";
    let stderr = "";
    let structuredOutput = "";
    let sessionId: string | undefined;
    let cancelled = false;

    const child = spawn(target.command, args, { cwd: opts.cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });

    const killTimer = setTimeout(() => killWithEscalation(child), timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      killWithEscalation(child);
    };
    opts.signal?.addEventListener("abort", onAbort);

    const finish = (value: DelegatedStreamResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const emitLine = (line: string): void => {
      if (!line) return;
      let parsed: ParsedStreamEvent | undefined;
      if (isStreamJson) {
        parsed = target.streamProtocol === "zcode" ? tryParseZcodeStreamJsonLine(line) : tryParseClaudeStreamJsonLine(line);
        if (parsed?.kind === "text-delta") structuredOutput += structuredOutput ? `\n${parsed.text}` : parsed.text;
        if (parsed?.kind === "final") structuredOutput = parsed.output;
        if (parsed?.kind === "init" && parsed.sessionId) sessionId = parsed.sessionId;
        if (parsed?.kind === "final" && parsed.sessionId) sessionId = parsed.sessionId;
      }
      opts.onChunk({ raw: line, ...(parsed ? { parsed } : {}) });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdoutAll += text;
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) emitLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

    child.on("error", (err) => finish({ status: "failed", output: err.message, durationMs: Date.now() - start, targetAgent }));
    child.on("close", (code, signal) => {
      if (lineBuffer) { emitLine(lineBuffer); lineBuffer = ""; }
      const durationMs = Date.now() - start;
      const finalOutput = isStreamJson ? structuredOutput : stdoutAll;

      if (cancelled) {
        finish({ status: "cancelled", output: finalOutput.trim(), durationMs, targetAgent, ...(sessionId ? { sessionId } : {}) });
        return;
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        finish({ status: "timeout", output: (finalOutput || stderr).trim(), durationMs, targetAgent, ...(sessionId ? { sessionId } : {}) });
        return;
      }
      if (code !== 0) {
        finish({ status: "failed", output: (stderr || finalOutput).trim(), durationMs, targetAgent });
        return;
      }
      if (isStreamJson) {
        finish({ status: "completed", output: finalOutput.trim(), durationMs, targetAgent, ...(sessionId ? { sessionId } : {}) });
        return;
      }
      const extracted = extractOutput(stdoutAll, target.outputFormat);
      finish({ status: "completed", output: extracted.output, durationMs, targetAgent, ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}) });
    });
  });
}
