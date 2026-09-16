/**
 * Agent-agnostic MCP upstream connection logic, extracted verbatim from
 * `src/pi-bridge/index.ts` (trellis-mcp-gateway-hosting design.md D3).
 *
 * Everything here carries real bug-fix history — the leaked-child-process
 * -on-timeout fix (trellis-mcp-connect-timeout), the envAliases literal
 * -placeholder fix (trellis-migrate-env-var-alias) — which is exactly why
 * it lives in one module rather than being reimplemented for the gateway:
 * a future fix to either has to land once, not be remembered twice.
 *
 * Deliberately free of any consumer's concerns. Nothing here logs, decides
 * which servers are in scope, or knows what a tool is; callers isolate
 * failures in whatever way suits them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveSecretEnv } from "./secretEnv.js";
import { extractTemplateVarNames } from "./envVarNames.js";
import type { McpServerDef, SecretsPolicy } from "../core/types.js";

/** What an MCP upstream is told this client is. Each consumer passes its
 * own so an upstream's logs name the thing that actually connected. */
export interface McpClientInfo {
  name: string;
  version: string;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

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
export async function connectWithCleanup(client: Client, transport: Transport, timeoutMs: number, message: string): Promise<Client> {
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

export async function connectStdio(
  def: McpServerDef,
  secretsPolicy: SecretsPolicy,
  timeoutMs: number,
  clientInfo: McpClientInfo,
): Promise<Client> {
  const client = new Client(clientInfo, { capabilities: {} });
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

export function resolveHeaders(def: McpServerDef, secretsPolicy: SecretsPolicy): Record<string, string> | undefined {
  if (!def.headers || Object.keys(def.headers).length === 0) return undefined;
  const names = Object.keys(def.headers).flatMap((key) => extractTemplateVarNames(def.headers![key]));
  const resolved = resolveSecretEnv(names, secretsPolicy);
  const result: Record<string, string> = {};
  for (const [key, template] of Object.entries(def.headers)) {
    result[key] = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => resolved[name] ?? "");
  }
  return result;
}

export async function connectHttp(
  def: McpServerDef,
  secretsPolicy: SecretsPolicy,
  timeoutMs: number,
  clientInfo: McpClientInfo,
): Promise<Client> {
  const client = new Client(clientInfo, { capabilities: {} });
  const headers = resolveHeaders(def, secretsPolicy);
  const opts = headers ? { requestInit: { headers } } : undefined;
  return connectWithCleanup(
    client,
    new StreamableHTTPClientTransport(new URL(def.url!), opts) as Transport,
    timeoutMs,
    `connect timed out after ${timeoutMs}ms`,
  );
}

export async function connectSse(
  def: McpServerDef,
  secretsPolicy: SecretsPolicy,
  timeoutMs: number,
  clientInfo: McpClientInfo,
): Promise<Client> {
  const client = new Client(clientInfo, { capabilities: {} });
  const headers = resolveHeaders(def, secretsPolicy);
  const opts = headers ? { requestInit: { headers } } : undefined;
  return connectWithCleanup(
    client,
    new SSEClientTransport(new URL(def.url!), opts) as Transport,
    timeoutMs,
    `connect timed out after ${timeoutMs}ms`,
  );
}

/**
 * Transport dispatch, matching the original bridge's own ordering: `http`
 * and `sse` are explicit, everything else (including an absent
 * `transport`) is stdio — a default the canonical schema relies on.
 */
export function connectServer(
  def: McpServerDef,
  secretsPolicy: SecretsPolicy,
  timeoutMs: number,
  clientInfo: McpClientInfo,
): Promise<Client> {
  if (def.transport === "http") return connectHttp(def, secretsPolicy, timeoutMs, clientInfo);
  if (def.transport === "sse") return connectSse(def, secretsPolicy, timeoutMs, clientInfo);
  return connectStdio(def, secretsPolicy, timeoutMs, clientInfo);
}
