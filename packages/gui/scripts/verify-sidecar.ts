/** Exercise the compiled executable, including the production browser opener.
 * All credentials and endpoints belong to a local, disposable OAuth fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAuthServer } from "../../../test/fixtures/fakeAuthServer.js";

const guiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const binary = process.argv[2] ?? join(guiRoot, "src-tauri", "binaries", `trellis-gui-sidecar-${triple}`);
const lab = mkdtempSync(join(tmpdir(), "trellis-sidecar-verify-"));
const root = join(lab, ".trellis");
mkdirSync(join(root, "mcp"), { recursive: true });
mkdirSync(join(lab, "bin"));
const as = await startFakeAuthServer({ requireResource: true, issuerResponse: "valid" });
writeFileSync(join(root, "managed.yaml"), "agents: []\n");
writeFileSync(join(root, "mcp", "servers.yaml"), `servers:\n  hosted:\n    transport: http\n    url: ${as.resourceUrl}\n    auth:\n      kind: oauth\n      owner: trellis\n  native:\n    transport: http\n    url: ${as.resourceUrl}\n    auth: oauth\n`);
const authFile = join(lab, "authorization-url");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(join(lab, "bin", "open"), `#!/bin/sh\nprintf '%s' "$1" > ${quote(authFile)}\n`, { mode: 0o755 });
const shell = join(lab, "shell");
const taskPath = `${join(lab, "bin") }:/usr/bin:/bin`;
writeFileSync(shell, `#!/bin/sh\nprintf '%s' ${quote(`__TRELLIS_PATH__${taskPath}__TRELLIS_PATH__`)}\n`, { mode: 0o755 });
const child = spawn(binary, [], { env: { ...process.env, HOME: lab, SHELL: shell, PATH: taskPath }, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
const waitFor = async (check: () => boolean, timeoutMs = 15000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child.exitCode !== null) throw new Error(`packaged sidecar exited: ${stderr}`);
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("packaged sidecar did not reach the expected state");
};
try {
  await waitFor(() => /TRELLIS_SIDECAR_PORT=\d+/.test(stdout));
  const port = Number(/TRELLIS_SIDECAR_PORT=(\d+)/.exec(stdout)![1]);
  const request = (path: string, body?: unknown, origin = "tauri://localhost") => fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const listed = await (await request("/mcp/list")).json();
  assert.equal(listed.find((entry: { name: string }) => entry.name === "native").authStatus, "unknown");
  assert.equal((await request("/oauth/start", { server: "native" })).status, 400);
  assert.equal((await request("/oauth/start", { server: "hosted" }, "https://untrusted.example")).status, 403);
  const response = await request("/oauth/start", { server: "hosted" });
  assert.equal(response.status, 202);
  const job = await response.json();
  // This reaches the real default opener inside pkg's bytecode, unlike the
  // injected-browser source tests. The harmless PATH shim captures its URL.
  await waitFor(() => existsSync(authFile));
  await as.authorizeViaBrowser(readFileSync(authFile, "utf8"));
  let state;
  for (let count = 0; count < 100; count++) {
    state = await (await request(`/oauth/jobs/${job.id}`)).json();
    if (state.status === "succeeded") break;
    assert.notEqual(state.status, "failed", "the compiled OAuth job must succeed");
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.equal(state.status, "succeeded");
  assert.equal(as.grants.length, 1);
  assert.equal(statSync(join(root, "mcp", "oauth", "hosted.json")).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(state), /accessToken|refreshToken|clientSecret|authorizationUrl/);
  const refreshed = await (await request("/mcp/list")).json();
  assert.equal(refreshed.find((entry: { name: string }) => entry.name === "hosted").authStatus, "authorized");
  console.log("Packaged sidecar verified: startup, ownership, origin guard, default opener, PKCE/resource/issuer grant and status refresh.");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
  await as.close();
  rmSync(lab, { recursive: true, force: true });
}
