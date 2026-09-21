/**
 * In-memory-only chat session state (trellis-gui chat feature Decision 2):
 * a chat's message content can carry real code/secrets, so it is
 * deliberately never written to `~/.trellis` or any other disk location —
 * the same discipline this codebase already applies to secrets elsewhere.
 * The cost is real: closing the app loses history. That trade-off is
 * intentional, not an oversight.
 */
import { randomUUID } from "node:crypto";

export interface ChatSession {
  readonly chatId: string;
  readonly targetId: string;
  readonly persona?: string;
  /** The underlying CLI's own session id, set from the previous turn's
   * result (when it reported one) so the next turn can resume instead of
   * starting fresh. */
  sessionId?: string;
  /** Set for the duration of an in-flight turn; `controller.abort()` is
   * how `/chat/:chatId/cancel` interrupts it. */
  activeTurn?: { turnId: string; controller: AbortController };
}

export interface ChatSessionStore {
  start(targetId: string, persona?: string): ChatSession;
  /** Returns `undefined` for an unknown id rather than throwing — every
   * caller already has to handle "no such chat" as a normal 404, not an
   * exceptional case. */
  get(chatId: string): ChatSession | undefined;
}

export function createChatSessionStore(): ChatSessionStore {
  const sessions = new Map<string, ChatSession>();
  return {
    start(targetId, persona): ChatSession {
      const session: ChatSession = { chatId: randomUUID(), targetId, ...(persona ? { persona } : {}) };
      sessions.set(session.chatId, session);
      return session;
    },
    get(chatId): ChatSession | undefined {
      return sessions.get(chatId);
    },
  };
}
