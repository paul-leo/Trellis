import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { resolveSidecarPort, websocketUrl } from "./sidecar";

interface SidecarContextValue {
  /** `undefined` while the port is still being resolved. */
  port: number | undefined;
  error: string | undefined;
  /** Bumped once per WebSocket change event — views `useEffect` on this
   * to refetch without a manual reload (spec: "Live state updates on
   * canonical source changes"). */
  liveVersion: number;
  /** Every `channel: "chat"` WS message is dispatched here as a
   * `CustomEvent<unknown>` named `"chat"`, instead of bumping
   * `liveVersion` — chat streaming has nothing to do with "a canonical
   * source file changed, go refetch" (`useFetch`'s contract), so it gets
   * its own channel rather than triggering every read view's fetch on
   * every text-delta. `ChatView` is the only consumer. */
  chatEvents: EventTarget;
}

const SidecarContext = createContext<SidecarContextValue>({ port: undefined, error: undefined, liveVersion: 0, chatEvents: new EventTarget() });

export function useSidecar(): SidecarContextValue {
  return useContext(SidecarContext);
}

export function SidecarProvider({ children }: { children: ReactNode }) {
  const [port, setPort] = useState<number>();
  const [error, setError] = useState<string>();
  const [liveVersion, setLiveVersion] = useState(0);
  // A ref, not state: dispatching on it must never itself trigger a
  // re-render of everything under `SidecarProvider` — only `ChatView`
  // (which explicitly subscribes) should react to a chat event.
  const chatEventsRef = useRef<EventTarget>(new EventTarget());

  useEffect(() => {
    let cancelled = false;
    resolveSidecarPort()
      .then((resolved) => {
        if (!cancelled) setPort(resolved);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (port === undefined) return;
    const socket = new WebSocket(websocketUrl(port));
    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        // Not JSON — fall back to the pre-chat behavior rather than drop it.
        setLiveVersion((v) => v + 1);
        return;
      }
      if (parsed && typeof parsed === "object" && (parsed as { channel?: unknown }).channel === "chat") {
        chatEventsRef.current.dispatchEvent(new CustomEvent("chat", { detail: parsed }));
        return;
      }
      setLiveVersion((v) => v + 1);
    });
    return () => socket.close();
  }, [port]);

  return <SidecarContext.Provider value={{ port, error, liveVersion, chatEvents: chatEventsRef.current }}>{children}</SidecarContext.Provider>;
}
