import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCanonicalSource } from "../../src/core/canonical.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "trellis-wsmerge-"));
}

function setup(home: string, ws: string): void {
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  mkdirSync(join(root, "skills", "shared"), { recursive: true });
  mkdirSync(join(root, "skills", "globalonly"), { recursive: true });
  writeFileSync(join(root, "skills", "shared", "SKILL.md"), "---\nname: shared\n---\nglobal version\n");
  writeFileSync(join(root, "skills", "globalonly", "SKILL.md"), "---\nname: globalonly\n---\n");
  writeFileSync(
    join(root, "mcp", "servers.yaml"),
    "servers:\n  figma:\n    transport: http\n    url: https://global-figma.example.com\n  mailbox:\n    transport: http\n    url: https://mailbox.example.com\n",
  );
  mkdirSync(join(ws, ".agents", "skills", "shared"), { recursive: true });
  writeFileSync(join(ws, ".agents", "skills", "shared", "SKILL.md"), "---\nname: shared\n---\nworkspace version\n");
  writeFileSync(
    join(ws, ".agents", "config.json"),
    JSON.stringify({
      version: 1,
      mcp: {
        servers: {
          figma: { transport: "http", url: "https://workspace-figma.example.com" },
          mailbox: { enabled: false },
          proj: { transport: "http", url: "https://proj.example.com" },
        },
      },
    }),
  );
}

test("merge: same-ID server resolves to workspace, with provenance and shadowed list", () => {
  const home = tmp();
  const ws = tmp();
  setup(home, ws);
  const source = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  assert.equal(source.mcp.servers.figma.url, "https://workspace-figma.example.com");
  assert.equal(source.workspace?.mcpProvenance.figma, "workspace");
  assert.ok(source.workspace?.shadowed.includes("mcp:figma"));
});

test("merge: tombstone disables a global server without rendering anything", () => {
  const home = tmp();
  const ws = tmp();
  setup(home, ws);
  const source = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  assert.equal(source.mcp.servers.mailbox, undefined);
  assert.equal(source.workspace?.mcpProvenance.mailbox, undefined);
  assert.ok(source.workspace?.shadowed.includes("mcp:mailbox"));
});

test("merge: tombstone naming no global entry is a no-op diagnostic", () => {
  const home = tmp();
  const ws = tmp();
  setup(home, ws);
  writeFileSync(join(ws, ".agents", "config.json"), JSON.stringify({ mcp: { servers: { ghost: { enabled: false } } } }));
  const source = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  assert.ok(source.diagnostics.some((d) => d.includes('tombstone "ghost"')));
});

test("merge: same-name skill resolves to the workspace copy", () => {
  const home = tmp();
  const ws = tmp();
  setup(home, ws);
  const source = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  const shared = source.skills.find((s) => s.name === "shared");
  assert.equal(shared?.dir, join(ws, ".agents", "skills", "shared"));
  assert.equal(source.workspace?.skillProvenance.shared, "workspace");
  assert.ok(source.workspace?.shadowed.includes("skill:shared"));
  const globalOnly = source.skills.find((s) => s.name === "globalonly");
  assert.equal(source.workspace?.skillProvenance.globalonly, "global");
  assert.ok(globalOnly);
});

test("merge: instructions are not content-merged — workspace file is tracked separately", () => {
  const home = tmp();
  const ws = tmp();
  setup(home, ws);
  writeFileSync(join(ws, ".agents", "AGENTS.md"), "# project\n");
  const source = loadCanonicalSource({ homeDir: home, workspaceDir: ws });
  assert.equal(source.instructionsFile, join(home, ".trellis", "agents.md"));
  assert.equal(source.workspace?.instructionsFile, join(ws, ".agents", "AGENTS.md"));
});
