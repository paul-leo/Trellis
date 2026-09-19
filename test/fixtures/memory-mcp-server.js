#!/usr/bin/env node
/**
 * Deterministic local-memory MCP fixture for the isolated acceptance lab.
 * It follows the small subset of @modelcontextprotocol/server-memory's
 * entity/search/delete contract that the lab needs, persists the same JSONL
 * graph shape, and never reaches the network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const graphPath = (process.env.MEMORY_FILE_PATH ?? "/tmp/trellis-memory-graph.jsonl").replace(/^~(?=$|\/)/, process.env.HOME ?? "");

function readGraph() {
  if (!existsSync(graphPath)) return [];
  return readFileSync(graphPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value?.type === "entity" || value?.type === "relation" ? [value] : [];
      } catch {
        return [];
      }
    });
}

function writeGraph(lines) {
  mkdirSync(dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, lines.length > 0 ? `${lines.map((line) => JSON.stringify(line)).join("\n")}\n` : "");
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function toolResult(id, value) {
  result(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
}

function tools() {
  return [
    {
      name: "create_entities",
      description: "Create shared memory entities",
      inputSchema: { type: "object", properties: { entities: { type: "array" } }, required: ["entities"] },
    },
    {
      name: "search_nodes",
      description: "Search shared memory entities",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "open_nodes",
      description: "Read shared memory entities",
      inputSchema: { type: "object", properties: { names: { type: "array" } }, required: ["names"] },
    },
    {
      name: "delete_entities",
      description: "Delete shared memory entities",
      inputSchema: { type: "object", properties: { entityNames: { type: "array" } }, required: ["entityNames"] },
    },
  ];
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      result(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "trellis-memory-fixture", version: "0.0.1" },
      });
    } else if (message.method === "tools/list") {
      result(message.id, { tools: tools() });
    } else if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const graph = readGraph();
      if (name === "create_entities") {
        const names = new Set((args.entities ?? []).map((entity) => entity.name));
        const next = graph.filter((line) => line.type !== "entity" || !names.has(line.name));
        writeGraph([...next, ...(args.entities ?? []).map((entity) => ({ type: "entity", ...entity }))]);
        toolResult(message.id, { entities: args.entities ?? [] });
      } else if (name === "search_nodes") {
        const query = String(args.query ?? "").toLowerCase();
        const entities = graph.filter((line) => line.type === "entity" && `${line.name}\n${(line.observations ?? []).join("\n")}`.toLowerCase().includes(query));
        toolResult(message.id, { entities, relations: graph.filter((line) => line.type === "relation") });
      } else if (name === "open_nodes") {
        const names = new Set(args.names ?? []);
        toolResult(message.id, { entities: graph.filter((line) => line.type === "entity" && names.has(line.name)), relations: graph.filter((line) => line.type === "relation") });
      } else if (name === "delete_entities") {
        const names = new Set(args.entityNames ?? []);
        writeGraph(graph.filter((line) => line.type !== "entity" || !names.has(line.name)));
        toolResult(message.id, { deleted: [...names] });
      } else {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown tool ${name}` } })}\n`);
      }
    }
  }
});
