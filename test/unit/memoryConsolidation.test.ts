import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runMemoryExport } from "../../src/commands/memoryExport.js";
import { BuiltinRegistry } from "../../src/lib/mcpRuntime.js";
import { RuntimeMemoryProvider } from "../../src/lib/memoryProvider.js";
import { scratchHome, seedCanonical } from "../helpers/home.js";

function fixture() {
  const home = scratchHome("memory-consolidation");
  const graph = join(home, ".trellis/memories/graph.jsonl");
  seedCanonical(home, {managed: ["codex"], instructions: "# fixture\n", serversYaml: `servers:\n  memory:\n    transport: stdio\n    command: node\n    static_env:\n      MEMORY_FILE_PATH: ${graph}\n`});
  mkdirSync(join(home, ".trellis/memories"), {recursive: true});
  return {home, graph};
}

function exportJson(home: string, dryRun = false) {
  const messages: string[] = [];
  const log = console.log;
  try {
    console.log = (value: unknown) => messages.push(String(value));
    assert.equal(runMemoryExport({homeDir: home, json: true, dryRun}).exitCode, 0);
  } finally {console.log = log;}
  return JSON.parse(messages.join("\n"));
}

test("shared graph mode withdraws canonical tools/resources and blocks cached canonical calls", async () => {
  const {home} = fixture();
  writeFileSync(join(home, ".trellis/memories/old.md"), "historical Markdown\n");
  const provider = new RuntimeMemoryProvider();
  const context = {homeDir: home, agentId: "codex" as const};
  assert.deepEqual(await new BuiltinRegistry([provider]).listTools(context), []);
  assert.deepEqual(await provider.listResources(context), []);
  assert.equal((await provider.callTool("trellis.memory.read", {name: "old"}, context)).isError, true);
  await assert.rejects(provider.readResource(new URL("trellis://memories/old.md"), context));
  assert.equal(readFileSync(join(home, ".trellis/memories/old.md"), "utf8"), "historical Markdown\n");
  writeFileSync(join(home, ".trellis/mcp/servers.yaml"), "servers: {}\n");
  assert.equal(provider.listTools(context).length, 2, "legacy clients without a shared backend retain their read path");
});

test("graph export creates private snapshots with unique filenames without populating live Markdown", () => {
  const {home, graph} = fixture();
  const data = [{type: "entity", name: "A B", entityType: "test", observations: ["first"]}, {type: "entity", name: "A-B", entityType: "test", observations: ["second"]}, {type: "relation", from: "A B", to: "A-B", relationType: "tests"}].map(record => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(graph, data);
  const first = exportJson(home);
  assert.equal(first.entities, 2);
  assert.equal(first.relations, 1);
  assert.equal(readFileSync(graph, "utf8"), data);
  assert.equal(readFileSync(join(first.directory, "graph.jsonl"), "utf8"), data);
  const files = readdirSync(first.directory).filter(file => file.endsWith(".md"));
  assert.equal(files.length, 2, "slug collisions are disambiguated without losing a record");
  for (const file of files) assert.equal(statSync(join(first.directory, file)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(home, ".trellis/memories")), ["graph.jsonl"]);
  const second = exportJson(home);
  assert.notEqual(first.directory, second.directory);
  assert.equal(readFileSync(join(first.directory, "graph.jsonl"), "utf8"), data);
});

test("graph export dry run writes neither archives nor live memory", () => {
  const {home, graph} = fixture();
  writeFileSync(graph, "\n");
  const result = exportJson(home, true);
  assert.equal(result.entities, 0);
  assert.equal(existsSync(join(home, ".trellis/archive")), false);
  assert.equal(readFileSync(graph, "utf8"), "\n");
});

test("legacy migration helper is workspace-bound and excludes private, unindexed, escaped and oversized files", () => {
  const home = scratchHome("memory-legacy-helper");
  const root = join(home, "projects");
  const memory = join(root, "-workspace-project/memory");
  mkdirSync(memory, {recursive: true});
  writeFileSync(join(memory, "MEMORY.md"), "[good](good.md)\n[private](identity.private.md)\n[escape](escape.md)\n[big](big.md)\n");
  writeFileSync(join(memory, "good.md"), "durable fixture\npassword=synthetic-fixture\n");
  writeFileSync(join(memory, "identity.private.md"), "must never be read\n");
  writeFileSync(join(memory, "big.md"), "x".repeat(256 * 1024 + 1));
  const outside = join(home, "outside.md");
  writeFileSync(outside, "outside workspace\n");
  symlinkSync(outside, join(memory, "escape.md"));
  const code = `import importlib.util,json,sys\nfrom pathlib import Path\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('legacy_memory',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.ROOT=Path(sys.argv[2])\nfolder=m.locate(Path('/workspace/project'))\nblocked=[]\nfor name in ['identity.private.md','escape.md','big.md','../outside.md']:\n try: m.selected_file(folder,name)\n except SystemExit: blocked.append(name)\nparent_blocked=False\ntry: m.locate(Path('/workspace/project/child'))\nexcept SystemExit: parent_blocked=True\nprint(json.dumps({'names':m.indexed_names(folder),'blocked':len(blocked),'parentBlocked':parent_blocked,'redacted':m.safe('password=synthetic-fixture').startswith('[redacted:')}))`;
  const output = execFileSync("python3", ["-c", code, resolve("schema/builtin-skills/trellis-memory/scripts/legacy_memory.py"), root], {encoding: "utf8"});
  assert.deepEqual(JSON.parse(output), {names: ["good.md"], blocked: 4, parentBlocked: true, redacted: true});
});
