/**
 * pi native MCP delivery (trellis-pi-native-mcp-migration tasks.md
 * 2.1–2.4): on pi >= 1.1.0 the adapter plans mcp.json writes through the
 * shared JSON machinery and retires the bridge extension in the same
 * apply — config write first, symlink removal last, removal withheld on
 * any conflict. Scratch homes only; the version gate is injected, never
 * read from the machine running the suite.
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiAdapter } from "../../src/adapters/pi.js";
import { loadCanonicalSource } from "../../src/core/canonical.js";
import { openBackupSession } from "../../src/lib/backup.js";

const NATIVE = () => "1.1.0";
const LEGACY = () => "1.0.5";

/** Mirrors the real machine's pi route: gateway mode with an explicit
 * server list, one agent-owned OAuth server (figma) and one trellis-owned
 * one (sentry). */
const GATEWAY_YAML = `
servers:
  harness-solo:
    transport: stdio
    command: /usr/local/bin/harness
    args: [mcp]
  figma:
    transport: http
    url: https://mcp.figma.com/mcp
    auth: oauth
  sentry:
    transport: http
    url: https://mcp.sentry.dev/mcp
    auth:
      kind: oauth
      owner: trellis
routes:
  pi:
    mode: gateway
    servers: [harness-solo, figma, sentry]
`;

function scratchHome(serversYaml: string = GATEWAY_YAML): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-pi-native-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [pi]\n");
  return home;
}

function readMcpJson(home: string): { mcpServers: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf-8"));
}

/** The same path the adapter's resolveBridgeFile computes, from the
 * test's own position two levels below the repo root. */
function bridgeBundlePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "pi-bridge", "bundle.js");
}

function seedBridgeSymlink(home: string): string {
  const link = join(home, ".pi", "agent", "extensions", "trellis-mcp-bridge.js");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(bridgeBundlePath(), link);
  return link;
}

test("native plan: gateway route yields the trellis edge entry plus bare agent-owned OAuth entries", async () => {
  const home = scratchHome();
  const canonical = loadCanonicalSource(home);
  const plan = await new PiAdapter(home, NATIVE).plan(canonical);

  const mcpItems = plan.filter((i) => i.kind === "mcp");
  const byName = new Map(mcpItems.map((i) => [i.mcpWrite?.name, i]));
  assert.equal(byName.get("trellis")?.action, "create");
  assert.deepEqual(byName.get("trellis")?.mcpWrite?.def.args, ["mcp-gateway", "--agent", "pi"]);
  // figma is agent-owned: a direct bare-url entry beside the gateway
  // entry, which `pi mcp login figma` authorizes (design.md D4).
  assert.deepEqual(byName.get("figma")?.mcpWrite?.def, { transport: "http", url: "https://mcp.figma.com/mcp", auth: "oauth" });
  // sentry is trellis-owned: it stays inside the runtime, no direct entry.
  assert.equal(byName.has("sentry"), false);
  assert.equal(plan.filter((i) => i.kind === "extension").length, 0, "native mode never plans the bridge");
});

test("native plan: runtime delivery names the runtime command instead of the gateway alias", async () => {
  const home = scratchHome(`${GATEWAY_YAML}\nruntime:\n  delivery:\n    pi: mcp\n`);
  const canonical = loadCanonicalSource(home);
  const plan = await new PiAdapter(home, NATIVE).plan(canonical);
  const trellis = plan.find((i) => i.mcpWrite?.name === "trellis");
  assert.deepEqual(trellis?.mcpWrite?.def.args, ["mcp-runtime", "--agent", "pi"]);
});

test("native apply: mcp.json gains the entries, a user-authored server survives byte-for-byte, second plan is empty", async () => {
  const home = scratchHome();
  const configPath = join(home, ".pi", "agent", "mcp.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { mailbox: { command: "node", args: ["/user/own/mailbox.js"] } } }, null, 2) + "\n");

  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);
  const plan = await adapter.plan(canonical);
  const backup = openBackupSession(home, "test-pi-native");
  await adapter.apply(plan.filter((i) => i.kind === "mcp"), backup);
  backup.finalize();

  const written = readMcpJson(home);
  assert.deepEqual(written.mcpServers.mailbox, { command: "node", args: ["/user/own/mailbox.js"] }, "user entry untouched");
  assert.deepEqual(written.mcpServers.trellis, { command: "trellis", args: ["mcp-gateway", "--agent", "pi"] });
  assert.deepEqual(written.mcpServers.figma, { url: "https://mcp.figma.com/mcp" });

  const second = await adapter.plan(canonical);
  assert.deepEqual(second.filter((i) => i.kind === "mcp"), [], "idempotent once written");
});

