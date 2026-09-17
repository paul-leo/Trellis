import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { CallToolResult, ReadResourceResult, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { isInScope } from "../core/adapter.js";
import { loadCanonicalSource } from "../core/canonical.js";
import type { AgentId, Scope } from "../core/types.js";
import type { RuntimeContext, TrellisProvider } from "./mcpRuntime.js";

const MAX_MEMORY_BYTES = 256 * 1024;
const MEMORY_RESOURCE_PREFIX = "trellis://memories/";

const SEARCH_TOOL: Tool = {
  name: "trellis.memory.search",
  description: "Search in-scope Trellis memories by name or content, then read one selected memory on demand.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const READ_TOOL: Tool = {
  name: "trellis.memory.read",
  description: "Read one in-scope canonical Trellis memory as Markdown.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

/**
 * The storage-independent boundary for memory providers. A future local
 * graph or OpenViking adapter can implement this contract without changing
 * the MCP edge or the agent-facing tool names.
 *
 * Providers are deliberately read-only here. Mutation needs a separate
 * reviewed capability with explicit audit and approval semantics.
 */
export interface MemoryProvider {
  readonly id: string;
  list(context: RuntimeContext): readonly MemoryRef[] | Promise<readonly MemoryRef[]>;
  read(name: string, context: RuntimeContext): MemorySourceDocument | undefined | Promise<MemorySourceDocument | undefined>;
}

export interface MemoryRef {
  name: string;
  scope?: Scope;
}

export interface MemorySourceDocument {
  content: string;
}

export interface MemoryDocument {
  name: string;
  content: string;
  fingerprint: string;
  uri: string;
  scope: "in-scope";
  source: string;
}

export interface MemorySearchHit {
  name: string;
  fingerprint: string;
  uri: string;
  scope: "in-scope";
  source: string;
}

/** The default provider reads only canonical Markdown memory files. */
export class CanonicalMemoryProvider implements MemoryProvider {
  readonly id = "canonical";

  list(context: RuntimeContext): readonly MemoryRef[] {
    return loadCanonicalSource(context.homeDir).memories.map(({ name, scope }) => ({ name, scope }));
  }

  read(name: string, context: RuntimeContext): MemorySourceDocument | undefined {
    const canonical = loadCanonicalSource(context.homeDir);
    const memory = canonical.memories.find((candidate) => candidate.name === name);
    if (!memory) return undefined;

    const memoryRoot = resolve(context.homeDir, ".trellis", "memories");
    const root = realpathSync(memoryRoot);
    const file = realpathSync(memory.file);
    const relativePath = relative(root, file);
    if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      throw new Error("memory file is outside the canonical memories directory");
    }
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("memory path is not a file");
    if (stat.size > MAX_MEMORY_BYTES) throw new Error(`memory exceeds the ${MAX_MEMORY_BYTES}-byte provider limit`);
    return { content: readFileSync(file, "utf8") };
  }
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function memoryUri(name: string): string {
  return `${MEMORY_RESOURCE_PREFIX}${encodeURIComponent(name)}.md`;
}

function memoryNameFromUri(uri: URL): string {
  if (uri.protocol !== "trellis:" || uri.hostname !== "memories") {
    throw new Error(`unsupported memory resource URI "${uri.toString()}"`);
  }
  const segments = uri.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments.length !== 1 || !segments[0].endsWith(".md")) {
    throw new Error(`unsupported memory resource URI "${uri.toString()}"`);
  }
  return segments[0].slice(0, -3);
}

/** Adapts any read-only MemoryProvider to Trellis's MCP provider registry. */
export class RuntimeMemoryProvider implements TrellisProvider {
  readonly id = "memory";

  constructor(private readonly source: MemoryProvider = new CanonicalMemoryProvider()) {}

  listTools(): Tool[] {
    return [SEARCH_TOOL, READ_TOOL];
  }

  async callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult> {
    const input = (args ?? {}) as Record<string, unknown>;
    if (name === SEARCH_TOOL.name) return this.search(context, input);
    if (name === READ_TOOL.name) return this.readTool(context, input);
    return errorResult(`unknown memory provider tool "${name}"`);
  }

  async listResources(context: RuntimeContext): Promise<Resource[]> {
    const refs = await this.inScopeRefs(context);
    return refs.map((ref) => ({
      uri: memoryUri(ref.name),
      name: `${ref.name}.md`,
      description: `Canonical memory ${ref.name}`,
      mimeType: "text/markdown",
    }));
  }

  async readResource(uri: URL, context: RuntimeContext): Promise<ReadResourceResult> {
    const name = memoryNameFromUri(uri);
    const document = await this.readDocument(name, context);
    if (!document) throw new Error(`memory "${name}" is not available to ${context.agentId}`);
    return { contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: document.content }] };
  }

  private async inScopeRefs(context: RuntimeContext): Promise<readonly MemoryRef[]> {
    const canonical = loadCanonicalSource(context.homeDir);
    const refs = await this.source.list(context);
    return refs.filter((ref) => isInScope(context.agentId, ref.scope, canonical.managedAgents));
  }

  private async readDocument(name: string, context: RuntimeContext): Promise<MemoryDocument | undefined> {
    const ref = (await this.inScopeRefs(context)).find((candidate) => candidate.name === name);
    if (!ref) return undefined;
    const document = await this.source.read(name, context);
    if (!document) return undefined;
    return {
      name,
      content: document.content,
      fingerprint: fingerprint(document.content),
      uri: memoryUri(name),
      scope: "in-scope",
      source: this.source.id,
    };
  }

  private async search(context: RuntimeContext, input: Record<string, unknown>): Promise<CallToolResult> {
    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    const limit = typeof input.limit === "number" ? Math.min(50, Math.max(1, Math.floor(input.limit))) : 20;
    const hits: MemorySearchHit[] = [];
    for (const ref of await this.inScopeRefs(context)) {
      let document: MemoryDocument | undefined;
      try {
        document = await this.readDocument(ref.name, context);
      } catch {
        // One unreadable memory must not hide every other memory from search.
        continue;
      }
      if (!document) continue;
      if (query && !`${document.name}\n${document.content}`.toLowerCase().includes(query)) continue;
      hits.push({
        name: document.name,
        fingerprint: document.fingerprint,
        uri: document.uri,
        scope: document.scope,
        source: document.source,
      });
      if (hits.length >= limit) break;
    }
    return textResult({ memories: hits });
  }

  private async readTool(context: RuntimeContext, input: Record<string, unknown>): Promise<CallToolResult> {
    if (typeof input.name !== "string" || input.name.length === 0) return errorResult('"name" is required');
    try {
      const document = await this.readDocument(input.name, context);
      if (!document) return errorResult(`memory "${input.name}" is not available to ${context.agentId}`);
      return textResult(document);
    } catch (err) {
      return errorResult(`could not read memory "${input.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
