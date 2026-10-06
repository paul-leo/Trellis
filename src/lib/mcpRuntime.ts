import { Server, ProtocolErrorCode, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { CallToolResult, GetPromptResult, Implementation, Prompt, ReadResourceResult, Resource, Tool } from "@modelcontextprotocol/server";
import type { AgentId } from "../core/types.js";
import type { GatewayBackend } from "./gatewayBackend.js";
import type { SkillEntry } from "./skillManifest.js";
import { allocateExposedToolNames } from "./mcpToolRegistry.js";
import { withoutUpstreamServerInfo } from "./upstreamResources.js";

function compactBuiltinToolName(name: string): string {
  return name.startsWith("trellis.") ? name.slice("trellis.".length).replaceAll(".", "_") : name;
}

export interface RuntimeContext {
  agentId: AgentId;
  homeDir: string;
}

export interface TrellisProvider {
  readonly id: string;
  listTools?(context: RuntimeContext): Promise<Tool[]> | Tool[];
  callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult>;
  listResources?(context: RuntimeContext): Promise<Resource[]> | Resource[];
  readResource?(uri: URL, context: RuntimeContext): Promise<ReadResourceResult> | ReadResourceResult;
  listPrompts?(context: RuntimeContext): Promise<Prompt[]> | Prompt[];
  getPrompt?(name: string, args: Record<string, string> | undefined, context: RuntimeContext): Promise<GetPromptResult> | GetPromptResult;
  /** Skills-over-MCP `skills/list` and `skills/get` (trellis-skills-over-mcp). */
  listSkillEntries?(context: RuntimeContext): Promise<SkillEntry[]> | SkillEntry[];
  getSkillEntry?(uri: string, context: RuntimeContext): Promise<SkillEntry | undefined> | SkillEntry | undefined;
  close?(): Promise<void>;
}

function providerError(provider: string, error: unknown): string {
  return `trellis-mcp-runtime: provider "${provider}" failed: ${error instanceof Error ? error.message : String(error)}`;
}

export class BuiltinRegistry {
  private readonly toolOwners = new Map<string, TrellisProvider>();
  private readonly originalToolOwners = new Map<string, TrellisProvider>();
  private readonly exposedToOriginal = new Map<string, string>();
  private readonly resourceOwners = new Map<string, TrellisProvider>();
  private readonly promptOwners = new Map<string, TrellisProvider>();

  constructor(private readonly providers: readonly TrellisProvider[], private readonly warn: (message: string) => void = console.error) {}

  async listTools(context: RuntimeContext): Promise<Tool[]> {
    const candidates: Array<{ provider: TrellisProvider; tool: Tool }> = [];
    this.toolOwners.clear();
    this.originalToolOwners.clear();
    this.exposedToOriginal.clear();
    for (const provider of this.providers) {
      if (!provider.listTools) continue;
      try {
        for (const tool of await provider.listTools(context)) {
          candidates.push({ provider, tool });
        }
      } catch (err) {
        this.warn(providerError(provider.id, err));
      }
    }
    const exposedNames = allocateExposedToolNames(candidates.map(({ provider, tool }) => ({
      serverName: provider.id,
      toolName: provider.id === "upstream" ? tool.name : compactBuiltinToolName(tool.name),
    })));
    return candidates.map(({ provider, tool }, index) => {
      const exposedName = exposedNames[index]!;
      this.toolOwners.set(exposedName, provider);
      this.exposedToOriginal.set(exposedName, tool.name);
      if (!this.originalToolOwners.has(tool.name)) this.originalToolOwners.set(tool.name, provider);
      const title = exposedName === tool.name || tool.title !== undefined
        ? tool.title
        : `${provider.id} / ${tool.name}`;
      return { ...tool, name: exposedName, ...(title === undefined ? {} : { title }) };
    });
  }

  async callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult> {
    let provider = this.toolOwners.get(name);
    let originalName = this.exposedToOriginal.get(name) ?? name;
    if (!provider) {
      await this.listTools(context);
      provider = this.toolOwners.get(name);
      originalName = this.exposedToOriginal.get(name) ?? name;
      // Keep direct programmatic calls using the logical pre-normalization
      // name working, while never advertising an invalid alias to an Agent.
      if (!provider) provider = this.originalToolOwners.get(name);
    }
    if (!provider) return { content: [{ type: "text", text: `unknown Trellis tool "${name}"` }], isError: true };
    try {
      return await provider.callTool(originalName, args, context);
    } catch (err) {
      return { content: [{ type: "text", text: providerError(provider.id, err) }], isError: true };
    }
  }

  async listResources(context: RuntimeContext): Promise<Resource[]> {
    const resources: Resource[] = [];
    this.resourceOwners.clear();
    for (const provider of this.providers) {
      if (!provider.listResources) continue;
      try {
        for (const resource of await provider.listResources(context)) {
          if (this.resourceOwners.has(resource.uri)) {
            this.warn(`trellis-mcp-runtime: duplicate resource "${resource.uri}" from provider "${provider.id}"`);
            continue;
          }
          this.resourceOwners.set(resource.uri, provider);
          resources.push(resource);
        }
      } catch (err) {
        this.warn(providerError(provider.id, err));
      }
    }
    return resources;
  }

  async readResource(uri: URL, context: RuntimeContext): Promise<ReadResourceResult> {
    const key = uri.toString();
    let provider = this.resourceOwners.get(key);
    if (!provider) {
      await this.listResources(context);
      provider = this.resourceOwners.get(key);
    }
    // A manifest can introduce supporting files not returned by resources/list.
    if (!provider && uri.protocol === "trellis-upstream:") provider = this.providers.find((candidate) => candidate.id === "upstream");
    if (!provider?.readResource) throw new Error(`unknown Trellis resource "${key}"`);
    return provider.readResource(uri, context);
  }

  async listSkills(context: RuntimeContext): Promise<SkillEntry[]> {
    const skills: SkillEntry[] = [];
    for (const provider of this.providers) {
      if (!provider.listSkillEntries) continue;
      try {
        skills.push(...(await provider.listSkillEntries(context)));
      } catch (err) {
        this.warn(providerError(provider.id, err));
      }
    }
    return skills;
  }

  async getSkill(uri: string, context: RuntimeContext): Promise<SkillEntry | undefined> {
    for (const provider of this.providers) {
      if (!provider.getSkillEntry) continue;
      try {
        const entry = await provider.getSkillEntry(uri, context);
        if (entry) return entry;
      } catch (err) {
        this.warn(providerError(provider.id, err));
      }
    }
    return undefined;
  }

  async listPrompts(context: RuntimeContext): Promise<Prompt[]> {
    const prompts: Prompt[] = [];
    this.promptOwners.clear();
    for (const provider of this.providers) {
      if (!provider.listPrompts) continue;
      try {
        for (const prompt of await provider.listPrompts(context)) {
          if (this.promptOwners.has(prompt.name)) {
            this.warn(`trellis-mcp-runtime: duplicate prompt "${prompt.name}" from provider "${provider.id}"`);
            continue;
          }
          this.promptOwners.set(prompt.name, provider);
          prompts.push(prompt);
        }
      } catch (err) {
        this.warn(providerError(provider.id, err));
      }
    }
    return prompts;
  }

  async getPrompt(name: string, args: Record<string, string> | undefined, context: RuntimeContext): Promise<GetPromptResult> {
    let provider = this.promptOwners.get(name);
    if (!provider) {
      await this.listPrompts(context);
      provider = this.promptOwners.get(name);
    }
    if (!provider?.getPrompt) throw new Error(`unknown Trellis prompt "${name}"`);
    return provider.getPrompt(name, args, context);
  }

  async close(): Promise<void> {
    await Promise.all(this.providers.map(async (provider) => {
      try {
        await provider.close?.();
      } catch (err) {
        this.warn(providerError(provider.id, err));
      }
    }));
  }
}

/** Adapts the existing gateway tool backend without duplicating its routing
 * or upstream connection logic. */
export class UpstreamProvider implements TrellisProvider {
  readonly id = "upstream";

  constructor(private readonly backend: GatewayBackend) {}

  async listTools(): Promise<Tool[]> {
    return (await this.backend.listTools()) as Tool[];
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    return withoutUpstreamServerInfo((await this.backend.callTool(name, args as Record<string, unknown> | undefined)) as CallToolResult);
  }

  async listResources(): Promise<Resource[]> { return await this.backend.listResources?.() ?? []; }
  async readResource(uri: URL): Promise<ReadResourceResult> {
    if (!this.backend.readResource) throw new Error("upstream resources unavailable");
    return this.backend.readResource(uri.toString());
  }
  async listSkillEntries(): Promise<SkillEntry[]> { return await this.backend.listSkills?.() ?? []; }
  async getSkillEntry(uri: string): Promise<SkillEntry | undefined> { return this.backend.getSkill?.(uri); }

  async close(): Promise<void> {
    await this.backend.close();
  }
}

export function createRuntimeServer(serverInfo: Implementation, context: RuntimeContext, registry: BuiltinRegistry): Server {
  const server = new Server(serverInfo, {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
      extensions: { "io.modelcontextprotocol/skills": {} },
    },
  });
  server.setRequestHandler("tools/list", async () => ({ tools: await registry.listTools(context) }));
  server.setRequestHandler("tools/call", async ({ params }) => registry.callTool(params.name, params.arguments, context));
  server.setRequestHandler("resources/list", async () => ({ resources: await registry.listResources(context) }));
  server.setRequestHandler("resources/read", async ({ params }) => {
    try { return await registry.readResource(new URL(params.uri), context); }
    catch (err) {
      if (err instanceof TypeError || (err instanceof Error && /unknown|not found|not allowed|outside|secret-like|invalid.*uri/i.test(err.message))) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "unknown or unreadable resource");
      }
      throw err;
    }
  });
  server.setRequestHandler("prompts/list", async () => ({ prompts: await registry.listPrompts(context) }));
  server.setRequestHandler("prompts/get", async ({ params }) => registry.getPrompt(params.name, params.arguments, context));

  const result = z.looseObject({});
  const cache = { ttlMs: 0, cacheScope: "private" as const };
  server.setRequestHandler("skills/list", { params: z.object({ cursor: z.string().optional() }), result }, async () => ({ ...cache, skills: await registry.listSkills(context) }));
  server.setRequestHandler("skills/get", { params: z.object({ uri: z.string() }), result }, async ({ uri }) => {
    const entry = await registry.getSkill(uri, context);
    if (!entry) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "unknown skill");
    return { ...cache, skill: entry };
  });
  return server;
}
