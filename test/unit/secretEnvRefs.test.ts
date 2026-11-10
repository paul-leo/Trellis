// mx-env-secret-source: `mxenv://<profile>/<KEY>` reference resolution
// through the `@morphixai/mxenv-core` SDK, delivered-name keying, and
// strict classification (never a silently-resolved bare name).
//
// Composition fixtures use a scratch HOME (os.homedir() honors $HOME) with
// a project-layer `mxenv.config.json` whose source is a plain local file —
// no provider CLI is spawned, so these stay unit tests.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnvEntry, resolveSecretEnv } from "../../src/lib/secretEnv.js";
import type { SecretsPolicy } from "../../src/core/types.js";
import { connectServer, resolveHeaders } from "../../src/lib/mcpConnect.js";
import { declaredEnvNames, extractTemplateVarNames } from "../../src/lib/envVarNames.js";
import { resolveMcpPlan } from "../../src/adapters/mcpPlan.js";
import { resolveGatewayUpstreams } from "../../src/commands/mcpGateway.js";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";

const POLICY: SecretsPolicy = { allowedVars: [], rejectPatterns: [] };

function scratchHome(config: unknown, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-refs-"));
  writeFileSync(join(dir, "mxenv.config.json"), JSON.stringify(config));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

const FIXTURE_CONFIG = {
  sources: { local1: { provider: "local", files: ["secrets.env"] } },
  profiles: { test: ["local1"] },
};

test("parseEnvEntry: a whole-string mxenv://<profile>/<KEY> is a ref delivered under KEY", () => {
  assert.deepEqual(parseEnvEntry("mxenv://legacy/MINIMAX_API_KEY"), {
    kind: "ref",
    profile: "legacy",
    key: "MINIMAX_API_KEY",
    delivered: "MINIMAX_API_KEY",
  });
});

test("parseEnvEntry: a bare name is a name delivered under itself", () => {
  assert.deepEqual(parseEnvEntry("PLAIN_NAME"), { kind: "name", delivered: "PLAIN_NAME" });
});

test("parseEnvEntry: reference-shaped text that is not a whole-string ref is invalid", () => {
  for (const entry of [
    "mxenv://no-slash-segment",
    "mxenv://a/B/C",
    "prefix mxenv://a/B",
    "mxenv://a/B suffix",
    "mx-env://legacy/OLD", // legacy scheme: SDK parser rejects it
  ]) {
    assert.deepEqual(parseEnvEntry(entry), { kind: "invalid", entry }, entry);
  }
});

test("resolveSecretEnv: a reference resolves from the composed environment, delivered under KEY", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  await withHome(home, async () => {
    const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN"], POLICY);
    assert.deepEqual(result, { SOME_TOKEN: "composed-value" });
  });
});

test("resolveSecretEnv: ambient env never shadows a reference", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  process.env.SOME_TOKEN = "ambient-value";
  try {
    await withHome(home, async () => {
      const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN"], POLICY);
      assert.deepEqual(result, { SOME_TOKEN: "composed-value" });
    });
  } finally {
    delete process.env.SOME_TOKEN;
  }
});

test("resolveSecretEnv: a missing reference key resolves to undefined under its delivered name", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "OTHER=x\n" });
  await withHome(home, async () => {
    const result = await resolveSecretEnv(["mxenv://test/NOT_DEFINED_ANYWHERE"], POLICY);
    assert.deepEqual(result, { NOT_DEFINED_ANYWHERE: undefined });
  });
});

test("resolveSecretEnv: results are keyed by delivered name across a mixed batch", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  process.env.PLAIN_NAME = "ambient-plain";
  try {
    await withHome(home, async () => {
      const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN", "PLAIN_NAME"], POLICY);
      assert.deepEqual(result, { SOME_TOKEN: "composed-value", PLAIN_NAME: "ambient-plain" });
    });
  } finally {
    delete process.env.PLAIN_NAME;
  }
});

