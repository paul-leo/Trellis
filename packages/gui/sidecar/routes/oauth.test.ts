import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OAuthJobs, type OAuthJob } from "../oauthJobs.js";
import { createOAuthRoutes } from "./oauth.js";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "../server.js";
import { startFakeAuthServer } from "../../../../test/fixtures/fakeAuthServer.js";
import { readToken, writeToken } from "../../../../src/lib/oauth/store.js";
import { createPlanApplyRoutes } from "./planApply.js";
import { PlanStore } from "../planStore.js";

function home(url: string, owner = "trellis"): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-gui-oauth-"));
  mkdirSync(join(dir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(dir, ".trellis", "mcp", "servers.yaml"), `servers:\n  remote:\n    transport: http\n    url: ${url}\n    auth:\n      kind: oauth\n      owner: ${owner}\n`);
  return dir;
}

async function start(jobs: OAuthJobs) {
  const server = createSidecarServer(createOAuthRoutes(jobs));
  const port = await listenOnEphemeralLoopbackPort(server);
  return { request: (path: string, body?: unknown, origin = "tauri://localhost") => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), close: async () => { jobs.close(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function until(jobs: OAuthJobs, id: string, expected: string): Promise<OAuthJob> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = jobs.get(id)!;
    if (job.status === expected) return job;
    if (["failed", "timed-out", "cancelled"].includes(job.status) && job.status !== expected) throw new Error(`unexpected job state: ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job did not reach ${expected}`);
}

test("OAuth routes run a real hosted grant and expose only sanitized status", async () => {
  const as = await startFakeAuthServer();
  const dir = home(as.resourceUrl);
  const jobs = new OAuthJobs(dir, { openBrowser: (url) => as.authorizeViaBrowser(url) });
  const app = await start(jobs);
  try {
    const response = await app.request("/oauth/start", { server: "remote" });
    assert.equal(response.status, 202);
    const job = await response.json() as OAuthJob;
    await until(jobs, job.id, "succeeded");
    const status = await (await app.request(`/oauth/jobs/${job.id}`)).json();
    assert.equal(status.status, "succeeded");
    assert.doesNotMatch(JSON.stringify(status), /accessToken|refreshToken|clientSecret|tokenFile|authorizationUrl/);
    assert.equal(JSON.stringify(status).includes(readToken(dir, "remote")!.accessToken), false);
    assert.equal(as.grants.length, 1);
  } finally { await app.close(); await as.close(); }
});

test("untrusted origins and native ownership are refused before any browser launch", async () => {
  let opened = 0;
  const jobs = new OAuthJobs(home("https://example.test/mcp", "agent"), { openBrowser: () => { opened++; } });
  const app = await start(jobs);
  try {
    assert.equal((await app.request("/oauth/start", { server: "remote" }, "https://unrelated.example")).status, 403);
    assert.equal((await app.request("/oauth/start", { server: "remote" })).status, 400);
    assert.equal((await app.request("/oauth/start", { server: 42 })).status, 400);
    assert.equal((await app.request("/oauth/jobs/123", undefined, "https://unrelated.example")).status, 403);
    assert.equal(opened, 0);
  } finally { await app.close(); }
});

test("duplicate authorization starts reuse a job; cancelling preserves the prior token", async () => {
  const as = await startFakeAuthServer();
  const dir = home(as.resourceUrl);
  const prior = { accessToken: "prior-token", expiresAt: Date.now() + 3600000 };
  writeToken(dir, "remote", prior);
  let opened = 0;
  const jobs = new OAuthJobs(dir, { openBrowser: () => { opened++; } });
  const app = await start(jobs);
  try {
    const job = await (await app.request("/oauth/start", { server: "remote", force: true })).json() as OAuthJob;
    await until(jobs, job.id, "waiting");
    const duplicate = await (await app.request("/oauth/start", { server: "remote", force: true })).json() as OAuthJob;
    assert.equal(duplicate.id, job.id);
    assert.equal(opened, 1);
    const cancelled = await (await app.request(`/oauth/jobs/${job.id}/cancel`, {})).json() as OAuthJob;
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(readToken(dir, "remote"), prior);
    assert.equal(as.grants.length, 0);
  } finally { await app.close(); await as.close(); }
});

test("authorization task deadlines and provider failures produce retryable terminal state", async () => {
  const as = await startFakeAuthServer({ rejectRegistration: true });
  const dir = home(as.resourceUrl);
  const jobs = new OAuthJobs(dir, { openBrowser: () => { throw new Error("must not launch after refused registration"); } });
  try {
    const first = jobs.start("remote");
    const failed = await until(jobs, first.id, "failed");
    assert.equal(failed.error, "authorization-failed");
    const retry = jobs.start("remote");
    assert.notEqual(first.id, retry.id);
    assert.equal(jobs.get(first.id)?.status, "failed", "completed tasks remain readable while a retry starts");
    await until(jobs, retry.id, "failed");
    assert.equal(readToken(dir, "remote"), undefined);
    const timed = new OAuthJobs(dir, { timeoutMs: 20, run: async ({ signal }) => new Promise((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); }) });
    try { const job = timed.start("remote"); await until(timed, job.id, "timed-out"); }
    finally { timed.close(); }
  } finally { jobs.close(); await as.close(); }
});

test("ownership plan and apply also reject untrusted origins before any mutation", async () => {
  const dir = home("https://example.test/mcp", "agent");
  const server = createSidecarServer(createPlanApplyRoutes(dir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    for (const operation of ["plan", "apply"]) {
      const response = await fetch(`http://127.0.0.1:${port}/${operation}/mcp-auth-owner`, { method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" }, body: JSON.stringify({ name: "remote", owner: "trellis" }) });
      assert.equal(response.status, 403);
    }
    const response = await fetch(`http://127.0.0.1:${port}/plan/mcp-auth-owner`, { method: "POST", headers: { origin: "tauri://localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "remote", owner: "trellis" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).plan.action, "updated");
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
