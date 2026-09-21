/**
 * In-GUI chat with a managed/CLI Agent (trellis-gui chat feature). Unlike
 * every other route in this directory, this one does not follow the
 * plan/apply two-step pattern (design.md Decision 6): a chat message isn't
 * a write to canonical source, so there's no plan to confirm — instead
 * each `/chat/:chatId/message` call itself requires `confirm: true`,
 * mirroring the same "spawns a real subprocess with real side effects"
 * gate `AgentBridgeProvider` already uses for cross-Agent delegation.
 *
 * The actual streaming happens over the existing `/events` WebSocket
 * (`broadcast`, from `liveUpdates.ts`) with a `channel: "chat"` field, not
 * over this route's own HTTP response — `/chat/:chatId/message` responds
 * with `202` + a `turnId` as soon as the turn starts, and the caller
 * listens on the socket for `turn-start` → (`text-delta` | `tool-call` |
 * `tool-result` | `raw-chunk`)* → `turn-complete`.
 */
import { randomUUID } from "node:crypto";
import { loadChatAgentConfig } from "../../../../src/lib/chatAgents.js";
import { runDelegatedCallStreaming, type ParsedStreamEvent, type StreamChunk } from "../../../../src/lib/agentBridge.js";
import { readJsonBody, sendJson, type Route } from "../server.js";
import type { ChatSessionStore } from "../chatSessionStore.js";

function chatEventFor(chatId: string, turnId: string, parsed: ParsedStreamEvent): Record<string, unknown> | undefined {
  if (parsed.kind === "text-delta") {
    return { channel: "chat", chatId, turnId, type: "text-delta", text: parsed.text };
  }
  if (parsed.kind === "tool-call") {
    return { channel: "chat", chatId, turnId, type: "tool-call", toolCallId: parsed.toolCallId, name: parsed.name, input: parsed.input };
  }
  if (parsed.kind === "tool-result") {
    return { channel: "chat", chatId, turnId, type: "tool-result", toolCallId: parsed.toolCallId, output: parsed.output };
  }
  // "init" and "final" are bookkeeping only (session id extraction already
  // happens inside runDelegatedCallStreaming) — never surfaced as content.
  return undefined;
}

export function createChatRoutes(homeDir: string, store: ChatSessionStore, broadcast: (message: unknown) => void): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/chat\/targets$/,
      handler: (_req, res) => {
        const config = loadChatAgentConfig(homeDir);
        const targets = Object.entries(config.targets).map(([id, target]) => ({
          id,
          label: target.label,
          command: target.command,
          args: target.args,
          tags: target.tags ?? [],
          canResume: Boolean(target.resumeArgs),
        }));
        sendJson(res, 200, { targets });
      },
    },

    {
      method: "POST",
      pattern: /^\/chat\/start$/,
      handler: async (req, res) => {
        const body = await readJsonBody<{ targetId?: string; persona?: string }>(req);
        const targetId = body.targetId;
        const config = loadChatAgentConfig(homeDir);
        if (!targetId || !config.targets[targetId]) {
          sendJson(res, 400, { error: `unknown chat target "${targetId}"` });
          return;
        }
        const session = store.start(targetId, body.persona);
        sendJson(res, 200, { chatId: session.chatId, targetId: session.targetId });
      },
    },

    {
      method: "POST",
      pattern: /^\/chat\/(?<chatId>[^/]+)\/message$/,
      handler: async (req, res, params) => {
        const chatId = params.chatId ?? "";
        const session = store.get(chatId);
        if (!session) {
          sendJson(res, 404, { error: `no chat session "${chatId}"` });
          return;
        }
        if (session.activeTurn) {
          sendJson(res, 409, { error: `chat "${chatId}" already has a turn in flight` });
          return;
        }
        const body = await readJsonBody<{ message?: string; confirm?: boolean }>(req);
        if (body.confirm !== true) {
          sendJson(res, 400, { error: "sending a chat message requires confirm=true — it spawns a real subprocess with real side effects" });
          return;
        }
        const message = (body.message ?? "").trim();
        if (!message) {
          sendJson(res, 400, { error: "message must not be empty" });
          return;
        }
        const config = loadChatAgentConfig(homeDir);
        const target = config.targets[session.targetId];
        if (!target) {
          sendJson(res, 400, { error: `chat target "${session.targetId}" is no longer configured` });
          return;
        }

        const turnId = randomUUID();
        const controller = new AbortController();
        session.activeTurn = { turnId, controller };
        sendJson(res, 202, { turnId });

        // Runs after the HTTP response has already been sent — errors here
        // must never reach `handleRequest`'s catch block (the response is
        // already ended), so they're turned into a `type: "error"` WS
        // event instead of being allowed to throw.
        void (async () => {
          broadcast({ channel: "chat", chatId, turnId, type: "turn-start" });
          try {
            const onChunk = (chunk: StreamChunk): void => {
              if (!chunk.parsed) {
                broadcast({ channel: "chat", chatId, turnId, type: "raw-chunk", text: chunk.raw });
                return;
              }
              const event = chatEventFor(chatId, turnId, chunk.parsed);
              if (event) broadcast(event);
            };
            const result = await runDelegatedCallStreaming(session.targetId, target, message, {
              persona: session.persona,
              sessionId: session.sessionId,
              signal: controller.signal,
              onChunk,
            });
            if (result.sessionId) session.sessionId = result.sessionId;
            broadcast({
              channel: "chat",
              chatId,
              turnId,
              type: "turn-complete",
              status: result.status,
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            });
          } catch (err) {
            broadcast({ channel: "chat", chatId, turnId, type: "error", message: err instanceof Error ? err.message : String(err) });
          } finally {
            session.activeTurn = undefined;
          }
        })();
      },
    },

    {
      method: "POST",
      pattern: /^\/chat\/(?<chatId>[^/]+)\/cancel$/,
      handler: (_req, res, params) => {
        const chatId = params.chatId ?? "";
        const session = store.get(chatId);
        if (!session) {
          sendJson(res, 404, { error: `no chat session "${chatId}"` });
          return;
        }
        if (!session.activeTurn) {
          sendJson(res, 409, { error: `chat "${chatId}" has no turn in flight to cancel` });
          return;
        }
        const { turnId } = session.activeTurn;
        session.activeTurn.controller.abort();
        sendJson(res, 200, { turnId, status: "cancelling" });
      },
    },
  ];
}