test("resolveSecretEnv: a reference never resolves from env_file or ambient env", async () => {
  // env_file is the SOLE source for bare names only; the reference must come
  // from the composition even when env_file defines the same name.
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  const envFile = join(home, "policy.env");
  writeFileSync(envFile, "SOME_TOKEN=from-file\n");
  process.env.SOME_TOKEN = "ambient-value";
  try {
    await withHome(home, async () => {
      const policy: SecretsPolicy = { allowedVars: [], rejectPatterns: [], envFile };
      const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN"], policy);
      assert.deepEqual(result, { SOME_TOKEN: "composed-value" });
    });
  } finally {
    delete process.env.SOME_TOKEN;
  }
});

test("resolveSecretEnv: an invalid entry rejects the batch with the entry text", async () => {
  await assert.rejects(
    () => resolveSecretEnv(["mxenv://no-slash-segment"], POLICY),
    /invalid mxenv:\/\/ reference entry: mxenv:\/\/no-slash-segment/,
  );
});


test("parseEnvEntry: KEY segments with dots/dashes and dashed profiles parse through the SDK grammar", () => {
  assert.deepEqual(parseEnvEntry("mxenv://my-profile/SOME.KEY-2"), {
    kind: "ref",
    profile: "my-profile",
    key: "SOME.KEY-2",
    delivered: "SOME.KEY-2",
  });
});

test("resolveSecretEnv: a composed reference never loses to a same-named bare entry (collision rule)", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "SOME_TOKEN=composed-value\n" });
  process.env.SOME_TOKEN = "ambient-value";
  try {
    await withHome(home, async () => {
      const result = await resolveSecretEnv(["SOME_TOKEN", "mxenv://test/SOME_TOKEN"], POLICY);
      assert.deepEqual(result, { SOME_TOKEN: "composed-value" });
    });
  } finally {
    delete process.env.SOME_TOKEN;
  }
});

test("resolveSecretEnv: a missing reference key still fills from a bare entry of the same delivered name", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "OTHER=x\n" });
  process.env.SOME_TOKEN = "ambient-value";
  try {
    await withHome(home, async () => {
      const result = await resolveSecretEnv(["mxenv://test/SOME_TOKEN", "SOME_TOKEN"], POLICY);
      assert.deepEqual(result, { SOME_TOKEN: "ambient-value" });
    });
  } finally {
    delete process.env.SOME_TOKEN;
  }
});

test("headers extract references, bare names and malformed schemes for validation", () => {
  assert.deepEqual(extractTemplateVarNames("${PLAIN} ${mxenv://test/TOKEN} ${mx-env://test/BAD} ${mxevn://test/BAD}"),
    ["PLAIN", "mxenv://test/TOKEN", "mx-env://test/BAD", "mxevn://test/BAD"]);
  assert.deepEqual(declaredEnvNames({ transport: "http", headers: { Authorization: "Bearer ${mxenv://test/TOKEN}" } }), ["mxenv://test/TOKEN"]);
});

test("headers resolve references without ambient env, mix bare names, and preserve profile identity", async () => {
  const home = scratchHome({
    sources: {
      first: { provider: "local", files: ["first.env"] },
      second: { provider: "local", files: ["second.env"] },
    },
    profiles: { first: ["first"], second: ["second"] },
  }, { "first.env": "TOKEN=first-fixture-value\n", "second.env": "TOKEN=second-fixture-value\n", "policy.env": "TOKEN=bare-fixture-value\n" });
  await withHome(home, async () => {
    assert.deepEqual(await resolveHeaders({ transport: "http", headers: {
      Authorization: "Bearer ${mxenv://first/TOKEN}",
      "X-Other": "${mxenv://second/TOKEN}/${TOKEN}/${MISSING}",
    } }, { ...POLICY, envFile: join(home, "policy.env") }), {
      Authorization: "Bearer first-fixture-value", "X-Other": "second-fixture-value/bare-fixture-value/",
    });
  });
});

