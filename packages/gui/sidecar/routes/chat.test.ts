import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "../server.js";
import { createChatRoutes } from "./chat.js";
import { createChatSessionStore } from "../chatSessionStore.js";
import { createWsHub } from "../ws.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const STUB_CLI = join(repoRoot, "test/fixtures/stub-agent-cli.js");

function chatAgentsHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-chat-"));
  const mcpDir = join(homeDir, ".trellis", "mcp");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(
    join(mcpDir, "chat-agents.yaml"),
    [
      "targets:",
      "  stub-stream:",
      '    label: "Stub (stream)"',
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(STUB_CLI)}, "stream", "{prompt}"]`,
      "    outputFormat: stream-json",
      '    tags: ["test"]',
      "  stub-hang:",
      '    label: "Stub (hang)"',
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(STUB_CLI)}, "hang", "{prompt}"]`,
      "    timeoutMs: 30000",
      "",
    ].join("\n"),
  );
  return homeDir;
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/events`);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", (event) => reject(new Error(`WebSocket connect failed: ${String(event)}`)), { once: true });
  });
}

function waitFor(messages: Array<Record<string, unknown>>, predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const found = messages.find(predicate);
      if (found) { resolve(found); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error(`timed out waiting for a matching message; got: ${JSON.stringify(messages)}`)); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("GET /chat/targets: lists the real chat-agents.yaml targets, without leaking anything beyond what the user wrote there", async () => {
  const homeDir = chatAgentsHome();
  const store = createChatSessionStore();
  const hub = createWsHub();
  const server = createSidecarServer(createChatRoutes(homeDir, store, (m) => hub.broadcast(m)));
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { status, body } = await get(port, "/chat/targets");
    assert.equal(status, 200);
    const targets = (body as { targets: Array<{ id: string; label: string; canResume: boolean }> }).targets;
    const ids = targets.map((t) => t.id).sort();
    assert.deepEqual(ids, ["stub-hang", "stub-stream"]);
    const stream = targets.find((t) => t.id === "stub-stream");
    assert.equal(stream?.label, "Stub (stream)");
    assert.equal(stream?.canResume, false);
  } finally {
    hub.closeAll();
    server.close();
  }
});

test("POST /chat/start: an unknown targetId is rejected with 400, no session created", async () => {
  const homeDir = chatAgentsHome();
  const store = createChatSessionStore();
  const hub = createWsHub();
  const server = createSidecarServer(createChatRoutes(homeDir, store, (m) => hub.broadcast(m)));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { status, body } = await post(port, "/chat/start", { targetId: "not-configured" });
    assert.equal(status, 400);
    assert.match(String((body as { error: string }).error), /unknown chat target/);
  } finally {
    hub.closeAll();
    server.close();
  }
});

test("full real flow: start -> message -> a real stream-json spawn streams turn-start, tool-call, tool-result, text-delta, turn-complete over the real WebSocket", async () => {
  const homeDir = chatAgentsHome();
  const store = createChatSessionStore();
  const hub = createWsHub();
  const server = createSidecarServer(createChatRoutes(homeDir, store, (m) => hub.broadcast(m)));
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = await listenOnEphemeralLoopbackPort(server);
  const messages: Array<Record<string, unknown>> = [];
  const socket = await connect(port);
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string)));

  try {
    const started = await post(port, "/chat/start", { targetId: "stub-stream" });
    assert.equal(started.status, 200);
    const { chatId } = started.body as { chatId: string };
    assert.ok(chatId);

    const sent = await post(port, `/chat/${chatId}/message`, { message: "hello", confirm: true });
    assert.equal(sent.status, 202);
    const { turnId } = sent.body as { turnId: string };
    assert.ok(turnId);

    const complete = await waitFor(messages, (m) => m.type === "turn-complete" && m.chatId === chatId);
    assert.equal(complete.status, "completed");
    assert.equal(complete.sessionId, "stub-session-123");

    assert.ok(messages.some((m) => m.type === "turn-start" && m.chatId === chatId));
    assert.ok(messages.some((m) => m.type === "tool-call" && m.name === "read_file"));
    assert.ok(messages.some((m) => m.type === "tool-result" && m.output === "file contents"));
    assert.ok(messages.some((m) => m.type === "text-delta" && m.text === "stream-reply:hello"));
    for (const m of messages) assert.equal(m.channel, "chat");

    // Ordering: turn-start must be the very first chat event for this turn.
    const chatEvents = messages.filter((m) => m.chatId === chatId);
    assert.equal(chatEvents[0]?.type, "turn-start");
    assert.equal(chatEvents[chatEvents.length - 1]?.type, "turn-complete");
  } finally {
    socket.close();
    hub.closeAll();
    server.close();
  }
});

test("POST /chat/:chatId/message: requires confirm=true, and refuses without spawning anything", async () => {
  const homeDir = chatAgentsHome();
  const store = createChatSessionStore();
  const hub = createWsHub();
  const server = createSidecarServer(createChatRoutes(homeDir, store, (m) => hub.broadcast(m)));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const started = await post(port, "/chat/start", { targetId: "stub-stream" });
    const { chatId } = started.body as { chatId: string };
    const { status, body } = await post(port, `/chat/${chatId}/message`, { message: "hello" });
    assert.equal(status, 400);
    assert.match(String((body as { error: string }).error), /confirm=true/);
  } finally {
    hub.closeAll();
    server.close();
  }
});

test("POST /chat/:chatId/message: a second message while one is already in flight is refused with 409", async () => {
  const homeDir = chatAgentsHome();
  const store = createChatSessionStore();
  const hub = createWsHub();
  const server = createSidecarServer(createChatRoutes(homeDir, store, (m) => hub.broadcast(m)));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const started = await post(port, "/chat/start", { targetId: "stub-hang" });
    const { chatId } = started.body as { chatId: string };
    const first = await post(port, `/chat/${chatId}/message`, { message: "hello", confirm: true });
    assert.equal(first.status, 202);
    const second = await post(port, `/chat/${chatId}/message`, { message: "again", confirm: true });
    assert.equal(second.status, 409);
    // Clean up the still-hanging turn so the process can exit.
    await post(port, `/chat/${chatId}/cancel`, {});
  } finally {
    hub.closeAll();
    server.close();
  }
});

test("POST /chat/:chatId/cancel: interrupts an in-flight turn — turn-complete arrives with status cancelled, well before any real timeout", async () => {
  const homeDir = chatAgentsHome();
  const store = createChatSessionStore();
  const hub = createWsHub();
  const server = createSidecarServer(createChatRoutes(homeDir, store, (m) => hub.broadcast(m)));
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = await listenOnEphemeralLoopbackPort(server);
  const messages: Array<Record<string, unknown>> = [];
  const socket = await connect(port);
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string)));

  try {
    const started = await post(port, "/chat/start", { targetId: "stub-hang" });
    const { chatId } = started.body as { chatId: string };
    const sent = await post(port, `/chat/${chatId}/message`, { message: "hello", confirm: true });
    assert.equal(sent.status, 202);

    await waitFor(messages, (m) => m.type === "turn-start" && m.chatId === chatId);

    const cancelStart = Date.now();
    const cancelled = await post(port, `/chat/${chatId}/cancel`, {});
    assert.equal(cancelled.status, 200);

    const complete = await waitFor(messages, (m) => m.type === "turn-complete" && m.chatId === chatId);
    assert.equal(complete.status, "cancelled");
    assert.ok(Date.now() - cancelStart < 4000, "cancellation must resolve quickly, not wait out the 30s configured timeout");
  } finally {
    socket.close();
    hub.closeAll();
    server.close();
  }
});

test("POST /chat/:chatId/cancel: an unknown chatId is a 404, not a throw", async () => {
  const homeDir = chatAgentsHome();
  const store = createChatSessionStore();
  const hub = createWsHub();
  const server = createSidecarServer(createChatRoutes(homeDir, store, (m) => hub.broadcast(m)));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { status } = await post(port, "/chat/not-a-real-chat/cancel", {});
    assert.equal(status, 404);
  } finally {
    hub.closeAll();
    server.close();
  }
});