test("bridge migration: the symlink removal rides the same plan, ordered after the config write", async () => {
  const home = scratchHome();
  const bridgePath = seedBridgeSymlink(home);
  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);
  const plan = await adapter.plan(canonical);

  const mcpItems = plan.filter((i) => i.kind === "mcp");
  const removal = mcpItems[mcpItems.length - 1];
  assert.equal(removal.action, "remove");
  assert.equal(removal.target, bridgePath);
  assert.equal(removal.mcpRemove, undefined, "not a config-key removal — apply must route it to the symlink");

  const backup = openBackupSession(home, "test-pi-migrate");
  await adapter.apply(mcpItems, backup);
  backup.finalize();

  assert.equal(existsSync(join(home, ".pi", "agent", "mcp.json")), true, "config written");
  assert.equal(lstatSync(bridgePath, { throwIfNoEntry: false }), undefined, "bridge symlink removed");
});

test("bridge migration: a plan conflict keeps the bridge in place", async () => {
  // The trellis entry colliding with a host-injected name means the
  // config write cannot happen — removing the bridge anyway would leave
  // pi with no MCP delivery at all (design.md D3).
  const home = scratchHome(`${GATEWAY_YAML}\nknown_host_injected: [trellis]\n`);
  const bridgePath = seedBridgeSymlink(home);
  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);
  const plan = await adapter.plan(canonical);

  const mcpItems = plan.filter((i) => i.kind === "mcp");
  assert.equal(mcpItems.length, 1);
  assert.equal(mcpItems[0].action, "conflict");

  const backup = openBackupSession(home, "test-pi-conflict");
  await adapter.apply(mcpItems, backup);
  backup.finalize();
  assert.equal(existsSync(join(home, ".pi", "agent", "mcp.json")), false, "no config written on conflict");
  assert.equal(readlinkSync(bridgePath), bridgeBundlePath(), "bridge untouched");
});

test("bridge migration: a foreign symlink at the bridge path is never removed", async () => {
  const home = scratchHome();
  const foreign = join(home, "user-own-extension.js");
  writeFileSync(foreign, "// the user's own file\n");
  const link = join(home, ".pi", "agent", "extensions", "trellis-mcp-bridge.js");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(foreign, link);

  const canonical = loadCanonicalSource(home);
  const plan = await new PiAdapter(home, NATIVE).plan(canonical);
  assert.equal(plan.filter((i) => i.kind === "mcp" && i.action === "remove" && !i.mcpRemove).length, 0);
  assert.equal(readlinkSync(link), foreign);
});

test("hub route: the hub endpoint entry is written and nothing else", async () => {
  const home = scratchHome(`
servers:
  harness-solo:
    transport: stdio
    command: /usr/local/bin/harness
hub:
  url: https://hub.example.com/mcp
routes:
  pi:
    mode: hub
`);
  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);
  const plan = await adapter.plan(canonical);
  const mcpItems = plan.filter((i) => i.kind === "mcp");
  assert.deepEqual(mcpItems.map((i) => i.mcpWrite?.name), ["trellis-hub"]);

  const backup = openBackupSession(home, "test-pi-hub");
  await adapter.apply(mcpItems, backup);
  backup.finalize();
  assert.deepEqual(readMcpJson(home).mcpServers, { "trellis-hub": { url: "https://hub.example.com/mcp" } });
});

test("sse servers become an honest conflict, not an entry pi cannot connect", async () => {
  const home = scratchHome(`
servers:
  legacy-events:
    transport: sse
    url: https://example.com/sse
routes:
  pi:
    mode: direct
    servers: [legacy-events]
`);
  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);
  const plan = await adapter.plan(canonical);
  const conflict = plan.find((i) => i.kind === "mcp" && i.action === "conflict");
  assert.match(conflict?.description ?? "", /sse transport/);

  const backup = openBackupSession(home, "test-pi-sse");
  await adapter.apply(plan.filter((i) => i.kind === "mcp"), backup);
  backup.finalize();
  assert.equal(existsSync(join(home, ".pi", "agent", "mcp.json")), false);
});

