/**
 * `trellis mcp-gateway --agent <id>` — the stdio MCP server an agent
 * spawns in gateway mode (trellis-mcp-gateway-hosting).
 *
 * Not a user-facing command in the usual sense: nobody types this. An
 * agent's own MCP client spawns it exactly the way it spawns any other
 * stdio server, talks to it for the session, and closes the pipe on exit
 * (design.md D2). There is no daemon, no lifecycle command, and nothing
 * for the user to notice.
 *
 * This file depends on `GatewayBackend` and nothing below it — no
 * connection, no transport, no server definition (design.md D11). That is
 * what lets v2 point the same stdio edge at one shared service instead of
 * an in-process backend without this file, or any agent's config,
 * changing.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { loadCanonicalSource } from "../core/canonical.js";
import { isGatewayAgent, isOAuthMcpServer, resolveMcpPlan } from "../adapters/mcpPlan.js";
import { LocalBackend, type GatewayBackend, type UpstreamSpec } from "../lib/gatewayBackend.js";
import { DEFAULT_CONNECT_TIMEOUT_MS, type McpClientInfo } from "../lib/mcpConnect.js";
import { BuiltinRegistry, createRuntimeServer, UpstreamProvider } from "../lib/mcpRuntime.js";
import { McpStatusProvider } from "../lib/mcpStatusProvider.js";
import { RuntimeControlProvider } from "../lib/runtimeControlProvider.js";
import { TaskProvider } from "../lib/taskProvider.js";
import { RuntimeMemoryProvider } from "../lib/memoryProvider.js";
import { SkillProvider } from "../lib/skillProvider.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId } from "../core/types.js";

const CLIENT_INFO: McpClientInfo = { name: "trellis-mcp-gateway", version: "0.0.0" };
const SERVER_INFO = { name: "trellis-mcp-gateway", version: "0.0.0" };
const RUNTIME_CLIENT_INFO: McpClientInfo = { name: "trellis-mcp-runtime", version: "0.0.0" };
const RUNTIME_SERVER_INFO = { name: "trellis-mcp-runtime", version: "0.0.0" };

export interface RunMcpGatewayOptions {
  agentId: AgentId;
  /** Test seams, exactly as every other Trellis entry point exposes them. */
  homeDir?: string;
  connectTimeoutMs?: number;
  /** Injected so tests can drive the protocol edge without real upstreams,
   * and so v2 can substitute a forwarding backend (design.md D11). */
  backendFactory?: (upstreams: UpstreamSpec[], homeDir: string) => Promise<GatewayBackend>;
}

export function parseMcpGatewayArgs(argv: readonly string[]): { agentId: AgentId } | { error: string } {
  const index = argv.indexOf("--agent");
  if (index === -1 || index === argv.length - 1) {
    return { error: `mcp-gateway requires --agent <${ALL_AGENTS.join("|")}>` };
  }
  const value = argv[index + 1];
  if (!(ALL_AGENTS as readonly string[]).includes(value)) {
    return { error: `unknown agent "${value}" — expected one of ${ALL_AGENTS.join(", ")}` };
  }
  return { agentId: value as AgentId };
}

/**
 * The in-scope upstream set for this agent, resolved through the very same
 * `resolveMcpPlan` that direct mode uses — per-server `agents:` scope,
 * `enabled: false`, host-injected collisions, literal-secret refusals and
 * unresolved `env` names all apply here identically, because it is
 * literally the same function (design.md D6).
 *
 * The one thing that must be stripped is gateway mode itself: asking
 * `resolveMcpPlan` for this agent's plan while gateway mode is on would
 * answer "one entry, pointing at the gateway" — the gateway being told to
 * connect to itself. Resolving against a gateway-less view of the same
 * canonical gives the set gateway mode replaced.
 */
