import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "../server.js";
import { createReadRoutes } from "./read.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

function home(): string { return mkdtempSync(join(tmpdir(), "trellis-gui-read-")); }

function cli(homeDir: string, args: string[]): string {
  return execFileSync("npx", ["tsx", "src/cli.ts", ...args], { cwd: repoRoot, env: { ...process.env, HOME: homeDir }, encoding: "utf-8" });
}

function get(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (err) { reject(err); } });
    });
    req.on("error", reject);
    req.end();
  });
}

test("read routes: doctor/mcp-list/skill-list/memory-list/secrets-audit byte-for-byte match the real CLI's own --json output", async () => {
  const homeDir = home();
  cli(homeDir, ["init"]);

  const cliDoctor = JSON.parse(cli(homeDir, ["doctor", "--json"]));
  const cliMcpList = JSON.parse(cli(homeDir, ["mcp", "list", "--json"]));
  const cliSkillList = JSON.parse(cli(homeDir, ["skill", "list", "--json"]));
  const cliMemoryList = JSON.parse(cli(homeDir, ["memory", "list", "--json"]));
  const cliSecretsAudit = JSON.parse(cli(homeDir, ["secrets", "audit", "--json"]));

  cli(homeDir, ["manage", "add", "pi"]); // real, unconditionally backup-tracked write — gives /backups/list something real to list
  const cliBackupsList = JSON.parse(cli(homeDir, ["rollback", "--list", "--json"]));

  const server = createSidecarServer(createReadRoutes(homeDir));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    assert.deepEqual(await get(port, "/doctor"), cliDoctor, "GET /doctor must match `trellis doctor --json` exactly");
    assert.deepEqual(await get(port, "/mcp/list"), cliMcpList, "GET /mcp/list must match `trellis mcp list --json` exactly");
    assert.deepEqual(await get(port, "/skill/list"), cliSkillList, "GET /skill/list must match `trellis skill list --json` exactly");
    assert.deepEqual(await get(port, "/memory/list"), cliMemoryList, "GET /memory/list must match `trellis memory list --json` exactly");
    assert.deepEqual(await get(port, "/secrets/audit"), cliSecretsAudit, "GET /secrets/audit must match `trellis secrets audit --json` exactly");
    assert.deepEqual(await get(port, "/backups/list"), cliBackupsList, "GET /backups/list must match `trellis rollback --list --json` exactly");
  } finally {
    server.close();
  }
});

test("read routes: secrets-audit response never carries a resolved secret value, only names and findings", async () => {
  const homeDir = home();
  cli(homeDir, ["init"]);

  const server = createSidecarServer(createReadRoutes(homeDir));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const body = (await get(port, "/secrets/audit")) as { findings: Array<{ agent: string; file: string; kind: string; detail: string }> };
    assert.ok(Array.isArray(body.findings));
    for (const finding of body.findings) {
      assert.deepEqual(Object.keys(finding).sort(), ["agent", "detail", "file", "kind"], "a finding must only ever carry these four fields — no room for a fifth, value-bearing field to sneak in");
    }
  } finally {
    server.close();
  }
});

test("read routes: /managed lists exactly the managed agents — the only choices a scope editor may offer", async () => {
  const homeDir = home();
  cli(homeDir, ["init"]);
  cli(homeDir, ["manage", "add", "pi"]);
  cli(homeDir, ["manage", "add", "codex"]);

  const server = createSidecarServer(createReadRoutes(homeDir));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { managedAgents } = (await get(port, "/managed")) as { managedAgents: string[] };
    assert.deepEqual([...managedAgents].sort(), ["codex", "pi"]);
  } finally {
    server.close();
  }
});

test("read routes: /mcp/list carries the credential state exactly as the CLI does, and never a token", async () => {
  const homeDir = home();
  cli(homeDir, ["init"]);
  writeFileSync(
    join(homeDir, ".trellis", "mcp", "servers.yaml"),
    'servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n    auth: oauth\n  other:\n    transport: http\n    url: https://other.example/mcp\n    auth: oauth\n',
  );
  mkdirSync(join(homeDir, ".trellis", "mcp", "oauth"), { recursive: true });
  writeFileSync(
    join(homeDir, ".trellis", "mcp", "oauth", "figma.json"),
    JSON.stringify({ accessToken: "AT-NEVER-SHOWN", refreshToken: "RT-NEVER-SHOWN", expiresAt: Date.now() + 3_600_000 }),
  );

  const cliMcpList = JSON.parse(cli(homeDir, ["mcp", "list", "--json"])) as Array<{ name: string; authStatus?: string }>;
  const server = createSidecarServer(createReadRoutes(homeDir));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const viaSidecar = (await get(port, "/mcp/list")) as Array<{ name: string; authStatus?: string }>;
    assert.deepEqual(viaSidecar, cliMcpList, "the GUI must show what the CLI reports, not a second opinion");
    assert.equal(viaSidecar.find((e) => e.name === "figma")?.authStatus, "authorized");
    assert.equal(viaSidecar.find((e) => e.name === "other")?.authStatus, "not-authorized");
    assert.equal(JSON.stringify(viaSidecar).includes("NEVER-SHOWN"), false);
  } finally {
    server.close();
  }
});
