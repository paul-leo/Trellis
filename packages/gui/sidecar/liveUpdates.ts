/**
 * Composes `watchTrellisHome` + `createWsHub` into the one thing
 * `index.ts`'s bootstrap needs: watch `~/.trellis`, broadcast every
 * change to every connected WebSocket client. Kept as its own module
 * (rather than inlined in `index.ts`) so `watcher.ts`/`ws.ts` each stay
 * independently unit-testable without needing a real `http.Server`.
 */

import type { Server } from "node:http";
import { watchTrellisHome, type TrellisWatcher } from "./watcher.js";
import { createWsHub, type WsHub } from "./ws.js";

export interface LiveUpdates {
  attach(server: Server): void;
  /** Pushes an arbitrary message to every connected client over the same
   * `/events` socket the file watcher already broadcasts on — used by the
   * chat feature's `channel: "chat"` events (design.md Decision 1: one WS
   * endpoint, distinguished by a `channel` field, rather than a second
   * `WsHub` on the same `http.Server`, which is unsafe — see `ws.ts`'s own
   * single-hub assumption). */
  broadcast(message: unknown): void;
  close(): void;
}

export function createLiveUpdates(homeDir: string, debounceMs?: number): LiveUpdates {
  const hub: WsHub = createWsHub();
  const watcher: TrellisWatcher = watchTrellisHome(homeDir, (event) => hub.broadcast(event), debounceMs);

  return {
    attach(server: Server): void {
      server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
    },
    broadcast(message: unknown): void {
      hub.broadcast(message);
    },
    close(): void {
      watcher.close();
      hub.closeAll();
    },
  };
}
