import { OAuthJobs } from "../oauthJobs.js";
import { readJsonBody, sendJson, type Route } from "../server.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"]);

export function requireDesktopOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (typeof req.headers.origin !== "string" || !ORIGINS.has(req.headers.origin)) {
    res.removeHeader("access-control-allow-origin");
    sendJson(res, 403, { error: "Authorization requires a trusted desktop origin" });
    return false;
  }
  res.setHeader("access-control-allow-origin", req.headers.origin);
  res.setHeader("vary", "Origin");
  return true;
}

export function createOAuthRoutes(jobs: OAuthJobs): Route[] {
  return [
    { method: "POST", pattern: /^\/oauth\/start$/, handler: async (req, res) => {
      if (!requireDesktopOrigin(req, res)) return;
      const body = await readJsonBody<{ server?: unknown; force?: unknown }>(req);
      if (typeof body.server !== "string" || (body.force !== undefined && typeof body.force !== "boolean")) { sendJson(res, 400, { error: "server must be a string and force a boolean" }); return; }
      try { sendJson(res, 202, jobs.start(body.server, body.force === true)); }
      catch { sendJson(res, 400, { error: "This server cannot start hosted authorization; check ownership, enabled state and task limits" }); }
    } },
    { method: "GET", pattern: /^\/oauth\/jobs\/(?<id>[a-f0-9-]+)$/, handler: (req, res, { id }) => {
      if (!requireDesktopOrigin(req, res)) return;
      const job = jobs.get(id!);
      sendJson(res, job ? 200 : 404, job ?? { error: "Unknown authorization task" });
    } },
    { method: "POST", pattern: /^\/oauth\/jobs\/(?<id>[a-f0-9-]+)\/cancel$/, handler: (req, res, { id }) => {
      if (!requireDesktopOrigin(req, res)) return;
      const job = jobs.cancel(id!);
      sendJson(res, job ? 200 : 404, job ?? { error: "Unknown authorization task" });
    } },
  ];
}