test("missing header references never fall back to a same-named bare value", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "OTHER=fixture-value\n", "policy.env": "TOKEN=bare-fixture-value\n" });
  await withHome(home, async () => {
    const envPlan = await resolveMcpPlan("claude-code", { servers: { legacy: {
      transport: "stdio", command: "node", env: ["mxenv://test/TOKEN", "TOKEN"],
    } }, knownHostInjected: [] }, ["claude-code"], { ...POLICY, envFile: join(home, "policy.env") });
    assert.equal(envPlan.desired.length, 1, "env/envAliases keep their existing fallback semantics");
    await assert.rejects(() => resolveHeaders({ transport: "http", headers: { Authorization: "${mxenv://test/TOKEN}/${TOKEN}" } },
      { ...POLICY, envFile: join(home, "policy.env") }), /unresolved header reference: mxenv:\/\/test\/TOKEN/);
  });
});

test("header references fail explicitly for missing profile, malformed URI and misspelled schemes", async () => {
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": "TOKEN=fixture-value\n" });
  await withHome(home, async () => {
    for (const ref of ["mxenv://absent/TOKEN", "mxenv://broken", "mx-env://test/TOKEN", "mxevn://test/TOKEN"]) {
      await assert.rejects(() => resolveHeaders({ transport: "http", headers: { Authorization: `Bearer \${${ref}}` } }, POLICY));
    }
    for (const template of ["Bearer ${mxenv://test/TOKEN", "mxenv://test/TOKEN"]) {
      await assert.rejects(() => resolveHeaders({ transport: "http", headers: { Authorization: template } }, POLICY), /invalid reference template/);
    }
  });
});

test("gateway validates header references, isolates a broken server and keeps secrets out of plans", async () => {
  const secret = "fixture-value-must-stay-in-memory";
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": `TOKEN=${secret}\n` });
  await withHome(home, async () => {
    const servers = {
      valid: { transport: "http" as const, url: "https://example.test/mcp", headers: { Authorization: "Bearer ${mxenv://test/TOKEN}" } },
      missing: { transport: "http" as const, url: "https://example.test/mcp", headers: { Authorization: "Bearer ${mxenv://test/MISSING}" } },
      unknown: { transport: "http" as const, url: "https://example.test/mcp", headers: { Authorization: "Bearer ${mxenv://absent/TOKEN}" } },
      typo: { transport: "http" as const, url: "https://example.test/mcp", headers: { Authorization: "Bearer ${mxevn://test/TOKEN}" } },
    };
    const canonical = { mcp: { servers, knownHostInjected: [] }, managedAgents: ["codex" as const], secretsPolicy: POLICY };
    const result = await resolveGatewayUpstreams("codex", canonical);
    assert.deepEqual(result.upstreams.map(({ name }) => name), ["valid"]);
    assert.equal(result.conflicts.length, 3);
    assert.equal(JSON.stringify(result).includes(secret), false);
    const native = await resolveMcpPlan("claude-code", { servers: { valid: servers.valid }, knownHostInjected: [] }, ["claude-code"], POLICY);
    assert.deepEqual(native.desired, []);
    assert.match(native.conflicts[0].message, /require Trellis gateway\/runtime/);
    assert.equal(JSON.stringify(native).includes(secret), false);
  });
});

test("HTTP connect authenticates and calls tools with an mxenv header without shell injection", async (t) => {
  const secret = "http-fixture-secret";
  const home = scratchHome(FIXTURE_CONFIG, { "secrets.env": `HTTP_FIXTURE_TOKEN=${secret}\n` });
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "header-fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "check", inputSchema: { type: "object" } }] }));
    server.setRequestHandler("tools/call", async () => ({ content: [{ type: "text", text: "authenticated" }] }));
    return server;
  });
  let authenticatedRequests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
    authenticatedRequests++;
    return handler.fetch(request);
  });
  try {
    await withHome(home, async () => {
      assert.equal(process.env.HTTP_FIXTURE_TOKEN, undefined);
      const client = await connectServer({ transport: "http", url: "http://fixture.test/mcp", headers: { Authorization: "Bearer ${mxenv://test/HTTP_FIXTURE_TOKEN}" } },
        POLICY, 5000, { name: "header-test", version: "1" });
      try {
        assert.equal((await client.listTools()).tools[0].name, "check");
        const result = await client.callTool({ name: "check", arguments: {} });
        assert.equal(result.content?.[0].text, "authenticated");
        assert.ok(authenticatedRequests >= 3);
      } finally { await client.close(); }
    });
  } finally { await handler.close(); }
});
