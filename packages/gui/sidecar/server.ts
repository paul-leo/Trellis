/**
 * The sidecar's minimal HTTP control-plane (trellis-gui design.md
 * Decision 2). Deliberately `node:http` with no framework dependency —
 * the API surface is small and this keeps the sidecar's own dependency
 * footprint as lean as agent-trellis's own (design.md Risks).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isLoopbackAddress } from "./net.js";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

export interface Route {
  method: "GET" | "POST";
  /** Matched against `url.pathname`. Use named capture groups for params. */
  pattern: RegExp;
  handler: RouteHandler;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf-8"); });
    req.on("end", () => {
      if (!raw.trim()) { resolve({} as T); return; }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The Tauri webview loads the React app from its own origin
 * (`http://localhost:1420` in dev, `tauri://localhost` in a packaged
 * build) — a different origin than this server's `http://127.0.0.1:
 * <port>`, so without CORS headers the browser blocks the frontend's own
 * `fetch()` calls from ever reading the response (this is exactly what
 * surfaced as "Load failed" in every view once the app was actually run
 * in a real webview — `curl`/Node `fetch()` in every prior test never
 * enforces CORS, so this gap was invisible until then). A permissive
 * `*` origin is consistent with design.md Decision 3's actual trust
 * boundary: CORS is a browser page-isolation mechanism, not the real
 * security boundary here, which is the loopback bind + the connection-
 * level guard in `createSidecarServer` below — both unaffected by this.
 */
function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, routes: readonly Route[]): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    // The browser's own CORS preflight for any POST with a JSON body —
    // `application/json` isn't a "simple" content type, so every
    // `/plan/*`/`/apply/*` call triggers one of these first. Never
    // reaches route matching; there's nothing operation-specific to
    // decide here.
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    try {
      await route.handler(req, res, match.groups ?? {});
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  sendJson(res, 404, { error: `no route for ${req.method ?? "?"} ${url.pathname}` });
}

/** Builds the server with the loopback connection guard wired in.
 * Binding to `127.0.0.1` (see `listenOnEphemeralLoopbackPort`) is what
 * actually keeps external traffic out — the OS never delivers a
 * non-loopback packet to a socket bound only there. This per-connection
 * check is the explicit, unit-testable second layer that stays correct
 * even if the bind address is ever changed by mistake (spec: "Local-only
 * binding"). */
export function createSidecarServer(routes: readonly Route[]): Server {
  const server = createServer((req, res) => {
    void handleRequest(req, res, routes);
  });
  server.on("connection", (socket) => {
    if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy();
  });
  return server;
}

/** Listens on an OS-assigned loopback port and resolves with it. The
 * caller is responsible for printing it as the sidecar's announced port
 * (design.md Decision 2/3) — this function only owns the socket. */
export function listenOnEphemeralLoopbackPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}
