import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { findWorkspaceRoot, loadWorkspaceLayer } from "../../src/lib/workspace.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "trellis-workspace-"));
}

function makeGlobal(home: string): void {
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(join(root, "mcp", "servers.yaml"), "servers:\n  mailbox:\n    transport: http\n    url: https://global.example.com/mcp\n");
}

// --- findWorkspaceRoot (task 1.1) ---

test("findWorkspaceRoot: nearest ancestor with .agents wins", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".agents"));
  mkdirSync(join(repo, "src", ".agents"), { recursive: true });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  assert.equal(findWorkspaceRoot(join(repo, "src", "deep")), join(repo, "src"));
});

test("findWorkspaceRoot: no .agents anywhere yields null", () => {
  const dir = tmp();
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  assert.equal(findWorkspaceRoot(join(dir, "a", "b")), null);
});

test("findWorkspaceRoot: a non-git directory works", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".agents"));
  assert.equal(findWorkspaceRoot(dir), dir);
});

test("findWorkspaceRoot: a file named .agents is not a workspace marker", () => {
  const dir = tmp();
  writeFileSync(join(dir, ".agents"), "not a directory");
  assert.equal(findWorkspaceRoot(dir), null);
});

// --- loadWorkspaceLayer (task 1.2) ---

const EMPTY_POLICY = { allowedVars: [], rejectPatterns: [] };

test("loadWorkspaceLayer: minimal valid project layer", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(join(ws, ".agents", "config.json"), JSON.stringify({ version: 1, mcp: { servers: {} } }));
  const layer = loadWorkspaceLayer(ws, EMPTY_POLICY);
  assert.deepEqual(layer.servers, {});
  assert.deepEqual(layer.tombstones, []);
  assert.deepEqual(layer.skills, []);
  assert.equal(layer.instructionsFile, undefined);
  assert.deepEqual(layer.diagnostics, []);
});

test("loadWorkspaceLayer: every file is optional", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  const layer = loadWorkspaceLayer(ws, EMPTY_POLICY);
  assert.deepEqual(layer.servers, {});
  assert.equal(layer.instructionsFile, undefined);
});

test("loadWorkspaceLayer: newer schema version refuses with upgrade guidance", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(join(ws, ".agents", "config.json"), JSON.stringify({ version: 99 }));
  assert.throws(() => loadWorkspaceLayer(ws, EMPTY_POLICY), /upgrade Trellis/);
});

test("loadWorkspaceLayer: absent version means 1; unknown top-level keys warn", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(join(ws, ".agents", "config.json"), JSON.stringify({ mcp: { servers: {} }, future: true }));
  const layer = loadWorkspaceLayer(ws, EMPTY_POLICY);
  assert.ok(layer.diagnostics.some((d) => d.includes('"future"')));
});

test("loadWorkspaceLayer: invalid server entry gets the same diagnostic as servers.yaml", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(
    join(ws, ".agents", "config.json"),
    JSON.stringify({ mcp: { servers: { figma: { transport: "http", url: "https://x", auth: { kind: "oauth", bogus: 1 } } } } }),
  );
  assert.throws(() => loadWorkspaceLayer(ws, EMPTY_POLICY), /unrecognized key "bogus"/);
});

test("loadWorkspaceLayer: servers.yaml field set translates identically (static_env, env_aliases, auth)", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(
    join(ws, ".agents", "config.json"),
    JSON.stringify({
      mcp: {
        servers: {
          figma: {
            transport: "http",
            url: "https://mcp.figma.com/mcp",
            static_env: { REGION: "us" },
            env_aliases: { TOKEN: "FIGMA_TOKEN" },
            auth: { kind: "oauth", client_name: "Claude Code" },
          },
        },
      },
    }),
  );
  const layer = loadWorkspaceLayer(ws, EMPTY_POLICY);
  const figma = layer.servers.figma;
  assert.equal(figma.transport, "http");
  assert.deepEqual(figma.staticEnv, { REGION: "us" });
  assert.deepEqual(figma.envAliases, { TOKEN: "FIGMA_TOKEN" });
  assert.deepEqual(figma.auth, { kind: "oauth", clientName: "Claude Code" });
});

