import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, GetPromptResult, Implementation, Prompt, ReadResourceResult, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentId } from "../core/types.js";
import type { GatewayBackend } from "./gatewayBackend.js";

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
  close?(): Promise<void>;
}

function providerError(provider: string, error: unknown): string {
  return `trellis-mcp-runtime: provider "${provider}" failed: ${error instanceof Error ? error.message : String(error)}`;
}

export class BuiltinRegistry {
  private readonly toolOwners = new Map<string, TrellisProvider>();
  private readonly resourceOwners = new Map<string, TrellisProvider>();
  private readonly promptOwners = new Map<string, TrellisProvider>();

  constructor(private readonly providers: readonly TrellisProvider[], private readonly warn: (message: string) => void = console.error) {}

  async listTools(context: RuntimeContext): Promise<Tool[]> {
    const tools: Tool[] = [];
    this.toolOwners.clear();
    for (const provider of this.providers) {
      if (!provider.listTools) continue;
      try {
        for (const tool of await provider.listTools(context)) {
          if (this.toolOwners.has(tool.name)) {
            this.warn(`trellis-mcp-runtime: duplicate tool "${tool.name}" from provider "${provider.id}"`);
            continue;
          }
          this.toolOwners.set(tool.name, provider);
          tools.push(tool);
        }
      } catch (err) {
        this.warn(providerError(provider.id, err));
      }
    }
    return tools;
  }

  async callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult> {
    let provider = this.toolOwners.get(name);
    if (!provider) {
      await this.listTools(context);
      provider = this.toolOwners.get(name);
    }
    if (!provider) return { content: [{ type: "text", text: `unknown Trellis tool "${name}"` }], isError: true };
    try {
      return await provider.callTool(name, args, context);
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
    if (!provider?.readResource) throw new Error(`unknown Trellis resource "${key}"`);
    return provider.readResource(uri, context);
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
    return (await this.backend.callTool(name, args as Record<string, unknown> | undefined)) as CallToolResult;
  }

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
    },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await registry.listTools(context) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => registry.callTool(request.params.name, request.params.arguments, context));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await registry.listResources(context) }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => registry.readResource(new URL(request.params.uri), context));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: await registry.listPrompts(context) }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => registry.getPrompt(request.params.name, request.params.arguments, context));
  return server;
}
