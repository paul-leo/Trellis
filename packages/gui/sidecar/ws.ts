/**
 * A minimal, broadcast-only WebSocket hub — hand-rolled on `node:http`'s
 * `upgrade` event and `node:crypto`, same "no framework dependency"
 * posture `server.ts` already holds for the plain HTTP side (design.md
 * Decision 2 treats the sidecar's whole surface as one deliberately small
 * dependency footprint, relevant again in task group 5 when it's compiled
 * to a single-file binary). The server only ever pushes JSON change
 * events to connected clients — it never needs to parse a client's own
 * text/binary frames, so inbound frame parsing is deliberately not
 * implemented; only enough to not crash a connection that sends one.
 *
 * The loopback guard `server.ts`'s own `connection` handler applies is
 * already in effect before `upgrade` ever fires — a non-loopback socket
 * is destroyed at TCP accept time, before any HTTP parsing happens — so
 * this module doesn't re-check it.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_HANDSHAKE_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKeyFor(clientKey: string): string {
  return createHash("sha1").update(clientKey + WS_HANDSHAKE_MAGIC).digest("base64");
}

/** RFC 6455 §5.2 — server-to-client frames are never masked. Handles the
 * three payload-length encodings (7-bit, 16-bit extended, 64-bit
 * extended); this hub only ever sends JSON text, so only the text
 * opcode (0x1) is needed. */
function encodeTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf-8");
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

export interface WsHub {
  /** Wire this up to the underlying `http.Server`'s own `"upgrade"`
   * event — kept as a plain method, not something `WsHub` attaches
   * itself, so `server.ts` stays framework-free and unaware this module
   * exists (same separation `routes/*.ts` already has from `server.ts`). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  broadcast(message: unknown): void;
  clientCount(): number;
  closeAll(): void;
}

export function createWsHub(pathPattern: RegExp = /^\/events$/): WsHub {
  const clients = new Set<Duplex>();

  return {
    handleUpgrade(req, socket): void {
      const key = req.headers["sec-websocket-key"];
      if (!pathPattern.test(req.url ?? "") || typeof key !== "string") {
        socket.destroy();
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`,
      );
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
      // Drain inbound frames without parsing them (see module doc
      // comment) — otherwise a client's own ping/close frames pile up
      // unread and eventually apply TCP backpressure to that socket.
      socket.on("data", () => {});
    },

    broadcast(message): void {
      const frame = encodeTextFrame(JSON.stringify(message));
      for (const socket of clients) {
        socket.write(frame);
      }
    },

    clientCount(): number {
      return clients.size;
    },

    closeAll(): void {
      for (const socket of clients) socket.end();
      clients.clear();
    },
  };
}
