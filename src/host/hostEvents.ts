/**
 * Host-extension-point event types (host-extension-points spec).
 *
 * The field whitelist is enforced at the type layer: an event object carries
 * only the metadata listed here — never tool inputs, tool results, or any
 * content derived from them. Factories copy exactly the whitelist fields (so
 * even untyped callers cannot smuggle a payload through) and freeze the
 * result. "session_start" carries the workspace root observed by the process;
 * consumers derive layer attribution from it (null = no workspace).
 */

/** How a tool call ended — the only result information an event may carry. */
export type ToolResultCategory = "ok" | "error" | "timeout";

export interface ToolCallEvent {
  readonly kind: "tool_call";
  /** Epoch milliseconds. */
  readonly ts: number;
  readonly agent: string;
  readonly session: string;
  readonly provider: string;
  /** The externally exposed (aggregated) tool name. */
  readonly tool: string;
  readonly durationMs: number;
  readonly result: ToolResultCategory;
}

export interface SessionStartEvent {
  readonly kind: "session_start";
  readonly ts: number;
  readonly agent: string;
  readonly session: string;
  /** Workspace root observed by the process at startup; null when the session
   * has no workspace attribution (signal-layer attribution derives from it). */
  readonly workspaceRoot: string | null;
}

export interface SessionEndEvent {
  readonly kind: "session_end";
  readonly ts: number;
  readonly agent: string;
  readonly session: string;
}

export type HostEvent = ToolCallEvent | SessionStartEvent | SessionEndEvent;

/** Metadata for one routed tool call — the only inputs an event choke point
 * accepts (never call arguments, never result content). */
export interface ToolCallInfo {
  provider: string;
  tool: string;
  durationMs: number;
  result: ToolResultCategory;
}

// Compile-time whitelist enforcement (surfaced by `tsc --noEmit`): widening any
// event type with a payload field breaks these exact-key assertions. Kept
// unexported so the public surface stays the event types alone.
type _Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type _Expect<T extends true> = T;
type _ToolCallKeysExact = _Expect<
  _Eq<keyof ToolCallEvent, "kind" | "ts" | "agent" | "session" | "provider" | "tool" | "durationMs" | "result">
>;
type _SessionStartKeysExact = _Expect<
  _Eq<keyof SessionStartEvent, "kind" | "ts" | "agent" | "session" | "workspaceRoot">
>;
type _SessionEndKeysExact = _Expect<_Eq<keyof SessionEndEvent, "kind" | "ts" | "agent" | "session">>;

/** Build a tool-call event from metadata only — call inputs and results never
 * reach this factory, and only the whitelist fields land on the event. */
export function toolCallEvent(input: {
  ts: number;
  agent: string;
  session: string;
  provider: string;
  tool: string;
  durationMs: number;
  result: ToolResultCategory;
}): ToolCallEvent {
  return Object.freeze({
    kind: "tool_call" as const,
    ts: input.ts,
    agent: input.agent,
    session: input.session,
    provider: input.provider,
    tool: input.tool,
    durationMs: input.durationMs,
    result: input.result,
  });
}

/** Build a session-start event; `workspaceRoot` is the process-observed root
 * or null when the session has no workspace attribution. */
export function sessionStartEvent(input: {
  ts: number;
  agent: string;
  session: string;
  workspaceRoot: string | null;
}): SessionStartEvent {
  return Object.freeze({
    kind: "session_start" as const,
    ts: input.ts,
    agent: input.agent,
    session: input.session,
    workspaceRoot: input.workspaceRoot,
  });
}

/** Build a session-end event. Emitted before upstream release on orderly
 * shutdown; not guaranteed on SIGKILL/crash (spec says so explicitly). */
export function sessionEndEvent(input: {
  ts: number;
  agent: string;
  session: string;
}): SessionEndEvent {
  return Object.freeze({
    kind: "session_end" as const,
    ts: input.ts,
    agent: input.agent,
    session: input.session,
  });
}
