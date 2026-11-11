import { resolveScope, type AgentId, type McpConfig } from "../core/types.js";

/** The guide follows the same scope and route boundary as the local backend. */
export function memoryBackendAgents(mcp: McpConfig, managed: readonly AgentId[]): AgentId[] {
  const server = mcp.servers.memory;
  if (!server || server.enabled === false) return [];
  const scope = resolveScope(server.agents, managed);
  return managed.filter((agent) => {
    if (!scope.includes(agent)) return false;
    const route = mcp.routes?.[agent];
    if (route) return route.mode !== "hub" && (!route.servers || route.servers.includes("memory"));
    if (mcp.gateway?.enabled && (!mcp.gateway.agents || mcp.gateway.agents.includes(agent))) return true;
    return !mcp.hub;
  });
}
