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
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TSchema } from "typebox";
import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import { resolveMcpPlan } from "../adapters/mcpPlan.js";
import { resolveSecretEnv } from "../lib/secretEnv.js";
import type { McpServerDef, SecretsPolicy } from "../core/types.js";
import { bridgedToolName, toParametersSchema, toPiContent, type McpContentItem } from "./schemaTranslate.js";

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
}

const CLIENT_INFO = { name: "trellis-mcp-bridge", version: "0.0.0" };

async function connectStdio(def: McpServerDef, secretsPolicy: SecretsPolicy): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const resolved = resolveSecretEnv(def.env ?? [], secretsPolicy);
  const namedEnv = Object.fromEntries((def.env ?? []).map((name) => [name, resolved[name] ?? ""]));
  const transport = new StdioClientTransport({
    command: def.command!,
    args: def.args,
    env: { ...getDefaultEnvironment(), ...namedEnv },
  });
  await client.connect(transport as Transport);
  return client;
}

async function connectHttp(url: string): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);
  return client;
}

function registerServerTools(pi: PiExtensionAPI, serverName: string, client: Client): Promise<void> {
  return client.listTools().then((result) => {
    for (const tool of result.tools) {
      pi.registerTool({
        name: bridgedToolName(serverName, tool.name),
        label: tool.name,
        description: tool.description ?? `MCP tool "${tool.name}" from server "${serverName}"`,
        parameters: toParametersSchema(tool.inputSchema),
        async execute(_toolCallId, params) {
          const result = await client.callTool({ name: tool.name, arguments: params });
          const content = Array.isArray(result.content) ? (result.content as McpContentItem[]) : [];
          return { content: toPiContent(content), details: result };
        },
      });
    }
  });
}

/**
 * `homeDir` defaults to the real `~` — only overridable for tests, same
 * seam every other Trellis entry point uses. Not something pi itself
 * ever passes; this factory's own signature matches pi's
 * `ExtensionFactory = (pi) => void | Promise<void>` exactly (`homeDir`
 * has a default, so calling it as `factory(pi)` — what pi actually does
 * — works unchanged).
 */
export default async function trellisMcpBridge(pi: PiExtensionAPI, homeDir: string = homedir()): Promise<void> {
  const canonical = loadCanonicalSource(homeDir);
  const { desired } = resolveMcpPlan("pi", canonical.mcp);

  await Promise.all(
    desired.map(async ({ name, def }) => {
      let client: Client;
      try {
        client = def.transport === "http" ? await connectHttp(def.url!) : await connectStdio(def, canonical.secretsPolicy);
      } catch (err) {
        // One unreachable/misconfigured server must never prevent every
        // other server's tools from registering (tasks.md 3.2).
        console.error(`trellis-mcp-bridge: failed to connect to MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      try {
        await registerServerTools(pi, name, client);
      } catch (err) {
        console.error(`trellis-mcp-bridge: failed to list tools for MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}
