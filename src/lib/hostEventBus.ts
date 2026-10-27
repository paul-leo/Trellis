/**
 * In-process host event bus (host-extension-points spec).
 *
 * Dispatch is synchronous and ordered: `emit` walks listeners at the event
 * point so a session-end event is observably delivered before upstream
 * release continues. Failures are contained per listener — a synchronous
 * throw or a rejected promise is swallowed and warned, never propagated to
 * the tool call or to sibling listeners. With no subscribers `emit` is a
 * single length check (zero overhead; runtime behavior stays byte-identical
 * to the pre-event world). Listeners are expected to return promptly; slow
 * work belongs behind the returned promise, which the caller never awaits.
 */

import { randomUUID } from "node:crypto";
import {
  sessionEndEvent,
  sessionStartEvent,
  toolCallEvent,
  type HostEvent,
  type ToolCallInfo,
} from "../host/hostEvents.js";

export type HostEventListener = (event: HostEvent) => void | Promise<void>;

export class HostEventBus {
  private readonly listeners: HostEventListener[] = [];

  constructor(private readonly warn: (message: string) => void = console.error) {}

  /** Register a listener; returns its unsubscribe function. Registration
   * failure isolation for extensions is the loader's job (8.6) — this method
   * only ever pushes. */
  subscribe(listener: HostEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  emit(event: HostEvent): void {
    if (this.listeners.length === 0) return;
    for (const listener of this.listeners) {
      try {
        const pending = listener(event);
        if (pending && typeof (pending as Promise<void>).then === "function") {
          void (pending as Promise<void>).catch((err) => {
            this.warn(`trellis-host-events: subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        this.warn(`trellis-host-events: subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.length;
  }
}

/**
 * Stamps events with process-level identity. One instance per gateway
 * process: `sessionId` is generated here and carried unchanged on every
 * event the process emits ("会话开始"/tool calls/"会话结束").
 */
export class HostEventEmitter {
  readonly sessionId: string;

  constructor(
    private readonly opts: {
      bus: HostEventBus;
      agent: string;
      /** Workspace root observed by the process; null = no workspace
       * attribution (consumers derive layer from this). */
      workspaceRoot: string | null;
      now?: () => number;
      sessionId?: string;
    },
  ) {
    this.sessionId = opts.sessionId ?? randomUUID();
  }

  private ts(): number {
    return (this.opts.now ?? Date.now)();
  }

  sessionStart(): void {
    this.opts.bus.emit(sessionStartEvent({
      ts: this.ts(),
      agent: this.opts.agent,
      session: this.sessionId,
      workspaceRoot: this.opts.workspaceRoot,
    }));
  }

  toolCall(info: ToolCallInfo): void {
    this.opts.bus.emit(toolCallEvent({
      ts: this.ts(),
      agent: this.opts.agent,
      session: this.sessionId,
      provider: info.provider,
      tool: info.tool,
      durationMs: info.durationMs,
      result: info.result,
    }));
  }

  sessionEnd(): void {
    this.opts.bus.emit(sessionEndEvent({
      ts: this.ts(),
      agent: this.opts.agent,
      session: this.sessionId,
    }));
  }
}
