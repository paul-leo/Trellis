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

/** The strictest Agent-facing tool-name contract currently exercised by the
 * local stack (notably the Codex-compatible model tool surface). */
export const MAX_EXPOSED_TOOL_NAME_LENGTH = 64;
export const SHORT_EXPOSED_TOOL_NAME_LENGTH = 12;
export const EXPOSED_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * `${serverName}__${toolName}`, the separator every consumer of this
 * registry shares. Two underscores rather than one because single
 * underscores are common inside real tool names, and because pi's bridge
 * already established this exact shape (pi-mcp-bridge design.md D5) — the
 * gateway matching it keeps one naming convention across both consumers.
 */
export const TOOL_NAME_SEPARATOR = "__";

function stableHash(value: string): string {
  // FNV-1a is deliberately small and deterministic; this is only a bounded
  // display-name disambiguator, never a security or persistence primitive.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return normalized || fallback;
}

function compactSourceSegment(value: string): string {
  const normalized = safeSegment(value, "server");
  return safeSegment(normalized.replace(/^mcp(?:_|-)+/i, ""), "server");
}

function boundedName(value: string, identity: string): string {
  if (value.length <= MAX_EXPOSED_TOOL_NAME_LENGTH && EXPOSED_TOOL_NAME_PATTERN.test(value)) return value;
  const suffix = `__${stableHash(identity)}`;
  const prefixLength = Math.max(1, MAX_EXPOSED_TOOL_NAME_LENGTH - suffix.length);
  return `${value.slice(0, prefixLength)}${suffix}`;
}

/** Normalize one raw tool name without adding a server prefix. */
export function normalizedToolName(toolName: string): string {
  return boundedName(safeSegment(toolName, "tool"), `tool\0${toolName}`);
}

export function prefixedToolName(serverName: string, toolName: string): string {
  const server = compactSourceSegment(serverName);
  const tool = safeSegment(toolName, "tool");
  return boundedName(`${server}${TOOL_NAME_SEPARATOR}${tool}`, `prefixed\0${serverName}\0${toolName}`);
}

export interface ToolNameCandidate {
  serverName: string;
  toolName: string;
}

/** Allocate all exposed names together so normalization collisions are
 * deterministic and no upstream tool is silently lost. The returned array
 * is indexed like `candidates`. */
export function allocateExposedToolNames(candidates: readonly ToolNameCandidate[]): string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.toolName, (counts.get(candidate.toolName) ?? 0) + 1);

  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => left.candidate.serverName.localeCompare(right.candidate.serverName)
      || left.candidate.toolName.localeCompare(right.candidate.toolName)
      || left.index - right.index);
  const allocated = new Array<string>(candidates.length);
  const used = new Set<string>();

  for (const { candidate, index } of ordered) {
    const normalized = normalizedToolName(candidate.toolName);
    const source = compactSourceSegment(candidate.serverName);
    // A `__` segment is already a source-qualified name from an upstream
    // registry (for example `fixture__env` reaching the Runtime provider).
    // Do not add a second provider prefix around it.
    const sourceQualified = normalized.includes("__") || normalized === source || normalized.startsWith(`${source}_`) || normalized.startsWith(`${source}__`);
    const unique = (counts.get(candidate.toolName) ?? 0) === 1;
    const base = unique && normalized.length > SHORT_EXPOSED_TOOL_NAME_LENGTH
      ? normalized
      : unique && sourceQualified
        ? normalized
        : prefixedToolName(candidate.serverName, candidate.toolName);
    let exposed = base;
    let suffix = 2;
    while (used.has(exposed)) {
      exposed = boundedName(`${base}${TOOL_NAME_SEPARATOR}${suffix}`, `collision\0${candidate.serverName}\0${candidate.toolName}\0${suffix}`);
      suffix += 1;
    }
    used.add(exposed);
    allocated[index] = exposed;
  }
  return allocated;
}

interface RegistryEntry {
  serverName: string;
  toolName: string;
  upstream: ToolUpstream;
  tool: AggregatedTool;
}

interface CandidateEntry extends RegistryEntry {}

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
  private readonly candidates: CandidateEntry[] = [];

  private rebuild(): void {
    this.entries.clear();
    this.order.length = 0;
    const allocated = allocateExposedToolNames(this.candidates);
    const ordered = this.candidates
      .map((candidate, index) => ({ candidate, index, exposed: allocated[index] }))
      .sort((left, right) => left.candidate.serverName.localeCompare(right.candidate.serverName) || left.candidate.toolName.localeCompare(right.candidate.toolName) || left.index - right.index);
    for (const { candidate, exposed } of ordered) {
      this.entries.set(exposed, candidate);
      this.order.push(exposed);
    }
  }

  /**
   * Register one connected upstream's tools. Callers add each upstream
   * independently, so an upstream that failed to connect or to list its
   * tools is simply never added — every other upstream's tools remain
   * aggregated, with no special-casing here.
   */
  add(serverName: string, upstream: ToolUpstream, tools: readonly AggregatedTool[]): AddResult {
    for (const tool of tools) this.candidates.push({ serverName, toolName: tool.name, upstream, tool });
    this.rebuild();
    const added = tools.map((tool) => this.exposedNameFor(serverName, tool.name)).filter((name): name is string => name !== undefined);
    return { added, skipped: [] };
  }

  private exposedNameFor(serverName: string, toolName: string): string | undefined {
    for (const [name, entry] of this.entries) {
      if (entry.serverName === serverName && entry.toolName === toolName) return name;
    }
    return undefined;
  }

  /** Every registered tool, under its prefixed name, in registration
   * order. Each tool's own `description`/`inputSchema` and any additional
   * fields the upstream sent are preserved verbatim; only `name` changes. */
  listTools(): AggregatedTool[] {
    this.rebuild();
    return this.order.map((name) => {
      const entry = this.entries.get(name)!;
      const title = name === entry.toolName || entry.tool.title !== undefined
        ? entry.tool.title
        : `${entry.serverName} / ${entry.toolName}`;
      return { ...entry.tool, name, ...(title === undefined ? {} : { title }) };
    });
  }

  /** The owning upstream and original tool name for a prefixed name, or
   * `undefined` if nothing owns it. */
  resolve(prefixedName: string): { serverName: string; toolName: string; upstream: ToolUpstream } | undefined {
    this.rebuild();
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
    this.rebuild();
    const seen: string[] = [];
    for (const name of this.order) {
      const { serverName } = this.entries.get(name)!;
      if (!seen.includes(serverName)) seen.push(serverName);
    }
    return seen;
  }

  get size(): number {
    this.rebuild();
    return this.entries.size;
  }
}
