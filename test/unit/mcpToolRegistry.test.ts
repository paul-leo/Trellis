/**
 * Tool aggregation and routing (trellis-mcp-gateway-hosting tasks.md 1.4).
 *
 * The property under test is the one that would be invisible until it bit
 * someone in production: two upstreams exposing the same tool name must
 * stay distinguishable, and a call must reach the upstream that actually
 * owns it — never a same-named tool somewhere else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { McpToolRegistry, prefixedToolName, type AggregatedTool, type ToolUpstream } from "../../src/lib/mcpToolRegistry.js";

interface FakeUpstream extends ToolUpstream {
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

function fakeUpstream(id: string, tools: AggregatedTool[]): FakeUpstream {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  return {
    calls,
    async listTools() {
      return { tools };
    },
    async callTool(params) {
      calls.push(params);
      return { servedBy: id, tool: params.name };
    },
  };
}

test("prefixedToolName: produces `${server}__${tool}`", () => {
  assert.equal(prefixedToolName("alpha", "search"), "alpha__search");
});

test("registry: same-named tools on two upstreams stay distinguishable", async () => {
  const registry = new McpToolRegistry();
  registry.add("alpha", fakeUpstream("alpha", [{ name: "search" }]), [{ name: "search" }]);
  registry.add("beta", fakeUpstream("beta", [{ name: "search" }]), [{ name: "search" }]);

  const names = (await registry.listTools()).map((tool) => tool.name);
  assert.deepEqual(names, ["alpha__search", "beta__search"]);
});

test("registry: a call routes to its own upstream, not a same-named tool elsewhere", async () => {
  const alpha = fakeUpstream("alpha", [{ name: "search" }]);
  const beta = fakeUpstream("beta", [{ name: "search" }]);
  const registry = new McpToolRegistry();
  registry.add("alpha", alpha, [{ name: "search" }]);
  registry.add("beta", beta, [{ name: "search" }]);

  const result = await registry.callTool("beta__search", { q: "x" });

  assert.deepEqual(result, { servedBy: "beta", tool: "search" });
  assert.equal(alpha.calls.length, 0, "alpha must not have been called at all");
  // The upstream is called by its OWN tool name — it has never heard of
  // the aggregated one.
  assert.deepEqual(beta.calls, [{ name: "search", arguments: { q: "x" } }]);
});

test("registry: an unknown tool name throws rather than guessing an upstream", async () => {
  const registry = new McpToolRegistry();
  registry.add("alpha", fakeUpstream("alpha", [{ name: "search" }]), [{ name: "search" }]);

  await assert.rejects(() => registry.callTool("gamma__search"), /unknown tool "gamma__search"/);
});

test("registry: one upstream contributing nothing doesn't block the others' aggregation", async () => {
  const registry = new McpToolRegistry();
  // A failed upstream is simply never added — this is what the caller does
  // when connect or listTools throws, and the registry needs no awareness
  // of it for the survivors to aggregate normally.
  registry.add("alpha", fakeUpstream("alpha", [{ name: "one" }]), [{ name: "one" }]);
  registry.add("gamma", fakeUpstream("gamma", [{ name: "three" }]), [{ name: "three" }]);

  const names = (await registry.listTools()).map((tool) => tool.name);
  assert.deepEqual(names, ["alpha__one", "gamma__three"]);
  assert.deepEqual(registry.servers(), ["alpha", "gamma"]);
});

test("registry: a tool's description and inputSchema pass through untouched; only the name is prefixed", async () => {
  const schema = { type: "object", properties: { q: { type: "string" } } };
  const registry = new McpToolRegistry();
  registry.add("alpha", fakeUpstream("alpha", []), [{ name: "search", description: "Find things", inputSchema: schema, annotations: { readOnly: true } }]);

  const [tool] = await registry.listTools();
  assert.equal(tool.name, "alpha__search");
  assert.equal(tool.description, "Find things");
  assert.deepEqual(tool.inputSchema, schema);
  // Fields this registry doesn't model must survive the round trip rather
  // than being silently dropped on the way to the agent.
  assert.deepEqual(tool.annotations, { readOnly: true });
});

test("registry: a prefixed-name collision keeps the first registration and reports the second", async () => {
  // Reachable when a server name itself contains the separator: server
  // "a"'s tool "b__c" and server "a__b"'s tool "c" both want "a__b__c".
  const first = fakeUpstream("first", []);
  const second = fakeUpstream("second", []);
  const registry = new McpToolRegistry();
  registry.add("a", first, [{ name: "b__c" }]);
  const result = registry.add("a__b", second, [{ name: "c" }]);

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.skipped, ["a__b__c"]);
  assert.equal(registry.size, 1);

  await registry.callTool("a__b__c");
  assert.equal(first.calls.length, 1, "the first registration keeps the name");
  assert.equal(second.calls.length, 0, "the colliding registration must not silently steal it");
});
