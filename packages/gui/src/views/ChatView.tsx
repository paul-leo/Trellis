/**
 * In-GUI multi-turn chat with a managed/CLI Agent, built directly on top
 * of `runDelegatedCallStreaming` (trellis-agent-bridge's one-shot delegated
 * call, upgraded to stream). Deliberately NOT a plan/apply flow like every
 * other write in this app — a chat message isn't a canonical-source write,
 * so there's nothing to preview as a diff; instead every message requires
 * an explicit `confirm=true`, gated behind a one-time-per-target-per-app-
 * session banner (`confirmedTargets`, module-level — resets only on a real
 * app restart, matching the design's Decision 6).
 *
 * Chat history is never persisted (design.md Decision 2): closing this
 * view, switching tabs, or restarting the app all lose it, on purpose —
 * message content may carry real code or secrets.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSidecar } from "../lib/SidecarProvider";
import { getJson, postJson } from "../lib/sidecar";
import { useI18n } from "../lib/i18n";

interface ChatTarget {
  id: string;
  label: string;
  command: string;
  args: string[];
  tags: string[];
  canResume: boolean;
}

type DisplayItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant-text"; text: string; typewriter: boolean }
  | { id: string; kind: "tool-call"; name: string; input: unknown }
  | { id: string; kind: "tool-result"; output: unknown }
  | { id: string; kind: "raw"; text: string }
  | { id: string; kind: "status"; text: string }
  | { id: string; kind: "error"; text: string };

interface ChatEventPayload {
  channel: "chat";
  chatId: string;
  turnId?: string;
  type: "turn-start" | "text-delta" | "tool-call" | "tool-result" | "raw-chunk" | "turn-complete" | "error";
  text?: string;
  toolCallId?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  status?: "completed" | "failed" | "timeout" | "cancelled";
  sessionId?: string;
  message?: string;
}

/** Which targets the user has already clicked "Confirm & send" for, this
 * app session. Module-level, not component state — `ChatView` is torn
 * down and rebuilt every time the user switches away and back to this
 * tab (`App.tsx` calls `.render()` fresh per tab, it doesn't keep the
 * component mounted off-screen), so component state alone would re-ask
 * on every tab switch, not just every app restart. */
const confirmedTargets = new Set<string>();

let displayItemCounter = 0;
function nextId(): string {
  displayItemCounter += 1;
  return `item-${displayItemCounter}`;
}

/** Reveals `text` a few characters at a time rather than all at once —
 * the typewriter effect. Runs once per mount; since each `text-delta`
 * produces a new `DisplayItem` with a stable `id` used as `key`, this
 * naturally animates only when that chunk first arrives, never again on
 * unrelated re-renders. */
function TypewriterText({ text }: { text: string }) {
  const [visibleChars, setVisibleChars] = useState(0);

  useEffect(() => {
    if (visibleChars >= text.length) return;
    const timer = setTimeout(() => setVisibleChars((n) => Math.min(n + 2, text.length)), 12);
    return () => clearTimeout(timer);
  }, [visibleChars, text]);

  return <>{text.slice(0, visibleChars)}</>;
}

function Bubble({ item }: { item: DisplayItem }) {
  const { t } = useI18n();
  if (item.kind === "user") {
    return (
      <div className="chat-bubble chat-bubble-user">
        <div className="chat-bubble-label">{t("chat.you")}</div>
        <div>{item.text}</div>
      </div>
    );
  }
  if (item.kind === "assistant-text") {
    return (
      <div className="chat-bubble chat-bubble-assistant">
        <div className="chat-bubble-label">{t("chat.agentLabel")}</div>
        <div>{item.typewriter ? <TypewriterText text={item.text} /> : item.text}</div>
      </div>
    );
  }
  if (item.kind === "tool-call") {
    return (
      <div className="chat-bubble chat-bubble-tool">
        <div className="chat-bubble-label">{t("chat.toolCall", { name: item.name })}</div>
        <pre>{JSON.stringify(item.input, null, 2)}</pre>
      </div>
    );
  }
  if (item.kind === "tool-result") {
    return (
      <div className="chat-bubble chat-bubble-tool">
        <div className="chat-bubble-label">{t("chat.toolResult")}</div>
        <pre>{typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)}</pre>
      </div>
    );
  }
  if (item.kind === "raw") {
    return (
      <div className="chat-bubble chat-bubble-raw">
        <div className="chat-bubble-label">{t("chat.unparsedOutput")}</div>
        <pre>{item.text}</pre>
      </div>
    );
  }
  if (item.kind === "status") {
    return <div className="chat-status">{item.text}</div>;
  }
  return <div className="chat-status chat-status-error">{item.text}</div>;
}

