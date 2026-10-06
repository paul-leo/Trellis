/**
 * trellis-skills-over-mcp: canonical skills served as `skill://` resources with
 * a manifest a host can verify, plus `skills/list` / `skills/get`.
 *
 * The manifest is the thing under test, so every check re-derives the digest
 * from the bytes the server actually returned instead of trusting the server's
 * own number.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { BuiltinRegistry, createRuntimeServer } from "../../src/lib/mcpRuntime.js";
import { SkillProvider } from "../../src/lib/skillProvider.js";
import { buildSkillEntry, parseSkillUri } from "../../src/lib/skillManifest.js";

const sha = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixtureHome(): { home: string; skills: string } {
  const home = mkdtempSync(join(tmpdir(), "trellis-skills-mcp-"));
  const root = join(home, ".trellis");
  mkdirSync(join(root, "mcp"), { recursive: true });
  writeFileSync(join(root, "agents.md"), "# instructions\n");
  writeFileSync(join(root, "managed.yaml"), "agents: [claude-code, codex]\n");
  writeFileSync(join(root, "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(root, "mcp", "servers.yaml"), "servers: {}\n");
  return { home, skills: join(root, "skills") };
}

function addSkill(skills: string, dir: string, frontmatter: string, extra: Record<string, string | Buffer> = {}): string {
  const full = join(skills, dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${dir}\n`);
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(full, rel, ".."), { recursive: true });
    writeFileSync(join(full, rel), content);
  }
  return full;
}

const ctx = (homeDir: string, agentId: "claude-code" | "codex" = "claude-code") => ({ homeDir, agentId });

async function connect(home: string, agentId: "claude-code" | "codex" = "claude-code", warn: (m: string) => void = () => {}) {
  const registry = new BuiltinRegistry([new SkillProvider(warn)], warn);
  const server = createRuntimeServer({ name: "trellis-test", version: "0" }, ctx(home, agentId), registry);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    server,
    raw: (method: string, params?: Record<string, unknown>) => client.request({ method, ...(params ? { params } : {}) }, ResultSchema) as Promise<Record<string, any>>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("skill://: a skill and its supporting files are listed and readable, with the declared content type", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code", { "references/checklist.md": "check things\n", "notes.txt": "plain\n" });
  const c = await connect(home);
  try {
    const { resources } = await c.client.listResources();
    const uris = resources.map((r) => r.uri);
    for (const expected of ["skill://review/SKILL.md", "skill://review/references/checklist.md", "skill://review/notes.txt"]) {
      assert.ok(uris.includes(expected), `${expected} should be listed`);
    }

    const read = await c.client.readResource({ uri: "skill://review/references/checklist.md" });
    assert.equal((read.contents[0] as { text: string }).text, "check things\n");
    assert.equal(read.contents[0].mimeType, "text/markdown");
  } finally {
    await c.close();
  }
});

test("skill://: the existing trellis:// resources and tools are untouched", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code");
  const c = await connect(home);
  try {
    const legacy = await c.client.readResource({ uri: "trellis://skills/review/SKILL.md" });
    assert.match((legacy.contents[0] as { text: string }).text, /# review/);
    const tools = (await c.client.listTools()).tools.map((t) => t.name);
    assert.equal(tools.length, 3, "search, read and read_file are all still there");
  } finally {
    await c.close();
  }
});

test("manifest: every digest and size matches the bytes a host actually receives", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code", {
    "references/a.md": "alpha\n",
    "references/unicode.md": "héllo — ✓\n",
    "data.bin": Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]),
  });
  const c = await connect(home);
  try {
    const { skills: listed } = await c.raw("skills/list");
    const entry = listed[0];
    assert.equal(entry.resources.length, 4);

    for (const file of entry.resources as Array<{ uri: string; digest: string; size: number }>) {
      const content = (await c.client.readResource({ uri: file.uri })).contents[0] as { text?: string; blob?: string };
      const received = content.blob !== undefined ? Buffer.from(content.blob, "base64") : Buffer.from(content.text ?? "", "utf8");
      assert.equal(received.length, file.size, `${file.uri}: size`);
      assert.equal(sha(received), file.digest, `${file.uri}: digest of the received bytes`);
      assert.match(file.digest, /^sha256:[0-9a-f]{64}$/);
    }
  } finally {
    await c.close();
  }
});

test("manifest: non-UTF-8 bytes are sent as a blob so the verified bytes are the hashed bytes", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code", { "data.bin": Buffer.from([0xff, 0xfe, 0x00]) });
  const c = await connect(home);
  try {
    const content = (await c.client.readResource({ uri: "skill://review/data.bin" })).contents[0] as { blob?: string; text?: string };
    assert.equal(content.text, undefined);
    assert.equal(content.blob, Buffer.from([0xff, 0xfe, 0x00]).toString("base64"));
  } finally {
    await c.close();
  }
});

test("manifest: secret-shaped, hidden and oversized files are absent from the manifest and unreadable alike", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code", {
    "ok.md": "fine\n",
    ".env": "TOKEN=abc\n",
    "api-secret.txt": "hunter2\n",
    ".hidden/notes.md": "hidden\n",
    "huge.txt": "x".repeat(300 * 1024),
  });
  const c = await connect(home);
  try {
    const { skills: listed } = await c.raw("skills/list");
    const advertised = (listed[0].resources as Array<{ uri: string }>).map((r) => r.uri).sort();
    assert.deepEqual(advertised, ["skill://review/SKILL.md", "skill://review/ok.md"]);

    for (const uri of ["skill://review/.env", "skill://review/api-secret.txt", "skill://review/.hidden/notes.md", "skill://review/huge.txt"]) {
      await assert.rejects(() => c.client.readResource({ uri }), `${uri} must not be readable`);
    }
  } finally {
    await c.close();
  }
});

test("manifest: a symlink out of the skill root is neither advertised nor readable", async () => {
  const { home, skills } = fixtureHome();
  const dir = addSkill(skills, "review", "name: review\ndescription: review code");
  const outside = join(home, "outside.md");
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, join(dir, "escape.md"));
  const c = await connect(home);
  try {
    const { skills: listed } = await c.raw("skills/list");
    assert.deepEqual((listed[0].resources as Array<{ uri: string }>).map((r) => r.uri), ["skill://review/SKILL.md"]);
    await assert.rejects(() => c.client.readResource({ uri: "skill://review/escape.md" }));
  } finally {
    await c.close();
  }
});

test("manifest: a skill over the file-count limit is omitted whole and reported, never partially advertised", async () => {
  const { home, skills } = fixtureHome();
  const files: Record<string, string> = {};
  for (let i = 0; i < 520; i++) files[`f/${i}.md`] = "x";
  addSkill(skills, "toobig", "name: toobig\ndescription: too many files", files);
  addSkill(skills, "fine", "name: fine\ndescription: ok");
  const reports: string[] = [];
  const c = await connect(home, "claude-code", (m) => reports.push(m));
  try {
    const { skills: listed } = await c.raw("skills/list");
    assert.deepEqual(listed.map((s: any) => s.frontmatter.name), ["fine"]);
    assert.ok(reports.some((m) => /toobig.*size limit/.test(m)), `expected a diagnostic, got ${JSON.stringify(reports)}`);
    await assert.rejects(() => c.client.readResource({ uri: "skill://toobig/SKILL.md" }));
  } finally {
    await c.close();
  }
});

test("naming: a directory whose name differs from its frontmatter name is not served under skill://", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: code-review\ndescription: mismatch");
  addSkill(skills, "Has_Caps", "name: Has_Caps\ndescription: invalid uri authority");
  addSkill(skills, "nodesc", "name: nodesc");
  const reports: string[] = [];
  const c = await connect(home, "claude-code", (m) => reports.push(m));
  try {
    const { skills: listed } = await c.raw("skills/list");
    assert.deepEqual(listed, []);
    assert.ok(reports.some((m) => /review.*does not match.*code-review/.test(m)));
    assert.ok(reports.some((m) => /not a valid Agent Skills name/.test(m)));
    assert.ok(reports.some((m) => /nodesc.*description/.test(m)));
    // They remain reachable through the existing tools, which is not this change's business.
    const legacy = await c.client.readResource({ uri: "trellis://skills/review/SKILL.md" });
    assert.ok(legacy.contents.length > 0);
  } finally {
    await c.close();
  }
});

test("skills/list: entries carry the verbatim frontmatter, the full manifest, and the required cache fields", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code\nallowed-tools: Read Grep\nmetadata:\n  team: platform");
  const c = await connect(home);
  try {
    const result = await c.raw("skills/list");
    assert.equal(result.resultType, undefined, "legacy results do not carry modern wire discrimination");
    assert.equal(typeof result.ttlMs, "number");
    assert.ok(result.ttlMs >= 0);
    assert.equal(result.cacheScope, "private", "the list varies by agent, so it must not be shareable");
    const [entry] = result.skills;
    assert.equal(entry.uri, "skill://review/SKILL.md");
    assert.deepEqual(entry.frontmatter, { name: "review", description: "review code", "allowed-tools": "Read Grep", metadata: { team: "platform" } });
    assert.equal(entry.resources[0].uri, "skill://review/SKILL.md");
  } finally {
    await c.close();
  }
});

test("skills/get: returns the same entry by URI, and -32602 for unknown or malformed URIs", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code");
  const c = await connect(home);
  try {
    const listed = (await c.raw("skills/list")).skills[0];
    const got = await c.raw("skills/get", { uri: "skill://review/SKILL.md" });
    assert.deepEqual(got.skill, listed);
    assert.equal(got.resultType, undefined, "legacy results do not carry modern wire discrimination");
    assert.equal(got.cacheScope, "private");

    for (const uri of ["skill://nope/SKILL.md", "skill://review/other.md", "https://example.com/SKILL.md", 42]) {
      await assert.rejects(() => c.raw("skills/get", { uri: uri as string }), (err: any) => err.code === -32602, `${String(uri)} → -32602`);
    }
    await assert.rejects(() => c.raw("skills/get"), (err: any) => err.code === -32602);
  } finally {
    await c.close();
  }
});

test("scope: a skill scoped away from the agent is invisible everywhere, including by direct URI", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code");
  addSkill(skills, "private-one", "name: private-one\ndescription: claude only");
  writeFileSync(join(home, ".trellis", "scope.yaml"), "skills:\n  private-one: [claude-code]\n");

  const codex = await connect(home, "codex");
  try {
    assert.deepEqual((await codex.raw("skills/list")).skills.map((s: any) => s.frontmatter.name), ["review"]);
    assert.ok(!(await codex.client.listResources()).resources.some((r) => r.uri.includes("private-one") && r.uri.startsWith("skill://")));
    await assert.rejects(() => codex.client.readResource({ uri: "skill://private-one/SKILL.md" }));
    await assert.rejects(() => codex.raw("skills/get", { uri: "skill://private-one/SKILL.md" }), (err: any) => err.code === -32602);
  } finally {
    await codex.close();
  }

  const claude = await connect(home, "claude-code");
  try {
    assert.deepEqual((await claude.raw("skills/list")).skills.map((s: any) => s.frontmatter.name).sort(), ["private-one", "review"]);
  } finally {
    await claude.close();
  }
});

test("declaration: extension metadata is available and unknown methods still get method-not-found", async () => {
  const { home, skills } = fixtureHome();
  addSkill(skills, "review", "name: review\ndescription: review code");
  const c = await connect(home);
  try {
    const caps = c.client.getServerCapabilities() as Record<string, unknown>;
    assert.deepEqual((caps.extensions as Record<string, unknown>)["io.modelcontextprotocol/skills"], {});
    assert.equal("experimental" in caps, false, "and nothing smuggled into another field");

    await assert.rejects(() => c.raw("totally/unknown"), (err: any) => err.code === -32601);
  } finally {
    await c.close();
  }
});

test("helpers: parseSkillUri accepts only skill://<name>/<path> and rejects traversal", () => {
  assert.deepEqual(parseSkillUri("skill://review/SKILL.md"), { name: "review", path: "SKILL.md" });
  assert.deepEqual(parseSkillUri("skill://review/a%20b/c.md"), { name: "review", path: "a b/c.md" });
  for (const bad of ["trellis://skills/review/SKILL.md", "skill://review", "skill:///SKILL.md", "skill://review/../x", "skill://review//x", "skill://review/%zz"]) {
    assert.equal(parseSkillUri(bad), undefined, bad);
  }
  assert.equal(buildSkillEntry("Bad", "/nonexistent").ok, false);
});
