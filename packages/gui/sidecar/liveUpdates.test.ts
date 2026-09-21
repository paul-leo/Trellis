import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "./server.js";
import { createPlanApplyRoutes } from "./routes/planApply.js";
import { PlanStore } from "./planStore.js";
import { createLiveUpdates } from "./liveUpdates.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function cli(homeDir: string, args: string[]): string {
  return execFileSync("npx", ["tsx", "src/cli.ts", ...args], { cwd: repoRoot, env: { ...process.env, HOME: homeDir }, encoding: "utf-8" });
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

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/events`);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", (event) => reject(new Error(`WebSocket connect failed: ${String(event)}`)), { once: true });
  });
}

test("live updates: a mutation applied through the sidecar's own /apply/mcp-add produces exactly one broadcast for servers.yaml (task 4.2)", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-liveupdates-"));
  cli(homeDir, ["init"]);

  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  // A short debounce keeps this test fast without weakening the
  // exactly-once guarantee itself, which holds for any debounce window —
  // see watcher.ts's doc comment: there is only ever one broadcaster
  // (the watcher), so there is nothing on the write-path side to
  // duplicate against regardless of window length.
  const liveUpdates = createLiveUpdates(homeDir, 50);
  liveUpdates.attach(server);
  const port = await listenOnEphemeralLoopbackPort(server);

  const messages: Array<{ type: string; path: string }> = [];
  const socket = await connect(port);
  socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string)));

  try {
    const planned = await post(port, "/plan/mcp-add", { name: "live-server", raw: { transport: "stdio", command: "echo" } });
    const { planId } = planned.body as { planId: string };
    const applied = await post(port, "/apply/mcp-add", { planId });
    assert.equal(applied.status, 200);

    // Give the debounced watcher time to fire and the WS frame time to
    // arrive, then hold a little longer to prove nothing further trickles
    // in — the real risk this test guards against (write-path broadcast
    // AND watcher-observed broadcast, both firing) would show up as a
    // second event landing after the first, not as a faster first event.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // `mcp/servers.yaml` (the canonical file itself) is distinct from
    // `backups/<runId>/files/0-servers.yaml` (the pre-write snapshot the
    // tasks.md 3.5 backup-session fix copies alongside it) — both
    // legitimately end in "servers.yaml" but are two different real
    // paths, so filter on the canonical path exactly rather than a loose
    // suffix match.
    const serversYamlEvents = messages.filter((m) => m.path === "mcp/servers.yaml");
    assert.equal(serversYamlEvents.length, 1, `expected exactly one broadcast for mcp/servers.yaml, got ${serversYamlEvents.length}: ${JSON.stringify(messages)}`);
  } finally {
    socket.close();
    liveUpdates.close();
    server.close();
  }
});