export function resolveGatewayUpstreams(
  agentId: AgentId,
  canonical: Pick<ReturnType<typeof loadCanonicalSource>, "mcp" | "managedAgents" | "secretsPolicy">,
): { upstreams: UpstreamSpec[]; conflicts: string[] } {
  const route = canonical.mcp.routes?.[agentId];
  const hubActive = route ? route.mode === "hub" : Boolean(canonical.mcp.hub) && !isGatewayAgent(agentId, canonical.mcp, canonical.managedAgents);
  if (hubActive) {
    return { upstreams: [], conflicts: [] };
  }
  const directRoutes = canonical.mcp.routes && route
    ? { ...canonical.mcp.routes, [agentId]: { mode: "direct" as const, ...(route.servers ? { servers: route.servers } : {}) } }
    : canonical.mcp.routes;
  const ordinaryServers = Object.fromEntries(Object.entries(canonical.mcp.servers).filter(([, def]) => !isOAuthMcpServer(def)));
  const direct = { ...canonical.mcp, servers: ordinaryServers, gateway: undefined, hub: undefined, routes: directRoutes, runtime: undefined };
  // The managed set is passed through unchanged, so an unmanaged agent
  // reaches nothing. Being spawned is NOT treated as consent here, which
  // is a deliberate divergence from `src/pi-bridge/index.ts` (which passes
  // ALL_AGENTS on the grounds that pi loading the extension is itself the
  // signal). The triggers differ: pi's bridge only exists on disk because
  // Trellis symlinked it into pi's own directory while pi was managed, so
  // its presence IS the marker. A gateway entry, by contrast, outlives
  // un-managing — it sits in the agent's config until a later sync's
  // ownership-gated removal clears it. Serving that stale entry would hand
  // every server, and every secret resolved into it, to the one agent the
  // user just said to stop involving.
  const { desired, conflicts } = resolveMcpPlan(agentId, direct, canonical.managedAgents, canonical.secretsPolicy);
  return {
    upstreams: desired.map(({ name, def }) => ({ name, def })),
    conflicts: conflicts.map((conflict) => conflict.message),
  };
}

export async function runMcpGateway(opts: RunMcpGatewayOptions): Promise<{ exitCode: number }> {
  return runMcpEdge(opts, CLIENT_INFO, SERVER_INFO);
}

/** The first-class runtime entrypoint. mcp-gateway remains a compatibility
 * alias for existing native agent config, but both edges use the same
 * provider registry and backend construction path. */
export async function runMcpRuntime(opts: RunMcpGatewayOptions): Promise<{ exitCode: number }> {
  return runMcpEdge(opts, RUNTIME_CLIENT_INFO, RUNTIME_SERVER_INFO);
}

async function runMcpEdge(
  opts: RunMcpGatewayOptions,
  clientInfo: McpClientInfo,
  serverInfo: { name: string; version: string },
): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let canonical: ReturnType<typeof loadCanonicalSource>;
  try {
    canonical = loadCanonicalSource(homeDir);
  } catch (err) {
    // stderr, never stdout: stdout IS the MCP protocol stream here, and a
    // stray line on it corrupts the agent's parser rather than informing
    // anyone.
    console.error(`trellis-mcp-gateway: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1 };
  }

  const { upstreams, conflicts } = resolveGatewayUpstreams(opts.agentId, canonical);
  for (const message of conflicts) {
    console.error(`trellis-mcp-gateway: ${message}`);
  }

  const backend = opts.backendFactory
    ? await opts.backendFactory(upstreams, homeDir)
    : await LocalBackend.connect(upstreams, {
        secretsPolicy: canonical.secretsPolicy,
        clientInfo,
        connectTimeoutMs,
        // Enables silent OAuth refresh-before-connect. Never an
        // interactive grant: that is `trellis mcp auth`'s job, and this
        // process has no terminal to run one in (design.md D9).
        homeDir,
      });

  const registry = new BuiltinRegistry([new SkillProvider(), new RuntimeMemoryProvider(), new RuntimeControlProvider(backend), new McpStatusProvider(backend), new TaskProvider(), new UpstreamProvider(backend)]);
  const server = createRuntimeServer(serverInfo, { agentId: opts.agentId, homeDir }, registry);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await waitForShutdown(registry, server);
  return { exitCode: 0 };
}

/**
 * Teardown on client disconnect — the piece neither layer below provides.
 *
 * `StdioServerTransport.start()` registers listeners for `'data'` and
 * `'error'` only, so stdin reaching EOF never reaches `onclose`; and POSIX
 * re-parents an orphan to launchd rather than killing it, while this
 * process's own event loop is held open by every upstream it connected.
 * Without this, each agent session would permanently leak a gateway plus
 * its entire upstream process set (design.md D13).
 */
function waitForShutdown(registry: BuiltinRegistry, server: Awaited<ReturnType<typeof createRuntimeServer>>): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const shutdown = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        await registry.close();
      } catch (err) {
        console.error(`trellis-mcp-gateway: failed to close backend: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await server.close();
      } catch {
        // best-effort; the process is going away regardless
      }
      resolve();
    };

    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(signal, shutdown);
    }
  });
}