test("loadWorkspaceLayer: enabled:false entries are tombstones, with or without transport", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(
    join(ws, ".agents", "config.json"),
    JSON.stringify({
      mcp: {
        servers: {
          figma: { enabled: false },
          off: { enabled: false, transport: "http", url: "https://x" },
        },
      },
    }),
  );
  const layer = loadWorkspaceLayer(ws, EMPTY_POLICY);
  assert.deepEqual(layer.servers, {});
  assert.deepEqual(layer.tombstones.sort(), ["figma", "off"]);
});

test("loadWorkspaceLayer: skills and AGENTS.md are picked up", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(ws, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\n---\n");
  writeFileSync(join(ws, ".agents", "AGENTS.md"), "# Project rules\n");
  const layer = loadWorkspaceLayer(ws, EMPTY_POLICY);
  assert.equal(layer.skills.length, 1);
  assert.equal(layer.skills[0].name, "review");
  assert.equal(layer.instructionsFile, join(ws, ".agents", "AGENTS.md"));
});

// --- secrets boundary (task 1.5) ---

const REJECT_POLICY = { allowedVars: [], rejectPatterns: [/ghp_[A-Za-z0-9]+/] };

test("loadWorkspaceLayer: ${VAR} references pass the secrets boundary", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(
    join(ws, ".agents", "config.json"),
    JSON.stringify({
      mcp: { servers: { gh: { transport: "http", url: "https://x", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } } },
    }),
  );
  assert.doesNotThrow(() => loadWorkspaceLayer(ws, REJECT_POLICY));
});

test("loadWorkspaceLayer: a plaintext credential is refused, naming server and field but not the value", () => {
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(
    join(ws, ".agents", "config.json"),
    JSON.stringify({
      mcp: { servers: { gh: { transport: "http", url: "https://x", static_env: { TOKEN: "ghp_secretvalue123" } } } },
    }),
  );
  let err: Error | null = null;
  try {
    loadWorkspaceLayer(ws, REJECT_POLICY);
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err, "expected the load to be refused");
  assert.match(err.message, /"gh" static_env\.TOKEN/);
  assert.doesNotMatch(err.message, /ghp_secretvalue123/);
});

// --- loadCanonicalSource integration (task 1.3) ---

test("loadCanonicalSource: default call from inside a .agents directory stays global-only", () => {
  const home = tmp();
  makeGlobal(home);
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(join(ws, ".agents", "config.json"), JSON.stringify({ mcp: { servers: { ws: { transport: "http", url: "https://ws" } } } }));
  const cwd = process.cwd();
  process.chdir(ws);
  try {
    const source = loadCanonicalSource(home);
    assert.equal(source.mcp.servers.ws, undefined);
    assert.equal(source.workspace, undefined);
  } finally {
    process.chdir(cwd);
  }
});

test("loadCanonicalSource: explicit workspaceDir loads and merges the project layer", () => {
  const home = tmp();
  makeGlobal(home);
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  writeFileSync(join(ws, ".agents", "config.json"), JSON.stringify({ mcp: { servers: { ws: { transport: "http", url: "https://ws" } } } }));
  const source = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  assert.equal(source.mcp.servers.ws?.url, "https://ws");
  assert.equal(source.mcp.servers.mailbox?.url, "https://global.example.com/mcp");
  assert.equal(source.workspace?.root, ws);
  assert.equal(source.workspace?.mcpProvenance.ws, "workspace");
  assert.equal(source.workspace?.mcpProvenance.mailbox, "global");
});

test("loadCanonicalSource: workspaceDir never relocates secrets ~ expansion", () => {
  const home = tmp();
  makeGlobal(home);
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "env_file: ~/my.env\n");
  const ws = tmp();
  mkdirSync(join(ws, ".agents"));
  const source = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  assert.equal(source.secretsPolicy.envFile, join(home, "my.env"));
});