export function ChatView() {
  const { port, chatEvents } = useSidecar();
  const { t } = useI18n();
  const [targets, setTargets] = useState<ChatTarget[]>();
  const [targetsError, setTargetsError] = useState<string>();
  const [selectedTargetId, setSelectedTargetId] = useState<string>();
  const [chatId, setChatId] = useState<string>();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [draft, setDraft] = useState("");
  const [activeTurnId, setActiveTurnId] = useState<string>();
  const [pendingConfirm, setPendingConfirm] = useState<{ targetId: string; message: string } | undefined>();
  const [sendError, setSendError] = useState<string>();
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (port === undefined) return;
    let cancelled = false;
    getJson<{ targets: ChatTarget[] }>(port, "/chat/targets")
      .then((res) => {
        if (cancelled) return;
        setTargets(res.targets);
        setSelectedTargetId((current) => current ?? res.targets[0]?.id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setTargetsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [port]);

  // A fresh chat session per selected target — "switching agent" starts a
  // new conversation rather than trying to graft one target's history
  // onto another target's process.
  useEffect(() => {
    if (port === undefined || selectedTargetId === undefined) return;
    let cancelled = false;
    setItems([]);
    setChatId(undefined);
    setActiveTurnId(undefined);
    postJson<{ chatId: string }>(port, "/chat/start", { targetId: selectedTargetId })
      .then((res) => {
        if (!cancelled) setChatId(res.chatId);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSendError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [port, selectedTargetId]);

  useEffect(() => {
    if (chatId === undefined) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ChatEventPayload>).detail;
      if (detail.chatId !== chatId) return;
      if (detail.type === "turn-start") {
        setActiveTurnId(detail.turnId);
        return;
      }
      if (detail.type === "text-delta" && detail.text !== undefined) {
        setItems((prev) => [...prev, { id: nextId(), kind: "assistant-text", text: detail.text!, typewriter: true }]);
        return;
      }
      if (detail.type === "tool-call") {
        setItems((prev) => [...prev, { id: nextId(), kind: "tool-call", name: detail.name ?? "?", input: detail.input }]);
        return;
      }
      if (detail.type === "tool-result") {
        setItems((prev) => [...prev, { id: nextId(), kind: "tool-result", output: detail.output }]);
        return;
      }
      if (detail.type === "raw-chunk" && detail.text !== undefined) {
        setItems((prev) => [...prev, { id: nextId(), kind: "raw", text: detail.text! }]);
        return;
      }
      if (detail.type === "turn-complete") {
        setActiveTurnId(undefined);
        const statusText = detail.status ? t(`chat.status.${detail.status}`) : "";
        setItems((prev) => [...prev, { id: nextId(), kind: "status", text: t("chat.turnStatus", { status: statusText }) }]);
        return;
      }
      if (detail.type === "error") {
        setActiveTurnId(undefined);
        setItems((prev) => [...prev, { id: nextId(), kind: "error", text: detail.message ?? "unknown error" }]);
      }
    };
    chatEvents.addEventListener("chat", handler);
    return () => chatEvents.removeEventListener("chat", handler);
  }, [chatEvents, chatId, t]);

  useEffect(() => {
    // jsdom (the headless-DOM smoke test harness) doesn't implement
    // `Element.scrollTo` — guard rather than crash the whole tree in that
    // environment; a real browser/webview always has it.
    logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight });
  }, [items]);

  const selectedTarget = useMemo(() => targets?.find((target) => target.id === selectedTargetId), [targets, selectedTargetId]);

  async function actuallySend(targetId: string, message: string) {
    if (port === undefined || chatId === undefined) return;
    setSendError(undefined);
    setItems((prev) => [...prev, { id: nextId(), kind: "user", text: message }]);
    confirmedTargets.add(targetId);
    try {
      await postJson(port, `/chat/${chatId}/message`, { message, confirm: true });
    } catch (err) {
      setActiveTurnId(undefined);
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  function send() {
    const message = draft.trim();
    if (!message || selectedTargetId === undefined) return;
    setDraft("");
    if (!confirmedTargets.has(selectedTargetId)) {
      setPendingConfirm({ targetId: selectedTargetId, message });
      return;
    }
    void actuallySend(selectedTargetId, message);
  }

  async function cancelTurn() {
    if (port === undefined || chatId === undefined) return;
    try {
      await postJson(port, `/chat/${chatId}/cancel`, {});
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>{t("chat.title")}</h2>
      <p className="subtitle">{t("chat.subtitle")}</p>

      {targetsError && <div className="error-banner">{targetsError}</div>}
      {targets?.length === 0 && (
        <p className="empty-state">
          {t("chat.noTargetsPre")} <code>{t("chat.noTargetsCode")}</code> {t("chat.noTargetsMid")} <code>{t("chat.noTargetsCode2")}</code>.
        </p>
      )}

      {targets && targets.length > 0 && (
        <>
          <div className="card" style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <label htmlFor="chat-target-select" style={{ color: "var(--ink-muted)", fontSize: "0.85rem" }}>
              {t("chat.agentLabel")}
            </label>
            <select id="chat-target-select" value={selectedTargetId ?? ""} onChange={(e) => setSelectedTargetId(e.currentTarget.value)}>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </select>
            {selectedTarget?.tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>

          {sendError && <div className="error-banner">{sendError}</div>}

          <div className="chat-log" ref={logRef}>
            {items.length === 0 && <p className="empty-state">{t("chat.sayHello")}</p>}
            {items.map((item) => (
              <Bubble key={item.id} item={item} />
            ))}
          </div>

          <div className="chat-input-row">
            <input
              placeholder={t("chat.messagePlaceholder")}
              value={draft}
              disabled={chatId === undefined || activeTurnId !== undefined}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              style={{ flex: 1 }}
            />
            {activeTurnId !== undefined ? (
              <button onClick={() => void cancelTurn()}>{t("common.cancel")}</button>
            ) : (
              <button className="primary" disabled={!draft.trim() || chatId === undefined} onClick={send}>
                {t("chat.send")}
              </button>
            )}
          </div>
        </>
      )}

      {pendingConfirm && selectedTarget && (
        <div className="modal-backdrop" onClick={() => setPendingConfirm(undefined)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("chat.runTarget", { label: selectedTarget.label })}</h3>
            <p className="subtitle" style={{ marginBottom: "0.5rem" }}>
              {t("chat.confirmWarning")}
            </p>
            <pre>{[selectedTarget.command, ...selectedTarget.args].join(" ")}</pre>
            <p className="subtitle" style={{ marginBottom: 0 }}>{t("chat.confirmNote")}</p>
            <div className="modal-actions">
              <button onClick={() => setPendingConfirm(undefined)}>{t("common.cancel")}</button>
              <button
                className="primary"
                onClick={() => {
                  const { targetId, message } = pendingConfirm;
                  setPendingConfirm(undefined);
                  void actuallySend(targetId, message);
                }}
              >
                {t("chat.confirmSend")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
