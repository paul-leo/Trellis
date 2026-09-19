import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isInScope } from "../core/adapter.js";
import type { AgentId, CanonicalSource, McpRouteMode } from "../core/types.js";
import { isGatewayAgent } from "../adapters/mcpPlan.js";
import type { UpstreamStatus } from "./gatewayBackend.js";

export interface MemoryReadiness {
  backendConfigured: boolean;
  graphPath?: string;
  graphExists: boolean;
  graphReadable: boolean;
  graphWritable: boolean;
  graphReady: boolean;
  canonicalCount: number;
  deliveredAgents: AgentId[];
  writePath: "mcp" | "unavailable";
  extractionCommand: "trellis memory extract";
  nativeImportSupported: false;
  upstream?: Pick<UpstreamStatus, "status" | "detail" | "remediation">;
}

function routeFor(agent: AgentId, canonical: CanonicalSource): McpRouteMode {
  const explicit = canonical.mcp.routes?.[agent];
  if (explicit) return explicit.mode;
  if (isGatewayAgent(agent, canonical.mcp, canonical.managedAgents)) return "gateway";
  if (canonical.mcp.hub) return "hub";
  return "direct";
}

function memoryDeliveredTo(agent: AgentId, canonical: CanonicalSource): boolean {
  const server = canonical.mcp.servers.memory;
  if (!server || server.enabled === false || !isInScope(agent, server.agents, canonical.managedAgents)) return false;
  const route = canonical.mcp.routes?.[agent];
  const mode = routeFor(agent, canonical);
  if (mode === "hub") return false;
  if (mode === "gateway" && route?.servers && !route.servers.includes("memory")) return false;
  return true;
}

function displayPath(raw: string, homeDir: string): string {
  if (raw === "~" || raw.startsWith("~/")) return raw;
  if (raw === homeDir || raw.startsWith(`${homeDir}/`)) return `~${raw.slice(homeDir.length)}`;
  return "custom-path";
}

function fileState(path: string): Pick<MemoryReadiness, "graphExists" | "graphReadable" | "graphWritable" | "graphReady"> {
  const graphExists = existsSync(path);
  const graphReadable = graphExists && (() => {
    try {
      accessSync(path, constants.R_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  })();
  const graphWritable = (() => {
    try {
      let parent = graphExists ? path : dirname(path);
      while (!existsSync(parent)) {
        const next = dirname(parent);
        if (next === parent) return false;
        parent = next;
      }
      accessSync(parent, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  return { graphExists, graphReadable, graphWritable, graphReady: graphWritable };
}

export function inspectMemoryReadiness(
  canonical: CanonicalSource,
  homeDir: string,
  upstream: readonly UpstreamStatus[] = [],
): MemoryReadiness {
  const server = canonical.mcp.servers.memory;
  const rawPath = server?.staticEnv?.MEMORY_FILE_PATH;
  const backendConfigured = Boolean(server && server.enabled !== false && rawPath);
  const graph = rawPath ? fileState(rawPath.replace(/^~(?=$|\/)/, homeDir)) : {
    graphExists: false,
    graphReadable: false,
    graphWritable: false,
    graphReady: false,
  };
  const memoryUpstream = upstream.find((status) => status.name === "memory");
  const deliveredAgents = backendConfigured
    ? canonical.managedAgents.filter((agent) => memoryDeliveredTo(agent, canonical))
    : [];
  return {
    backendConfigured,
    ...(rawPath ? { graphPath: displayPath(rawPath, homeDir) } : {}),
    ...graph,
    canonicalCount: canonical.memories.length,
    deliveredAgents,
    writePath: backendConfigured ? "mcp" : "unavailable",
    extractionCommand: "trellis memory extract",
    nativeImportSupported: false,
    ...(memoryUpstream ? { upstream: { status: memoryUpstream.status, ...(memoryUpstream.detail ? { detail: memoryUpstream.detail } : {}), ...(memoryUpstream.remediation ? { remediation: memoryUpstream.remediation } : {}) } } : {}),
  };
}
