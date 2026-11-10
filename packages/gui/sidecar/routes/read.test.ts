import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  // Isolate cwd as well as HOME, so ancestor .agents/ on the developer's
  // machine cannot leak into the CLI's workspace discovery.
  return execFileSync(process.execPath, [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), join(repoRoot, "src/cli.ts"), ...args], { cwd: homeDir, env: { ...process.env, HOME: homeDir }, encoding: "utf-8" });
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
    'servers:\n  figma:\n    transport: http\n    url: https://mcp.figma.com/mcp\n    auth:\n      kind: oauth\n      owner: trellis\n  other:\n    transport: http\n    url: https://other.example/mcp\n    auth:\n      kind: oauth\n      owner: trellis\n',
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

test("read routes: /evolve/report matches `trellis evolve report --json` exactly and stays read-only", async () => {
  const homeDir = home();
  // 种子进化状态(直接落盘存储形态;不依赖进化启用):一条 pending + 一条 proposal 档案。
  const evolveDir = join(homeDir, ".trellis", "evolve");
  mkdirSync(join(evolveDir, "pending"), { recursive: true });
  writeFileSync(
    join(evolveDir, "pending", "rule-sidecar.json"),
    JSON.stringify({
      id: "rule-sidecar",
      status: "pending",
      riskClass: "B",
      riskRuleId: "workspace-config-fix/any",
      proposal: {
        id: "rule-sidecar",
        createdAt: 1_700_000_000_000,
        kind: "workspace-config-fix",
        target: "/tmp/ws/.codex/config.toml",
        layer: { kind: "workspace", root: "/tmp/ws" },
        evidence: [{ kind: "doctor-finding", findingId: "doctor:workspace-toml-invalid:sidecar" }],
        riskClass: "B",
        summary: "fix toml",
        edits: [{ op: "write-file", path: "/tmp/ws/.codex/config.toml", content: "# bad = [\n" }],
      },
      createdAt: 1_700_000_000_000,
      decidedAt: null,
    }) + "\n",
  );
  mkdirSync(join(evolveDir, "archive"), { recursive: true });
  writeFileSync(
    join(evolveDir, "archive", "records.jsonl"),
    JSON.stringify({ kind: "proposal", recordedAt: "2026-10-27T00:00:00.000Z", payload: { proposalId: "rule-sidecar", riskClass: "B", riskRuleId: "workspace-config-fix/any" } }) + "\n",
  );

  const cliReport = JSON.parse(cli(homeDir, ["evolve", "report", "--json"]));
  const server = createSidecarServer(createReadRoutes(homeDir));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    assert.deepEqual(await get(port, "/evolve/report"), cliReport, "GET /evolve/report must match `trellis evolve report --json` exactly");
    // 只读消费:查看前后 pending/档案文件逐字节不变。
    const before = readFileSync(join(evolveDir, "archive", "records.jsonl"), "utf-8");
    await get(port, "/evolve/report");
    assert.equal(readFileSync(join(evolveDir, "archive", "records.jsonl"), "utf-8"), before);
  } finally {
    server.close();
  }
});
