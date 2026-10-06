import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { LocalBackend } from "../../src/lib/gatewayBackend.js";
import { BuiltinRegistry, createRuntimeServer } from "../../src/lib/mcpRuntime.js";
import { SkillProvider } from "../../src/lib/skillProvider.js";
import { UpstreamResources, upstreamUri, withoutUpstreamServerInfo } from "../../src/lib/upstreamResources.js";
import { digestOf } from "../../src/lib/skillManifest.js";

const fixture = resolve("test/fixtures/modernSkillServer.ts");
const policy = { allowedVars: [], rejectPatterns: [] };
const spec = (name: string, tools = false) => ({ name, def: { transport: "stdio" as const, command: process.execPath, args: ["--import", "tsx", fixture, ...(tools ? ["--tools"] : [])] } });

test("a valid skill resource larger than the SDK's default frame limit remains readable", async () => {
  const large = spec("large");
  large.def.args.push("--large");
  const backend = await LocalBackend.connect([large], { secretsPolicy: policy, clientInfo: { name: "test", version: "1" }, connectTimeoutMs: 10000 });
  try {
    const [skill] = await backend.listSkills();
    const uri = new URL("references/checklist.md", skill!.uri).toString();
    const content = (await backend.readResource(uri)).contents[0]!;
    assert.equal(content.text?.length, 11 * 1024 * 1024);
    assert.equal(skill!.resources.find((file) => file.uri === uri)?.size, 11 * 1024 * 1024);
  } finally { await backend.close(); }
});

test("modern-only resource upstreams are connected and equal skill names remain source-bound", async () => {
  const backend = await LocalBackend.connect([spec("alpha"), spec("beta")], { secretsPolicy: policy, clientInfo: { name: "test", version: "1" }, connectTimeoutMs: 10000 });
  try {
    assert.deepEqual((await backend.listTools()), []);
    assert.deepEqual(backend.listStatus().map((s) => s.status), ["ready", "ready"]);
    const skills = await backend.listSkills();
    assert.equal(skills.length, 2);
    assert.notEqual(skills[0]!.uri, skills[1]!.uri);
    for (const entry of skills) {
      assert.equal(entry.frontmatter.name, "review");
      assert.deepEqual(entry.frontmatter.metadata, { team: "upstream" });
      const support = new URL("references/checklist.md", entry.uri).toString();
      const content = (await backend.readResource(support)).contents[0]!;
      assert.equal("text" in content ? content.text : "", "check correctness\n");
      assert.equal(content.uri, support);
      const forwarded = await backend.readResource(support);
      assert.equal(forwarded._meta?.["io.modelcontextprotocol/serverInfo"], undefined, "the gateway must stamp its own outer identity");
    }
    const hidden = await backend.getSkill(upstreamUri("alpha", "skill://hidden/SKILL.md"));
    assert.equal(hidden?.frontmatter.name, "hidden", "direct lookup does not require listing");
    await assert.rejects(() => backend.readResource(upstreamUri("alpha", "skill://review/not-in-manifest.txt")), /unknown upstream resource/);
    assert.equal(await backend.getSkill(upstreamUri("unknown", "skill://review/SKILL.md")), undefined);
  } finally { await backend.close(); }
});

test("forwarded result identity is distinct from its preserved upstream provenance", () => {
  const result = withoutUpstreamServerInfo({ content: [], _meta: { "io.modelcontextprotocol/serverInfo": { name: "upstream" }, "io.trellis/origin": { server: "alpha" } } });
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"], undefined);
  assert.deepEqual(result._meta["io.trellis/origin"], { server: "alpha" });
});

test("relayed file changes fail until the manifest is explicitly refreshed", async () => {
  const backend = await LocalBackend.connect([spec("alpha", true)], { secretsPolicy: policy, clientInfo: { name: "test", version: "1" }, connectTimeoutMs: 10000 });
  try {
    const [skill] = await backend.listSkills();
    const support = new URL("references/checklist.md", skill!.uri).toString();
    await backend.callTool((await backend.listTools())[0]!.name, {});
    await assert.rejects(() => backend.readResource(support), /differs from its manifest/);
    await backend.getSkill(skill!.uri);
    assert.equal((await backend.readResource(support)).contents[0]!.text, "changed bytes\n");
  } finally { await backend.close(); }
});

test("skill catalogs paginate without fetching files, and undeclared extensions are ignored", async () => {
  let reads = 0;
  let pages = 0;
  const text = "---\nname: review\ndescription: Review\n---\n";
  const entry = { uri: "skill://review/SKILL.md", frontmatter: { name: "review", description: "Review" }, resources: [{ uri: "skill://review/SKILL.md", digest: digestOf(Buffer.from(text)), size: Buffer.byteLength(text) }] };
  const client = {
    getServerCapabilities: () => ({ resources: {} }),
    getDiscoverResult: () => ({ capabilities: { extensions: { "io.modelcontextprotocol/skills": {} } } }),
    request: async ({ params }: { params: { cursor?: string } }) => { pages++; return params.cursor ? { skills: [entry] } : { skills: [], nextCursor: "next" }; },
    readResource: async ({ uri }: { uri: string }) => { reads++; return { contents: [{ uri, text }] }; },
  } as unknown as Client;
  const relay = new UpstreamResources(1000, () => {});
  relay.add("source", client);
  assert.equal((await relay.listSkills()).length, 1);
  assert.equal(pages, 2);
  assert.equal(reads, 0);
  await relay.readResource(upstreamUri("source", entry.uri));
  assert.equal(reads, 1);
  const undeclared = new UpstreamResources(1000, () => {});
  undeclared.add("source", { ...client, getDiscoverResult: () => undefined } as unknown as Client);
  assert.deepEqual(await undeclared.listSkills(), []);
});

test("modern discovery advertises scoped canonical skills and SDK emits modern wire metadata", async () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-modern-"));
  const root = join(home, ".trellis");
  mkdirSync(join(root, "skills", "review"), { recursive: true });
  writeFileSync(join(root, "managed.yaml"), "agents: [codex]\n");
  writeFileSync(join(root, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review\n---\n");
  const registry = new BuiltinRegistry([new SkillProvider()], () => {});
  const handler = createMcpHandler(() => createRuntimeServer({ name: "trellis", version: "test" }, { homeDir: home, agentId: "codex" }, registry));
  const wire: Record<string, any>[] = [];
  const client = new Client({ name: "modern-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL("http://fixture.test/mcp"), { fetch: async (url, init) => {
    const response = await handler.fetch(new Request(url, init));
    if (response.headers.get("content-type")?.includes("application/json")) wire.push(await response.clone().json());
    return response;
  } });
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    assert.deepEqual(client.getDiscoverResult()?.capabilities.extensions?.["io.modelcontextprotocol/skills"], {});
    const result = await client.request({ method: "skills/list", params: {} }, z.looseObject({ skills: z.array(z.looseObject({ uri: z.string() })) }));
    assert.equal(result.skills[0]!.uri, "skill://review/SKILL.md");
    await assert.rejects(() => client.readResource({ uri: "skill://missing/SKILL.md" }), (err: any) => err.code === -32602);
    assert.ok(wire.some((r) => r.result?.resultType === "complete" && r.result?.skills), "modern wire includes result discrimination");
    assert.ok(wire.some((r) => r.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "trellis"));
    assert.equal(existsSync(join(root, "skills", "upstream")), false);
  } finally { await client.close(); await handler.close(); await registry.close(); }
});
