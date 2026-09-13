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
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TSchema } from "typebox";
import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import { resolveMcpPlan } from "../adapters/mcpPlan.js";
import { resolveSecretEnv } from "../lib/secretEnv.js";
import { extractTemplateVarNames } from "../lib/envVarNames.js";
import { ALL_AGENTS } from "../core/types.js";
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
  on?(event: "session_shutdown", handler: () => Promise<void> | void): void;
}

const CLIENT_INFO = { name: "trellis-mcp-bridge", version: "0.0.0" };
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * A hanging server (process alive, protocol response never sent) leaves
 * `promise` permanently unsettled — indistinguishable from "still
 * starting up" without a bound. Racing against a timeout converts that
 * into an ordinary rejection, which every caller here already knows how
 * to isolate (design.md D1, trellis-mcp-connect-timeout).
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * A timed-out (or otherwise failed) connect attempt must not leak the
 * transport's own resources — for `StdioClientTransport` specifically,
 * an unclosed transport means an orphaned child process that outlives
 * this failed attempt indefinitely (confirmed by a real leaked
 * subprocess during this change's own test run). `transport.close()` is
 * best-effort: a transport that never fully connected may itself error
 * on close, but the original connect failure is what the caller needs
 * to see, not a secondary cleanup error.
 */
async function connectWithCleanup(client: Client, transport: Transport, timeoutMs: number, message: string): Promise<Client> {
  try {
    await withTimeout(client.connect(transport), timeoutMs, message);
    return client;
  } catch (err) {
    try {
      await transport.close();
    } catch {
      // best-effort; the original connect failure is what matters
    }
    throw err;
  }
}

async function connectStdio(def: McpServerDef, secretsPolicy: SecretsPolicy, timeoutMs: number): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const envAliases = def.envAliases ?? {};
  // `envAliases`' values are source variable names — resolved through the
  // exact same call as `env`'s own names, never delivered as the raw
  // `${sourceName}` placeholder text a consumer with no `${VAR}` runtime
  // of its own (like this bridge) would otherwise crash on parsing
  // (trellis-migrate-env-var-alias, the real notion-on-pi bug).
  const resolved = resolveSecretEnv([...(def.env ?? []), ...Object.values(envAliases)], secretsPolicy);
  const namedEnv = Object.fromEntries((def.env ?? []).map((name) => [name, resolved[name] ?? ""]));
  const aliasEnv = Object.fromEntries(Object.entries(envAliases).map(([targetKey, sourceName]) => [targetKey, resolved[sourceName] ?? ""]));
  const transport = new StdioClientTransport({
    command: def.command!,
    args: def.args,
    // staticEnv merges last: a literal, intentionally-plain value (an
    // email, an environment tag) always wins over an unresolved name-only
    // entry's empty-string fallback for the same key — though in practice
    // resolveMcpPlan's D6 refusal never lets an unresolved name reach
    // this point at all (trellis-mcp-static-env-and-disabled-servers).
    env: { ...getDefaultEnvironment(), ...namedEnv, ...aliasEnv, ...(def.staticEnv ?? {}) },
  });
  return connectWithCleanup(client, transport as Transport, timeoutMs, `connect timed out after ${timeoutMs}ms`);
}

function resolveHeaders(def: McpServerDef, secretsPolicy: SecretsPolicy): Record<string, string> | undefined {
  if (!def.headers || Object.keys(def.headers).length === 0) return undefined;
  const names = Object.keys(def.headers).flatMap((key) => extractTemplateVarNames(def.headers![key]));
  const resolved = resolveSecretEnv(names, secretsPolicy);
  const result: Record<string, string> = {};
  for (const [key, template] of Object.entries(def.headers)) {
    result[key] = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => resolved[name] ?? "");
  }
  return result;
}

async function connectHttp(def: McpServerDef, secretsPolicy: SecretsPolicy, timeoutMs: number): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const headers = resolveHeaders(def, secretsPolicy);
  const opts = headers ? { requestInit: { headers } } : undefined;
  return connectWithCleanup(
    client,
    new StreamableHTTPClientTransport(new URL(def.url!), opts) as Transport,
    timeoutMs,
    `connect timed out after ${timeoutMs}ms`,
  );
}

async function connectSse(def: McpServerDef, secretsPolicy: SecretsPolicy, timeoutMs: number): Promise<Client> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const headers = resolveHeaders(def, secretsPolicy);
  const opts = headers ? { requestInit: { headers } } : undefined;
  return connectWithCleanup(
    client,
    new SSEClientTransport(new URL(def.url!), opts) as Transport,
    timeoutMs,
    `connect timed out after ${timeoutMs}ms`,
  );
}

function registerServerTools(pi: PiExtensionAPI, serverName: string, client: Client, timeoutMs: number): Promise<void> {
  return withTimeout(client.listTools(), timeoutMs, `listTools timed out after ${timeoutMs}ms`).then((result) => {
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

  await Promise.all(
    desired.map(async ({ name, def }) => {
      let client: Client;
      try {
        if (def.transport === "http") {
          client = await connectHttp(def, canonical.secretsPolicy, connectTimeoutMs);
        } else if (def.transport === "sse") {
          client = await connectSse(def, canonical.secretsPolicy, connectTimeoutMs);
        } else {
          client = await connectStdio(def, canonical.secretsPolicy, connectTimeoutMs);
        }
      } catch (err) {
        // One unreachable/misconfigured (including permanently hanging —
        // trellis-mcp-connect-timeout) server must never prevent every
        // other server's tools from registering (tasks.md 3.2).
        console.error(`trellis-mcp-bridge: failed to connect to MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      clients.add(client);
      try {
        await registerServerTools(pi, name, client, connectTimeoutMs);
      } catch (err) {
        console.error(`trellis-mcp-bridge: failed to list tools for MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
        await closeClient(client);
      }
    }),
  );
}
