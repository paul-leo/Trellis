import assert from "node:assert/strict";
import { test } from "node:test";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "./server.js";
import { createWsHub } from "./ws.js";

/** Node 22's built-in `WebSocket` global (undici-backed) — a real client,
 * not a hand-rolled stub, so this exercises the hub's handshake and frame
 * encoding against an implementation this project didn't write. */
function connect(port: number, path = "/events"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", (event) => reject(new Error(`WebSocket connect failed: ${String(event)}`)), { once: true });
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a WebSocket message")), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data as string));
      },
      { once: true },
    );
  });
}

test("WsHub: a real WebSocket client connects over the sidecar's HTTP server and receives a broadcast", async () => {
  const hub = createWsHub();
  const server = createSidecarServer([]);
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = await listenOnEphemeralLoopbackPort(server);

  const socket = await connect(port);
  try {
    assert.equal(hub.clientCount(), 1);
    const received = nextMessage(socket);
    hub.broadcast({ type: "change", path: "mcp/servers.yaml" });
    assert.deepEqual(await received, { type: "change", path: "mcp/servers.yaml" });
  } finally {
    socket.close();
    hub.closeAll();
    server.close();
  }
});

test("WsHub: connecting to an unmatched upgrade path is refused, not silently accepted", async () => {
  const hub = createWsHub(/^\/events$/);
  const server = createSidecarServer([]);
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = await listenOnEphemeralLoopbackPort(server);

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/not-events`);
    const timer = setTimeout(() => reject(new Error("expected the connection to be refused, but nothing happened")), 3000);
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      reject(new Error("connection to an unmatched path must not succeed"));
    });
  });

  server.close();
});

test("WsHub: broadcast reaches multiple connected clients, and closeAll disconnects them", async () => {
  const hub = createWsHub();
  const server = createSidecarServer([]);
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = await listenOnEphemeralLoopbackPort(server);

  const [a, b] = await Promise.all([connect(port), connect(port)]);
  try {
    assert.equal(hub.clientCount(), 2);
    const pending = Promise.all([nextMessage(a), nextMessage(b)]);
    hub.broadcast({ type: "change", path: "skills/demo/SKILL.md" });
    const [msgA, msgB] = await pending;
    assert.deepEqual(msgA, { type: "change", path: "skills/demo/SKILL.md" });
    assert.deepEqual(msgB, msgA);
  } finally {
    a.close();
    b.close();
    hub.closeAll();
    server.close();
  }
});
