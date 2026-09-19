/**
 * pi extension entry point (trellis-pi-mcp-bridge-p4). Delivered by
 * symlinking this exact file into `~/.pi/agent/extensions/`
 * (src/adapters/pi.ts) — pi's own directory-based auto-discovery loads
 * it with zero settings.json involvement (design.md D1).
 *
 * Deliberately duck-typed against pi's extension API (no dependency on
 * `@earendil-works/pi-coding-agent` itself — this file must work
 * regardless of which pi version is installed on a given machine, and a
 * type-only import would still require that package to be resolvable
 * from Trellis's own install tree). Only the handful of fields/methods
 * this bridge actually uses are declared here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TSchema } from "typebox";
import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import { resolveMcpPlan } from "../adapters/mcpPlan.js";
import { connectServer, withTimeout, DEFAULT_CONNECT_TIMEOUT_MS, type McpClientInfo } from "../lib/mcpConnect.js";
import { McpToolRegistry, type AggregatedTool } from "../lib/mcpToolRegistry.js";
import { withOAuthHeader } from "../lib/gatewayBackend.js";
import { ALL_AGENTS } from "../core/types.js";
import { toParametersSchema, toPiContent, type McpContentItem } from "./schemaTranslate.js";

/** Re-exported so `trellis-mcp-connect-timeout`'s existing test keeps
 * importing it from the module it was written against — proving the
 * extraction changed nothing it could observe. */
export { withTimeout };

interface PiToolResult {
  content: ReturnType<typeof toPiContent>;
  details: unknown;
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<PiToolResult>;
}

interface PiExtensionAPI {
  registerTool(tool: PiToolDefinition): void;
  on?(event: "session_shutdown", handler: () => Promise<void> | void): void;
}

const CLIENT_INFO: McpClientInfo = { name: "trellis-mcp-bridge", version: "0.0.0" };

function listServerTools(client: Client, timeoutMs: number): Promise<readonly AggregatedTool[]> {
  return withTimeout(client.listTools(), timeoutMs, `listTools timed out after ${timeoutMs}ms`).then((result) => result.tools);
}

/**
 * `homeDir`/`connectTimeoutMs` default to the real `~` / 10s — only
 * overridable for tests, same seam every other Trellis entry point
 * uses. Neither is something pi itself ever passes; this factory's own
 * signature matches pi's `ExtensionFactory = (pi) => void | Promise<void>`
 * exactly (both trailing params have defaults, so calling it as
 * `factory(pi)` — what pi actually does — works unchanged).
 */
export default async function trellisMcpBridge(
  pi: PiExtensionAPI,
  homeDir: string = homedir(),
  connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<void> {
  const canonical = loadCanonicalSource(homeDir);
  // Deliberately ALL_AGENTS, not canonical.managedAgents: this bridge only
  // ever runs because pi itself loaded the extension — that's already the
  // strongest possible consent signal (trellis-managed-agents design.md),
  // independent of whether `trellis onboard` was ever run to add pi to
  // managed.yaml. managedAgents governs static config-file writes; this
  // is pi reading canonical directly at its own runtime, P4's own concern.
  const { desired } = resolveMcpPlan("pi", canonical.mcp, ALL_AGENTS, canonical.secretsPolicy);
  const clients = new Set<Client>();
  const registry = new McpToolRegistry();

  const closeClient = async (client: Client): Promise<void> => {
    if (!clients.delete(client)) return;
    try {
      await client.close();
    } catch (err) {
      // Cleanup is best-effort; one transport must not block other servers.
      console.error(`trellis-mcp-bridge: failed to close MCP client: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const closeAllClients = async (): Promise<void> => {
    const pending = [...clients];
    clients.clear();
    await Promise.all(
      pending.map(async (client) => {
        try {
          await client.close();
        } catch (err) {
          console.error(`trellis-mcp-bridge: failed to close MCP client: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  };

  // pi 0.85.x emits this before tearing down an extension runtime. Keep the
  // hook optional so the bridge remains loadable in older compatible hosts.
  pi.on?.("session_shutdown", closeAllClients);

  const discovered = await Promise.all(
    desired.map(async ({ name, def }) => {
      let client: Client;
      try {
        const effectiveDef = def.auth === "oauth" && def.url
          ? await withOAuthHeader(name, def, homeDir)
          : def;
        client = await connectServer(effectiveDef, canonical.secretsPolicy, connectTimeoutMs, CLIENT_INFO);
      } catch (err) {
        // One unreachable/misconfigured (including permanently hanging —
        // trellis-mcp-connect-timeout) server must never prevent every
        // other server's tools from registering (tasks.md 3.2).
        console.error(`trellis-mcp-bridge: failed to connect to MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
      clients.add(client);
      try {
        const tools = await listServerTools(client, connectTimeoutMs);
        return { name, client, tools };
      } catch (err) {
        console.error(`trellis-mcp-bridge: failed to list tools for MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
        await closeClient(client);
        return undefined;
      }
    }),
  );

  // Add in canonical plan order, not completion order, so allocation remains
  // stable when multiple upstreams answer concurrently.
  for (const result of discovered) {
    if (!result) continue;
    registry.add(result.name, result.client, result.tools);
  }

  for (const tool of registry.listTools()) {
    const target = registry.resolve(tool.name);
    if (!target) continue;
    const originalName = target.toolName;
    const serverName = target.serverName;
    pi.registerTool({
      name: tool.name,
      label: originalName,
      description: tool.description ?? `MCP tool "${originalName}" from server "${serverName}"`,
      parameters: toParametersSchema(tool.inputSchema),
      async execute(_toolCallId, params) {
        const result = await registry.callTool(tool.name, params);
        const content = Array.isArray((result as { content?: unknown }).content)
          ? (result as { content: McpContentItem[] }).content
          : [];
        return { content: toPiContent(content), details: result };
      },
    });
  }
}