test("legacy branch: pi < 1.1.0 plans the bridge extension and never touches mcp.json", async () => {
  const home = scratchHome();
  const canonical = loadCanonicalSource(home);

  for (const versionProbe of [LEGACY, () => undefined]) {
    const plan = await new PiAdapter(home, versionProbe).plan(canonical);
    assert.equal(plan.filter((i) => i.kind === "mcp").length, 0);
    const extension = plan.filter((i) => i.kind === "extension");
    assert.equal(extension.length, 1);
    assert.equal(extension[0].action, "create");
    assert.ok(extension[0].linkTarget?.includes("pi-bridge"));
  }
  assert.equal(existsSync(join(home, ".pi", "agent", "mcp.json")), false);
});

test("ownership: a Trellis-written entry that left canonical is removed, user entries never are", async () => {
  const home = scratchHome();
  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);
  const backup = openBackupSession(home, "test-pi-ownership");
  await adapter.apply((await adapter.plan(canonical)).filter((i) => i.kind === "mcp"), backup);
  backup.finalize();

  // figma leaves pi's scope; the user adds their own server meanwhile.
  const configPath = join(home, ".pi", "agent", "mcp.json");
  const current = readMcpJson(home);
  current.mcpServers.mailbox = { command: "node", args: ["/user/own/mailbox.js"] };
  writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n");

  const narrowed = loadCanonicalSource(scratchHome2(home, GATEWAY_YAML.replace("servers: [harness-solo, figma, sentry]", "servers: [harness-solo, sentry]")));
  const plan = await adapter.plan(narrowed);
  const removals = plan.filter((i) => i.kind === "mcp" && i.action === "remove" && i.mcpRemove);
  assert.deepEqual(removals.map((i) => i.mcpRemove?.name), ["figma"]);

  const backup2 = openBackupSession(home, "test-pi-ownership-2");
  await adapter.apply(plan.filter((i) => i.kind === "mcp"), backup2);
  backup2.finalize();
  const after = readMcpJson(home);
  assert.equal(after.mcpServers.figma, undefined);
  assert.ok(after.mcpServers.mailbox, "user entry survives the removal pass");
  assert.ok(after.mcpServers.trellis, "still-wanted entry survives");
});

/** Re-point canonical at the same home with edited servers.yaml. */
function scratchHome2(home: string, serversYaml: string): string {
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  return home;
}

test("oauth client_name: the Trellis-written oauth block survives the next plan (no strip-and-drift)", async () => {
  // Regression for the Figma DCR allowlist fix (oauth-client-name tasks.md
  // 2.2): without renderer support, jsonMcp's deepEqual would see pi's
  // `oauth.clientName` as drift and strip it on the next sync.
  const home = scratchHome(GATEWAY_YAML.replace("    auth: oauth\n", "    auth:\n      kind: oauth\n      client_name: Claude Code\n"));
  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);

  const backup = openBackupSession(home, "test-pi-client-name");
  await adapter.apply((await adapter.plan(canonical)).filter((i) => i.kind === "mcp"), backup);
  backup.finalize();

  assert.deepEqual(readMcpJson(home).mcpServers.figma, {
    url: "https://mcp.figma.com/mcp",
    oauth: { clientName: "Claude Code" },
  });
  const second = await adapter.plan(canonical);
  assert.deepEqual(second.filter((i) => i.kind === "mcp"), [], "converged — the oauth block is Trellis-owned content");
  assert.deepEqual(await adapter.verify(canonical), { ok: true });
});

test("verify: clean native state is ok; missing entry, stale bridge and drifted config are reported", async () => {
  const home = scratchHome();
  const canonical = loadCanonicalSource(home);
  const adapter = new PiAdapter(home, NATIVE);

  const before = await adapter.verify(canonical);
  assert.equal(before.ok, false);
  assert.ok(before.mismatches.some((m) => m.includes("trellis")), "mcp.json entries missing before first sync");

  const backup = openBackupSession(home, "test-pi-verify");
  await adapter.apply((await adapter.plan(canonical)).filter((i) => i.kind === "mcp"), backup);
  backup.finalize();
  assert.deepEqual(await adapter.verify(canonical), { ok: true });

  const configPath = join(home, ".pi", "agent", "mcp.json");
  const drifted = readMcpJson(home);
  delete drifted.mcpServers.figma;
  writeFileSync(configPath, JSON.stringify(drifted, null, 2) + "\n");
  seedBridgeSymlink(home);

  const after = await adapter.verify(canonical);
  assert.equal(after.ok, false);
  assert.ok(after.mismatches.some((m) => m.includes("figma")), "deleted entry reported");
  assert.ok(after.mismatches.some((m) => m.includes("bridge")), "resurrected bridge reported");
});
