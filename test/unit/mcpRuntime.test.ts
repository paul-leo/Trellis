import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BuiltinRegistry } from "../../src/lib/mcpRuntime.js";
import { RuntimeMemoryProvider } from "../../src/lib/memoryProvider.js";
import { SkillProvider } from "../../src/lib/skillProvider.js";

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-runtime-"));
  const root = join(home, ".trellis");
  mkdirSync(join(root, "skills", "shared"), { recursive: true });
  mkdirSync(join(root, "skills", "claude-only", "references"), { recursive: true });
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(join(root, "agents.md"), "# instructions\n");
  writeFileSync(join(root, "managed.yaml"), "agents: [claude-code, codex]\n");
  writeFileSync(join(root, "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(root, "mcp", "servers.yaml"), "servers: {}\n");
  writeFileSync(join(root, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: shared workflow\n---\n\n# Shared\n");
  writeFileSync(join(root, "skills", "shared", "reference.md"), "reference content\n");
  writeFileSync(join(root, "skills", "claude-only", "SKILL.md"), "---\nname: claude-only\ndescription: private workflow\n---\n\n# Private\n");
  writeFileSync(join(root, "skills", "claude-only", "references", "guide.md"), "private reference\n");
  return home;
}

const context = (homeDir: string, agentId: "claude-code" | "codex") => ({ homeDir, agentId });

test("SkillProvider: lists progressive-disclosure tools and scoped resources", () => {
  const provider = new SkillProvider();
  assert.deepEqual(provider.listTools().map((tool) => tool.name), [
    "trellis.skills.search",
    "trellis.skills.read",
    "trellis.skills.read_file",
  ]);
  const resources = provider.listResources(context(fixtureHome(), "claude-code"));
  assert.equal(resources.length, 2);
  assert.ok(resources.some((resource) => resource.uri.includes("shared")));
});

test("SkillProvider: search and read respect agent scope", async () => {
  const home = fixtureHome();
  const root = join(home, ".trellis");
  writeFileSync(join(root, "scope.yaml"), "skills:\n  claude-only: [claude-code]\n");
  const provider = new SkillProvider();

  const codexSearch = await provider.callTool("trellis.skills.search", { query: "" }, context(home, "codex"));
  assert.match(String(codexSearch.content[0].text), /shared/);
  assert.doesNotMatch(String(codexSearch.content[0].text), /claude-only/);

  const denied = await provider.callTool("trellis.skills.read", { name: "claude-only" }, context(home, "codex"));
  assert.equal(denied.isError, true);

  const allowed = await provider.callTool("trellis.skills.read", { name: "claude-only" }, context(home, "claude-code"));
  assert.equal(allowed.isError, undefined);
  assert.match(String(allowed.content[0].text), /private workflow/);
  assert.match(String(allowed.content[0].text), /"scope": "in-scope"/);
});

test("SkillProvider: resources read the same bounded skill content", () => {
  const home = fixtureHome();
  const provider = new SkillProvider();
  const uri = new URL("trellis://skills/shared/SKILL.md");
  const result = provider.readResource(uri, context(home, "codex"));
  assert.match(result.contents[0].text ?? "", /# Shared/);
});

test("SkillProvider: rejects traversal, secret-like files, and symlink escapes", async () => {
  const home = fixtureHome();
  const root = join(home, ".trellis");
  writeFileSync(join(root, "outside.txt"), "outside\n");
  symlinkSync(join(root, "outside.txt"), join(root, "skills", "shared", "escape.txt"));
  writeFileSync(join(root, "skills", "shared", ".env"), "TOKEN=secret\n");
  const provider = new SkillProvider();
  const traversal = await provider.callTool("trellis.skills.read_file", { name: "shared", relativePath: "../../outside.txt" }, context(home, "codex"));
  assert.equal(traversal.isError, true);
  const secret = await provider.callTool("trellis.skills.read_file", { name: "shared", relativePath: ".env" }, context(home, "codex"));
  assert.equal(secret.isError, true);
  const escape = await provider.callTool("trellis.skills.read_file", { name: "shared", relativePath: "escape.txt" }, context(home, "codex"));
  assert.equal(escape.isError, true);
});

test("RuntimeMemoryProvider: exposes read-only scoped search, read, and resources", async () => {
  const home = fixtureHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "memories"), { recursive: true });
  writeFileSync(join(root, "memories", "shared-note.md"), "# Shared note\nremember the runtime\n");
  writeFileSync(join(root, "memories", "claude-note.md"), "# Claude note\nprivate\n");
  writeFileSync(join(root, "scope.yaml"), "memories:\n  claude-note: [claude-code]\n");
  const provider = new RuntimeMemoryProvider();

  assert.deepEqual(provider.listTools().map((tool) => tool.name), ["trellis.memory.search", "trellis.memory.read"]);
  const codexSearch = await provider.callTool("trellis.memory.search", { query: "runtime" }, context(home, "codex"));
  assert.match(String(codexSearch.content[0].text), /shared-note/);
  assert.doesNotMatch(String(codexSearch.content[0].text), /remember the runtime/);
  assert.doesNotMatch(String(codexSearch.content[0].text), /claude-note/);

  const denied = await provider.callTool("trellis.memory.read", { name: "claude-note" }, context(home, "codex"));
  assert.equal(denied.isError, true);
  const allowed = await provider.callTool("trellis.memory.read", { name: "claude-note" }, context(home, "claude-code"));
  assert.match(String(allowed.content[0].text), /private/);
  assert.match(String(allowed.content[0].text), /fingerprint/);

  const resources = await provider.listResources(context(home, "codex"));
  assert.deepEqual(resources.map((resource) => resource.uri), ["trellis://memories/shared-note.md"]);
  const resource = await provider.readResource(new URL("trellis://memories/shared-note.md"), context(home, "codex"));
  assert.match(resource.contents[0].text ?? "", /remember the runtime/);
});

test("RuntimeMemoryProvider: a read-only custom provider can stand in for a future memory backend", async () => {
  const home = fixtureHome();
  const source = {
    id: "test-double",
    list: () => [{ name: "remote-note" }],
    read: (name: string) => name === "remote-note" ? { content: "provided by a test double\n" } : undefined,
  };
  const provider = new RuntimeMemoryProvider(source);
  const result = await provider.callTool("trellis.memory.read", { name: "remote-note" }, context(home, "codex"));
  assert.match(String(result.content[0].text), /provided by a test double/);
  assert.match(String(result.content[0].text), /"source": "test-double"/);
  const canonicalBefore = readFileSync(join(home, ".trellis", "agents.md"), "utf8");
  assert.equal((await provider.callTool("trellis.memory.remember", { name: "x" }, context(home, "codex"))).isError, true);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf8"), canonicalBefore);
});

test("RuntimeMemoryProvider: canonical reads reject symlink escapes", async () => {
  const home = fixtureHome();
  const root = join(home, ".trellis");
  mkdirSync(join(root, "memories"), { recursive: true });
  writeFileSync(join(root, "outside-memory.md"), "must stay outside\n");
  symlinkSync(join(root, "outside-memory.md"), join(root, "memories", "escape.md"));
  const provider = new RuntimeMemoryProvider();

  const result = await provider.callTool("trellis.memory.read", { name: "escape" }, context(home, "codex"));
  assert.equal(result.isError, true);
  assert.doesNotMatch(String(result.content[0].text), /must stay outside/);
  await assert.rejects(
    provider.readResource(new URL("trellis://memories/escape.md"), context(home, "codex")),
    /outside the canonical memories directory/,
  );
});

test("BuiltinRegistry: provider failures are isolated and names stay unique", async () => {
  const provider = new SkillProvider();
  const broken = { id: "broken", listTools: () => { throw new Error("broken provider"); }, callTool: async () => ({ content: [] }) };
  const registry = new BuiltinRegistry([broken, provider], () => {});
  const tools = await registry.listTools(context(fixtureHome(), "codex"));
  assert.ok(tools.some((tool) => tool.name === "skills_search"));
});

test("BuiltinRegistry: compact built-in names retain logical metadata and dispatch", async () => {
  const provider = new SkillProvider();
  const registry = new BuiltinRegistry([provider], () => {});
  const runtimeContext = context(fixtureHome(), "codex");
  const tools = await registry.listTools(runtimeContext);
  const search = tools.find((tool) => tool.name === "skills_search");
  assert.ok(search);
  assert.equal(search.title, "skills / trellis.skills.search");
  const result = await registry.callTool("skills_search", { query: "" }, runtimeContext);
  assert.equal(result.isError, undefined);
  // Logical names remain valid for providers/Skills that describe the stable
  // capability id instead of one client's presentation name.
  const logical = await registry.callTool("trellis.skills.search", { query: "" }, runtimeContext);
  assert.equal(logical.isError, undefined);
});

test("BuiltinRegistry: normalized exposed names route with the original provider name", async () => {
  let calledWith = "";
  const provider = {
    id: "mcp.router",
    listTools: () => [{ name: "foo.bar", description: "fixture" }],
    callTool: async (name: string) => {
      calledWith = name;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  };
  const registry = new BuiltinRegistry([provider], () => {});
  const tools = await registry.listTools(context(fixtureHome(), "codex"));
  assert.equal(tools[0]?.name, "router__foo_bar");
  assert.equal(tools[0]?.title, "mcp.router / foo.bar");
  await registry.callTool("router__foo_bar", {}, context(fixtureHome(), "codex"));
  assert.equal(calledWith, "foo.bar");
});

test("BuiltinRegistry: resources and prompts are independently registered and routed", async () => {
  const provider = {
    id: "prompt-fixture",
    listPrompts: () => [{ name: "fixture.prompt", description: "fixture" }],
    getPrompt: async () => ({ description: "fixture", messages: [{ role: "user" as const, content: { type: "text" as const, text: "hello" } }] }),
    listResources: () => [{ uri: "trellis://fixture/resource", name: "fixture" }],
    readResource: async (uri: URL) => ({ contents: [{ uri: uri.toString(), text: "resource" }] }),
    callTool: async () => ({ content: [] }),
  };
  const registry = new BuiltinRegistry([provider], () => {});
  const runtimeContext = context(fixtureHome(), "codex");

  assert.deepEqual((await registry.listPrompts(runtimeContext)).map((prompt) => prompt.name), ["fixture.prompt"]);
  assert.equal((await registry.getPrompt("fixture.prompt", undefined, runtimeContext)).messages[0].content.text, "hello");
  assert.deepEqual((await registry.listResources(runtimeContext)).map((resource) => resource.uri), ["trellis://fixture/resource"]);
  assert.equal((await registry.readResource(new URL("trellis://fixture/resource"), runtimeContext)).contents[0].text, "resource");
});
