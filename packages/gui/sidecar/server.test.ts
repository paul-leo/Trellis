import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createSidecarServer, listenOnEphemeralLoopbackPort, readJsonBody, sendJson, type Route } from "./server.js";

function get(port: number, path: string): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function options(port: number, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "OPTIONS" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function post(port: number, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

test("sidecar server: listens on an OS-assigned loopback port and serves a real matched route end to end", async () => {
  const routes: Route[] = [
    { method: "GET", pattern: /^\/ping$/, handler: (_req, res) => sendJson(res, 200, { pong: true }) },
  ];
  const server = createSidecarServer(routes);
  const port = await listenOnEphemeralLoopbackPort(server);
  assert.ok(port > 0, "must bind to a real, OS-assigned port, not a hardcoded one");

  try {
    const { status, body } = await get(port, "/ping");
    assert.equal(status, 200);
    assert.deepEqual(body, { pong: true });
  } finally {
    server.close();
  }
});

test("sidecar server: an unmatched route returns 404, not a crash", async () => {
  const server = createSidecarServer([]);
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { status, body } = await get(port, "/nope");
    assert.equal(status, 404);
    assert.match(String((body as { error: string }).error), /no route/);
  } finally {
    server.close();
  }
});

test("sidecar server: a route handler that throws is reported as 500, not left hanging", async () => {
  const routes: Route[] = [
    { method: "GET", pattern: /^\/boom$/, handler: () => { throw new Error("deliberate"); } },
  ];
  const server = createSidecarServer(routes);
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { status, body } = await get(port, "/boom");
    assert.equal(status, 500);
    assert.match(String((body as { error: string }).error), /deliberate/);
  } finally {
    server.close();
  }
});

test("sidecar server: every response carries permissive CORS headers, and OPTIONS preflight succeeds", async () => {
  // Regression test for a real bug this suite's own HTTP-client-based
  // tests could never catch: `node:http`'s `request()` (used by every
  // test in this file) and jsdom's `fetch` never enforce CORS the way a
  // real browser does, so the sidecar shipped with zero CORS headers
  // for a long time before anyone noticed — it only surfaced once the
  // app was actually opened in a real Tauri webview ("Load failed" on
  // every view, since the webview's origin differs from
  // `http://127.0.0.1:<port>`). This test can only assert the headers
  // are present and correct, not that a browser would actually allow
  // the read — but a header regression here is exactly what would
  // reintroduce that bug.
  const routes: Route[] = [{ method: "GET", pattern: /^\/ping$/, handler: (_req, res) => sendJson(res, 200, { pong: true }) }];
  const server = createSidecarServer(routes);
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const getResult = await get(port, "/ping");
    assert.equal(getResult.headers["access-control-allow-origin"], "*");

    const preflight = await options(port, "/plan/mcp-add");
    assert.equal(preflight.status, 204, "an OPTIONS preflight must succeed even for an unmatched-by-GET/POST route");
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.match(String(preflight.headers["access-control-allow-methods"]), /POST/);
    assert.match(String(preflight.headers["access-control-allow-headers"]), /content-type/);
  } finally {
    server.close();
  }
});

test("sidecar server: readJsonBody parses a real posted body", async () => {
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/echo$/,
      handler: async (req, res) => {
        const body = await readJsonBody<{ hello: string }>(req);
        sendJson(res, 200, body);
      },
    },
  ];
  const server = createSidecarServer(routes);
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { status, body } = await post(port, "/echo", { hello: "world" });
    assert.equal(status, 200);
    assert.deepEqual(body, { hello: "world" });
  } finally {
    server.close();
  }
});
