import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AgentId, CapabilityDelivery, CanonicalSource, McpRouteMode } from "./types.js";
import { ALL_AGENTS } from "./types.js";

export type NameSelection = "all" | "none" | string[];

export interface CapabilitySelection {
  skills: NameSelection;
  mcpServers: NameSelection;
  memories: NameSelection;
  memoryMigration: "all" | "none";
  mcpRoutes: Partial<Record<AgentId, { mode: McpRouteMode; servers?: string[] }>>;
  runtimeDelivery: Partial<Record<AgentId, CapabilityDelivery>>;
}

export interface CapabilityItem {
  name: string;
  displayName: string;
  fingerprint?: string;
  status: "new" | "unchanged" | "changed" | "unsupported";
  detail?: string;
}

export interface UnsupportedCapabilitySource {
  name: string;
  detail: string;
}

export interface CapabilityInventory {
  skills: CapabilityItem[];
  mcpServers: CapabilityItem[];
  canonicalMemories: CapabilityItem[];
  nativeMemory: UnsupportedCapabilitySource[];
}

type RawSelection = {
  skills?: unknown;
  mcp_servers?: unknown;
  memories?: unknown;
  memory_migration?: unknown;
  mcp_routes?: unknown;
  runtime_delivery?: unknown;
};

export type SelectionFileResult = { ok: true; selection: CapabilitySelection } | { ok: false; error: string };

const ALL_SELECTION: CapabilitySelection = {
  skills: "all",
  mcpServers: "all",
  memories: "all",
  memoryMigration: "all",
  mcpRoutes: {},
  runtimeDelivery: {},
};

function parseNameSelection(value: unknown, field: string): NameSelection {
  if (value === undefined) return "all";
  if (value === "all" || value === "none") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) {
    return [...new Set(value)] as string[];
  }
  throw new Error(`${field} must be "all", "none", or a list of names`);
}

function parseRoutes(value: unknown): CapabilitySelection["mcpRoutes"] {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("mcp_routes must be a map of agent ids to route definitions");
  }
  const routes: CapabilitySelection["mcpRoutes"] = {};
  for (const [rawAgent, rawRoute] of Object.entries(value)) {
    if (!(ALL_AGENTS as readonly string[]).includes(rawAgent)) {
      throw new Error(`mcp_routes contains unknown agent "${rawAgent}"`);
    }
    if (typeof rawRoute !== "object" || rawRoute === null || Array.isArray(rawRoute)) {
      throw new Error(`mcp_routes.${rawAgent} must be a route object`);
    }
    const route = rawRoute as { mode?: unknown; servers?: unknown };
    if (route.mode !== "direct" && route.mode !== "gateway" && route.mode !== "hub") {
      throw new Error(`mcp_routes.${rawAgent}.mode must be direct, gateway, or hub`);
    }
    if (route.servers !== undefined && (!Array.isArray(route.servers) || !route.servers.every((item) => typeof item === "string" && item.length > 0))) {
      throw new Error(`mcp_routes.${rawAgent}.servers must be a list of names`);
    }
    routes[rawAgent as AgentId] = {
      mode: route.mode,
      ...(route.servers ? { servers: [...new Set(route.servers as string[])] } : {}),
    };
  }
  return routes;
}

function parseRuntimeDelivery(value: unknown): CapabilitySelection["runtimeDelivery"] {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime_delivery must be a map of agent ids to native, mcp, or both");
  }
  const delivery: CapabilitySelection["runtimeDelivery"] = {};
  for (const [rawAgent, rawMode] of Object.entries(value)) {
    if (!(ALL_AGENTS as readonly string[]).includes(rawAgent)) {
      throw new Error(`runtime_delivery contains unknown agent "${rawAgent}"`);
    }
    if (rawMode !== "native" && rawMode !== "mcp" && rawMode !== "both") {
      throw new Error(`runtime_delivery.${rawAgent} must be native, mcp, or both`);
    }
    delivery[rawAgent as AgentId] = rawMode;
  }
  return delivery;
}

export function parseCapabilitySelectionFile(path: string): SelectionFileResult {
  if (!existsSync(path)) return { ok: false, error: `selection file does not exist: ${path}` };
  try {
    const parsed = (parseYaml(readFileSync(path, "utf8")) ?? {}) as RawSelection;
    return {
      ok: true,
      selection: {
        skills: parseNameSelection(parsed.skills, "skills"),
        mcpServers: parseNameSelection(parsed.mcp_servers, "mcp_servers"),
        memories: parseNameSelection(parsed.memories, "memories"),
        memoryMigration: parsed.memory_migration === undefined || parsed.memory_migration === "all" ? "all" : parsed.memory_migration === "none" ? "none" : (() => { throw new Error('memory_migration must be "all" or "none"'); })(),
        mcpRoutes: parseRoutes(parsed.mcp_routes),
        runtimeDelivery: parseRuntimeDelivery(parsed.runtime_delivery),
      },
    };
  } catch (err) {
    return { ok: false, error: `could not parse selection file ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function defaultCapabilitySelection(): CapabilitySelection {
  return { ...ALL_SELECTION, mcpRoutes: {}, runtimeDelivery: {} };
}

export function resolveSelectedNames(selection: NameSelection, available: readonly string[]): string[] {
  if (selection === "all") return [...available];
  if (selection === "none") return [];
  const availableSet = new Set(available);
  return [...new Set(selection.filter((name) => availableSet.has(name)))];
}

export function selectionContains(selection: NameSelection, name: string): boolean {
  return selection === "all" || (selection !== "none" && selection.includes(name));
}

export function buildCapabilityInventory(
  source: { skillNames: readonly string[]; mcpServerNames: readonly string[] },
  canonical: Pick<CanonicalSource, "skills" | "mcp" | "memories">,
  nativeMemory: UnsupportedCapabilitySource[] = [],
): CapabilityInventory {
  const canonicalSkills = new Set(canonical.skills.map((skill) => skill.name));
  const canonicalMcp = new Set(Object.keys(canonical.mcp.servers));
  return {
    skills: source.skillNames.map((name) => ({
      name,
      displayName: name,
      status: canonicalSkills.has(name) ? "unchanged" : "new",
    })),
    mcpServers: source.mcpServerNames.map((name) => ({
      name,
      displayName: name,
      status: canonicalMcp.has(name) ? "unchanged" : "new",
    })),
    canonicalMemories: canonical.memories.map((memory) => ({
      name: memory.name,
      displayName: memory.name,
      status: "unchanged",
    })),
    nativeMemory,
  };
}
