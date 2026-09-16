/**
 * Aggregation of many upstream MCP servers' tools into one flat namespace,
 * and routing a call on that namespace back to the exact upstream that
 * owns it (trellis-mcp-gateway-hosting spec: tool prefix/routing).
 *
 * Agent-agnostic by construction: this module knows nothing about pi's
 * `registerTool`, about MCP's `Server`, or about which servers were in
 * scope. It is handed already-connected upstreams and answers two
 * questions — what tools exist, and who owns a given one.
 *
 * Upstreams are held behind the structural `ToolUpstream` interface rather
 * than the SDK's concrete `Client` so that a test fake, and later a
 * forwarding client to a shared gateway service, both fit without this
 * module changing (design.md D11).
 */

/** The subset of an MCP client this registry actually uses. */
export interface ToolUpstream {
  listTools(): Promise<{ tools: UpstreamTool[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/** An upstream tool as reported by `tools/list`, narrowed to the fields
 * aggregation touches. Anything else an upstream sends is carried through
 * untouched — see `AggregatedTool`. */
export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export type AggregatedTool = UpstreamTool;

/**
 * `${serverName}__${toolName}`, the separator every consumer of this
 * registry shares. Two underscores rather than one because single
 * underscores are common inside real tool names, and because pi's bridge
 * already established this exact shape (pi-mcp-bridge design.md D5) — the
 * gateway matching it keeps one naming convention across both consumers.
 */
export const TOOL_NAME_SEPARATOR = "__";

export function prefixedToolName(serverName: string, toolName: string): string {
  return `${serverName}${TOOL_NAME_SEPARATOR}${toolName}`;
}

interface RegistryEntry {
  serverName: string;
  toolName: string;
  upstream: ToolUpstream;
  tool: AggregatedTool;
}

export interface AddResult {
  /** Prefixed names actually registered by this call. */
  added: string[];
  /**
   * Prefixed names refused because an earlier server already owns them.
   * Reachable when a server name itself contains the separator: server
   * `a`'s tool `b__c` and server `a__b`'s tool `c` both want `a__b__c`.
   * First registration wins — silently overwriting would silently
   * re-route an already-advertised tool to a different server, which is
   * precisely the mis-routing this registry exists to prevent.
   */
  skipped: string[];
}

export class McpToolRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly order: string[] = [];

  /**
   * Register one connected upstream's tools. Callers add each upstream
   * independently, so an upstream that failed to connect or to list its
   * tools is simply never added — every other upstream's tools remain
   * aggregated, with no special-casing here.
   */
  add(serverName: string, upstream: ToolUpstream, tools: readonly AggregatedTool[]): AddResult {
    const added: string[] = [];
    const skipped: string[] = [];
    for (const tool of tools) {
      const name = prefixedToolName(serverName, tool.name);
      if (this.entries.has(name)) {
        skipped.push(name);
        continue;
      }
      this.entries.set(name, { serverName, toolName: tool.name, upstream, tool });
      this.order.push(name);
      added.push(name);
    }
    return { added, skipped };
  }

  /** Every registered tool, under its prefixed name, in registration
   * order. Each tool's own `description`/`inputSchema` and any additional
   * fields the upstream sent are preserved verbatim; only `name` changes. */
  listTools(): AggregatedTool[] {
    return this.order.map((name) => {
      const entry = this.entries.get(name)!;
      return { ...entry.tool, name };
    });
  }

  /** The owning upstream and original tool name for a prefixed name, or
   * `undefined` if nothing owns it. */
  resolve(prefixedName: string): { serverName: string; toolName: string; upstream: ToolUpstream } | undefined {
    const entry = this.entries.get(prefixedName);
    if (!entry) return undefined;
    return { serverName: entry.serverName, toolName: entry.toolName, upstream: entry.upstream };
  }

  /**
   * Route a call to the owning upstream, unprefixing the name on the way
   * out — an upstream knows its tool only by its own name, never by the
   * aggregated one. A name no upstream owns throws rather than guessing.
   */
  async callTool(prefixedName: string, args?: Record<string, unknown>): Promise<unknown> {
    const target = this.resolve(prefixedName);
    if (!target) {
      throw new Error(`unknown tool "${prefixedName}"`);
    }
    return target.upstream.callTool({ name: target.toolName, arguments: args });
  }

  /** Distinct server names with at least one registered tool, in
   * registration order. */
  servers(): string[] {
    const seen: string[] = [];
    for (const name of this.order) {
      const { serverName } = this.entries.get(name)!;
      if (!seen.includes(serverName)) seen.push(serverName);
    }
    return seen;
  }

  get size(): number {
    return this.entries.size;
  }
}
