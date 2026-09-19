import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInitReport } from "../../src/commands/init.js";
import { applyMcpImportPlan, collectMcpImportPlan } from "../../src/commands/mcpImport.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "trellis-mcp-import-"));
}

function sourceFile(homeDir: string, value: unknown): string {
  const path = join(homeDir, "export.json");
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

test("mcp import: extracts literal credential env values and preserves target env keys", async () => {
  const value = home();
  await collectInitReport(value);
  const file = sourceFile(value, {
    mcpServers: {
      supabase_db: {
        command: "npx",
        args: ["-y", "@supabase/mcp-server-supabase"],
        env: { SUPABASE_ACCESS_TOKEN: "supabase-test-token" },
      },
    },
  });

  const plan = applyMcpImportPlan(file, value);
  assert.deepEqual(plan.items, [{
    name: "supabase_db",
    action: "create",
    detail: "will add to canonical and extract 1 credential value(s) to the ignored local secrets file",
  }]);
  const canonical = loadCanonicalSource(value);
  assert.deepEqual(canonical.mcp.servers.supabase_db?.envAliases, {
    SUPABASE_ACCESS_TOKEN: "TRELLIS_SUPABASE_DB_SUPABASE_ACCESS_TOKEN",
  });
  assert.match(readFileSync(join(value, ".trellis", "mcp", "servers.local.env"), "utf8"), /TRELLIS_SUPABASE_DB_SUPABASE_ACCESS_TOKEN=supabase-test-token/);
  assert.doesNotMatch(readFileSync(join(value, ".trellis", "mcp", "servers.yaml"), "utf8"), /supabase-test-token/);
  assert.equal(existsSync(join(value, ".trellis", ".gitignore")), true);
});

test("mcp import: de-duplicates same semantic server under a different source name", async () => {
  const value = home();
  await collectInitReport(value);
  const file = sourceFile(value, {
    mcpServers: {
      first: { command: "npx", args: ["-y", "same-server"] },
      second: { command: "npx", args: ["same-server"] },
    },
  });
  const plan = collectMcpImportPlan(file, value);
  assert.deepEqual(plan.items, [
    { name: "first", action: "create", detail: "will add to canonical and extract 0 credential value(s) to the ignored local secrets file" },
    { name: "second", action: "duplicate", detail: 'same non-secret MCP definition is already represented by "first" — not added' },
  ]);
});

test("mcp import: repeated import is already-present and never duplicates local secrets", async () => {
  const value = home();
  await collectInitReport(value);
  const file = sourceFile(value, {
    mcpServers: {
      gitlab: { command: "npx", args: ["-y", "gitlab"], env: { GITLAB_PERSONAL_ACCESS_TOKEN: "gitlab-test-token" } },
    },
  });
  applyMcpImportPlan(file, value);
  const second = collectMcpImportPlan(file, value);
  assert.deepEqual(second.items, [{
    name: "gitlab",
    action: "already-present",
    detail: "canonical entry is already semantically identical; existing credentials are preserved",
  }]);
  const secrets = readFileSync(join(value, ".trellis", "mcp", "servers.local.env"), "utf8");
  assert.equal((secrets.match(/TRELLIS_GITLAB_GITLAB_PERSONAL_ACCESS_TOKEN=/g) ?? []).length, 1);
});

test("mcp import: converts mcp-remote Basic auth to native HTTP and extracts the credential", async () => {
  const value = home();
  await collectInitReport(value);
  const file = sourceFile(value, {
    mcpServers: {
      langfuse: { command: "npx", args: ["-y", "mcp-remote", "https://example", "--header", "Authorization: Basic c2Vuc2l0aXZl"] },
    },
  });
  applyMcpImportPlan(file, value);
  const def = loadCanonicalSource(value).mcp.servers.langfuse;
  assert.deepEqual(def?.headers, { Authorization: "Basic ${TRELLIS_LANGFUSE_AUTHORIZATION}" });
  assert.match(readFileSync(join(value, ".trellis", "mcp", "servers.local.env"), "utf8"), /TRELLIS_LANGFUSE_AUTHORIZATION=c2Vuc2l0aXZl/);
  assert.doesNotMatch(readFileSync(join(value, ".trellis", "mcp", "servers.yaml"), "utf8"), /c2Vuc2l0aXZl/);
});

test("mcp import: refuses unsupported inline args credentials without leaking the value", async () => {
  const value = home();
  await collectInitReport(value);
  const file = sourceFile(value, {
    mcpServers: {
      unsafe: { command: "node", args: ["server.js", "--token", "sk-sensitive-value"] },
    },
  });
  const plan = collectMcpImportPlan(file, value);
  assert.equal(plan.items[0]?.action, "conflict");
  assert.match(plan.items[0]?.detail ?? "", /embedded in command, args, or url/);
  assert.doesNotMatch(JSON.stringify(plan), /sk-sensitive-value/);
  assert.equal(loadCanonicalSource(value).mcp.servers.unsafe, undefined);
});

test("mcp import: skips a missing absolute path without blocking other entries", async () => {
  const value = home();
  await collectInitReport(value);
  const file = sourceFile(value, {
    mcpServers: {
      obsolete: { command: "node", args: ["/Users/admin/obsolete/mcp.mjs"] },
      usable: { command: "node", args: ["server.js"] },
    },
  });
  const plan = collectMcpImportPlan(file, value);
  assert.equal(plan.items[0]?.action, "skipped");
  assert.equal(plan.items[1]?.action, "create");
});

test("mcp import: dry-run planning does not write canonical or local secrets", async () => {
  const value = home();
  await collectInitReport(value);
  const file = sourceFile(value, {
    mcpServers: { zeabur: { command: "npx", args: ["@zeabur/mcp-server"], env: { ZEABUR_TOKEN: "zeabur-test-token" } } },
  });
  const plan = collectMcpImportPlan(file, value);
  assert.equal(plan.items[0]?.action, "create");
  assert.equal(existsSync(join(value, ".trellis", "mcp", "servers.local.env")), false);
  assert.doesNotMatch(JSON.stringify(plan), /zeabur-test-token/);
});

test("mcp import: write failures are surfaced and leave a rollback manifest", async () => {
  const value = home();
  mkdirSync(join(value, ".trellis"), { recursive: true });
  mkdirSync(join(value, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(value, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  const file = sourceFile(value, { mcpServers: { broken: { command: "node", args: ["server.js"], env: { API_TOKEN: "token-value" } } } });
  assert.throws(() => applyMcpImportPlan(file, value), /secrets.policy.yaml does not exist/);
  assert.equal(existsSync(join(value, ".trellis", "backups")), true);
});
