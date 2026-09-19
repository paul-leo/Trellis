import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CallToolResult, Prompt, ReadResourceResult, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ALL_AGENTS, capabilityDeliveryForAgent, type AgentId, type AgentSnapshot, type CanonicalSource, type McpRouteMode } from "../core/types.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { isGatewayAgent } from "../adapters/mcpPlan.js";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import * as kimiCodeProbe from "../probes/kimi-code.js";
import { TRELLIS_VERSION } from "./cliMetadata.js";
import type { GatewayBackend } from "./gatewayBackend.js";
import { inspectMemoryReadiness } from "./memoryStatus.js";
import type { RuntimeContext, TrellisProvider } from "./mcpRuntime.js";

const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const INSTRUCTIONS_URI = "trellis://instructions/agents.md";

const STATUS_TOOL: Tool = {
  name: "trellis.runtime.status",
  description: "Describe the current Agent's Trellis Runtime, managed boundary, providers, and safe MCP health summary.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const AGENTS_TOOL: Tool = {
  name: "trellis.agents.list",
  description: "List installed and Trellis-managed Agents with high-level capability health; never returns credentials or private sessions.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const INSTRUCTIONS_TOOL: Tool = {
  name: "trellis.instructions.read",
  description: "Read the canonical global Agent instructions as bounded Markdown.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const PROBES: Record<AgentId, (homeDir: string) => Promise<AgentSnapshot>> = {
  "claude-code": (homeDir) => claudeCodeProbe.probe(homeDir),
  codex: (homeDir) => codexProbe.probe(homeDir),
  kiro: (homeDir) => kiroProbe.probe(homeDir),
  pi: (homeDir) => piProbe.probe(homeDir),
  "kimi-code": (homeDir) => kimiCodeProbe.probe(homeDir),
};

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function routeFor(agent: AgentId, canonical: CanonicalSource): McpRouteMode {
  const explicit = canonical.mcp.routes?.[agent];
  if (explicit) return explicit.mode;
  if (isGatewayAgent(agent, canonical.mcp, canonical.managedAgents)) return "gateway";
  if (canonical.mcp.hub) return "hub";
  return "direct";
}

function healthFor(snapshot: AgentSnapshot, managed: boolean): "healthy" | "degraded" | "unmanaged" | "absent" {
  if (!snapshot.present) return "absent";
  if (!managed) return "unmanaged";
  if (snapshot.diagnostics.length > 0) return "degraded";
  return "healthy";
}

function snapshotSummary(snapshot: AgentSnapshot, canonical: CanonicalSource): Record<string, unknown> {
  const managed = canonical.managedAgents.includes(snapshot.agent);
  return {
    id: snapshot.agent,
    present: snapshot.present,
    managed,
    health: healthFor(snapshot, managed),
    ...(snapshot.version ? { version: snapshot.version } : {}),
    runtimeDelivery: capabilityDeliveryForAgent(snapshot.agent, canonical.mcp),
    mcpRoute: routeFor(snapshot.agent, canonical),
    skillCount: snapshot.skillRoots.reduce((count, root) => count + root.skills.length, 0),
    mcpServerCount: snapshot.mcpServers.length,
    instructions: { present: snapshot.instructionsFile !== undefined, native: true },
    diagnostics: snapshot.diagnostics,
  };
}

async function probeAgents(homeDir: string): Promise<AgentSnapshot[]> {
  const results = await Promise.allSettled(ALL_AGENTS.map((agent) => PROBES[agent](homeDir)));
  return results.map((result, index) => result.status === "fulfilled"
    ? result.value
    : { agent: ALL_AGENTS[index], present: false, skillRoots: [], mcpServers: [], diagnostics: [`probe failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] });
}

function safeInstructions(homeDir: string, file: string): string {
  const canonicalRoot = realpathSync(join(homeDir, ".trellis"));
  const realFile = realpathSync(file);
  const rel = relative(canonicalRoot, realFile);
  if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("canonical instructions file is outside ~/.trellis");
  const stat = statSync(realFile);
  if (!stat.isFile() || stat.size > MAX_INSTRUCTIONS_BYTES) throw new Error(`instructions exceed the ${MAX_INSTRUCTIONS_BYTES}-byte provider limit`);
  return readFileSync(realFile, "utf8");
}

export class RuntimeControlProvider implements TrellisProvider {
  readonly id = "runtime";

  constructor(private readonly backend: GatewayBackend, private readonly trellisVersion: string = TRELLIS_VERSION) {}

  listTools(): Tool[] {
    return [STATUS_TOOL, AGENTS_TOOL, INSTRUCTIONS_TOOL];
  }

  async callTool(name: string, _args: unknown, context: RuntimeContext): Promise<CallToolResult> {
    if (name === STATUS_TOOL.name) return textResult(await this.status(context));
    if (name === AGENTS_TOOL.name) return textResult(await this.agents(context));
    if (name === INSTRUCTIONS_TOOL.name) {
      try {
        return textResult(this.instructions(context));
      } catch (err) {
        return errorResult(`could not read canonical instructions: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return errorResult(`unknown control-plane tool "${name}"`);
  }

  listResources(): Resource[] {
    return [{ uri: INSTRUCTIONS_URI, name: "agents.md", description: "Canonical global Agent instructions", mimeType: "text/markdown" }];
  }

  readResource(uri: URL, context: RuntimeContext): ReadResourceResult {
    if (uri.toString() !== INSTRUCTIONS_URI) throw new Error(`unsupported instructions resource URI "${uri.toString()}"`);
    const value = this.instructions(context);
    return { contents: [{ uri: INSTRUCTIONS_URI, mimeType: "text/markdown", text: value.content }] };
  }

  private async agents(context: RuntimeContext): Promise<Record<string, unknown>> {
    const canonical = loadCanonicalSource(context.homeDir);
    const snapshots = await probeAgents(context.homeDir);
    return { agents: snapshots.map((snapshot) => snapshotSummary(snapshot, canonical)), source: "trellis" };
  }

  private async status(context: RuntimeContext): Promise<Record<string, unknown>> {
    const canonical = loadCanonicalSource(context.homeDir);
    const snapshots = await probeAgents(context.homeDir);
    const current = snapshots.find((snapshot) => snapshot.agent === context.agentId);
    const currentSummary = current ? snapshotSummary(current, canonical) : { id: context.agentId, present: false };
    const route = routeFor(context.agentId, canonical);
    const upstream = this.backend.listStatus?.() ?? [];
    const unhealthy = upstream.filter((status) => status.status !== "ready");
    const memory = inspectMemoryReadiness(canonical, context.homeDir, upstream);
    return {
      agent: currentSummary,
      runtime: { trellisVersion: this.trellisVersion, edge: "gateway", route },
      providers: {
        skills: { available: true, canonicalCount: canonical.skills.length },
        memory: { available: true, ...memory },
        instructions: { available: existsSync(canonical.instructionsFile), native: true, runtimeReadable: true },
        mcp: { available: true, upstreamCount: upstream.length, unhealthyCount: unhealthy.length },
        tasks: { available: true, mutationRequiresConfirmation: true, launchesAgents: false },
      },
      upstream,
      agents: snapshots.map((snapshot) => snapshotSummary(snapshot, canonical)),
      source: "trellis",
    };
  }

  private instructions(context: RuntimeContext): { name: string; content: string; fingerprint: string; source: string } {
    const canonical = loadCanonicalSource(context.homeDir);
    const content = safeInstructions(context.homeDir, canonical.instructionsFile);
    return { name: "agents.md", content, fingerprint: createHash("sha256").update(content).digest("hex"), source: "canonical" };
  }
}
