/**
 * The gateway's one seam (trellis-mcp-gateway-hosting design.md D11).
 *
 * `src/commands/mcpGateway.ts` — the MCP `Server` an agent actually talks
 * to over stdio — may depend on nothing but `GatewayBackend`. It must
 * never reference a connection, a transport, or a server definition. That
 * restriction is the entire point: v1 ships `LocalBackend`, which connects
 * upstreams in-process, and v2 adds a backend that forwards to one shared
 * service instead. Swapping them is a single construction site, and by D2
 * the agent's own config is identical either way, so converging every
 * agent onto one process later needs no re-sync and no user-visible change.
 *
 * The three methods deliberately mirror the MCP operations the agent
 * itself issues, so a future forwarding backend is a thin wrapper over a
 * standard `Client` rather than something with its own shape to maintain
 * (D12).
 */

import type { McpServerDef, SecretsPolicy } from "../core/types.js";
import { connectServer, type McpClientInfo } from "./mcpConnect.js";
import { withTimeout } from "./mcpConnect.js";
import { ensureFreshToken } from "./oauth/refresh.js";
import { McpToolRegistry, type AggregatedTool, type ToolUpstream } from "./mcpToolRegistry.js";

export interface GatewayBackend {
  /** Every tool available through this backend, under its aggregated name. */
  listTools(): Promise<AggregatedTool[]>;
  /** Invoke one aggregated tool; implementations route it to its owner. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Sanitized connection state for user/Agent remediation. */
  listStatus?(): readonly UpstreamStatus[];
  /** Release everything this backend holds. Must be safe to call twice. */
  close(): Promise<void>;
}

/** One in-scope upstream, already resolved from canonical by the caller —
 * `LocalBackend` does not decide scope, it connects what it is given. */
export interface UpstreamSpec {
  name: string;
  def: McpServerDef;
}

export type UpstreamStatusKind = "ready" | "auth-required" | "unavailable" | "timeout" | "degraded";

export interface UpstreamStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  status: UpstreamStatusKind;
  detail?: string;
  remediation?: string;
  remediationKind?: "oauth" | "environment" | "install" | "endpoint" | "router";
  requiresHuman?: boolean;
  requiresSessionRestart?: boolean;
}

export interface LocalBackendOptions {
  secretsPolicy: SecretsPolicy;
  clientInfo: McpClientInfo;
  connectTimeoutMs: number;
  /** Where per-upstream failures are reported. Defaults to stderr, which
   * on a stdio MCP server is the only stream that is not the protocol. */
  onWarning?: (message: string) => void;
  /**
   * Set to enable OAuth: before connecting an http/sse upstream, any
   * stored token for it is refreshed if expired and attached as a Bearer
   * header. Omitted, no OAuth is attempted at all — which is what keeps
   * this class usable by callers that have no home directory.
   *
   * Never performs an interactive authorization: a refresh needs no
   * browser, the initial grant does, and this runs inside a process with
   * no terminal attached (design.md D9).
   */
  homeDir?: string;
}

interface ConnectedUpstream extends ToolUpstream {
  close(): Promise<void>;
}

/**
 * v1's backend: connects each upstream itself and aggregates the result.
 *
 * Failure isolation is the invariant here — one upstream that is
 * unreachable, misconfigured, or permanently hanging must never prevent
 * the others' tools from being served (spec: connection-failure
 * isolation). Every per-upstream step is therefore individually guarded,
 * and a failure reports and drops that upstream alone.
 */
export class LocalBackend implements GatewayBackend {
  private readonly registry = new McpToolRegistry();
  private readonly connected = new Set<ConnectedUpstream>();
  private readonly statuses = new Map<string, UpstreamStatus>();
  private closed = false;

  private constructor(private readonly warn: (message: string) => void) {}

  static async connect(upstreams: readonly UpstreamSpec[], options: LocalBackendOptions): Promise<LocalBackend> {
    const warn = options.onWarning ?? ((message: string) => console.error(message));
    const backend = new LocalBackend(warn);
    await Promise.all(upstreams.map((upstream) => backend.addUpstream(upstream, options)));
    return backend;
  }

  private async addUpstream({ name, def }: UpstreamSpec, options: LocalBackendOptions): Promise<void> {
    const transport = def.transport === "http" || def.transport === "sse" ? def.transport : "stdio";
    this.statuses.set(name, { name, transport, status: "unavailable", detail: "connecting" });
    let effectiveDef = def;
    if (options.homeDir && def.url) {
      try {
        effectiveDef = await withOAuthHeader(name, def, options.homeDir);
      } catch (err) {
        // A dead or unrenewable credential is reported and that upstream
        // dropped — the same isolation a failed connection gets, never a
        // browser and never a blocked startup.
        this.warn(`trellis-mcp-gateway: skipping MCP server "${name}": ${errorText(err)}`);
        this.statuses.set(name, failureStatus(name, def, err));
        return;
      }
    }

    let client: ConnectedUpstream;
    try {
      client = (await connectServer(effectiveDef, options.secretsPolicy, options.connectTimeoutMs, options.clientInfo)) as unknown as ConnectedUpstream;
    } catch (err) {
      this.warn(`trellis-mcp-gateway: failed to connect to MCP server "${name}": ${errorText(err)}`);
      this.statuses.set(name, failureStatus(name, def, err));
      return;
    }
    this.connected.add(client);

    let tools: AggregatedTool[];
    try {
      const result = await withTimeout(client.listTools(), options.connectTimeoutMs, `listTools timed out after ${options.connectTimeoutMs}ms`);
      tools = result.tools;
    } catch (err) {
      this.warn(`trellis-mcp-gateway: failed to list tools for MCP server "${name}": ${errorText(err)}`);
      await this.closeUpstream(client);
      this.statuses.set(name, failureStatus(name, def, err));
      return;
    }

    const { skipped } = this.registry.add(name, client, tools);
    for (const collided of skipped) {
      this.warn(`trellis-mcp-gateway: tool "${collided}" from server "${name}" collides with an already-registered tool and was skipped`);
    }
    if (tools.length === 0 && name === "mcp-router") {
      this.statuses.set(name, {
        name,
        transport,
        status: "degraded",
        detail: "router connected but exposed no downstream tools",
        remediationKind: "router",
        requiresHuman: true,
        remediation: "check the MCP router's provider login/configuration and reconnect it, then restart the Agent session",
        requiresSessionRestart: true,
      });
    } else {
      this.statuses.set(name, { name, transport, status: "ready", detail: `connected; ${tools.length} tool(s) available` });
    }
  }

  async listTools(): Promise<AggregatedTool[]> {
    return this.registry.listTools();
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.registry.callTool(name, args);
  }

  listStatus(): readonly UpstreamStatus[] {
    return [...this.statuses.values()];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.connected];
    this.connected.clear();
    await Promise.all(pending.map((client) => this.closeUpstream(client)));
  }

  private async closeUpstream(client: ConnectedUpstream): Promise<void> {
    this.connected.delete(client);
    try {
      await client.close();
    } catch (err) {
      // Cleanup is best-effort; one transport must not block the others.
      this.warn(`trellis-mcp-gateway: failed to close MCP client: ${errorText(err)}`);
    }
  }
}

function failureStatus(name: string, def: McpServerDef, error: unknown): UpstreamStatus {
  const detail = errorText(error).slice(0, 300);
  const auth = def.url !== undefined && /401|403|unauthorized|forbidden|authentication|required|login/i.test(detail);
  const timeout = /timed out|timeout/i.test(detail);
  if (auth) {
    return {
      name,
      transport: def.transport === "sse" ? "sse" : "http",
      status: "auth-required",
      detail,
      remediationKind: "oauth",
      requiresHuman: true,
      requiresSessionRestart: true,
      remediation: `run \`trellis mcp auth ${name}\` in a human terminal, then restart the Agent session`,
    };
  }
  if (timeout) {
    return {
      name,
      transport: def.transport === "sse" ? "sse" : def.url ? "http" : "stdio",
      status: "timeout",
      detail,
      remediationKind: def.url ? "endpoint" : "environment",
      requiresHuman: true,
      requiresSessionRestart: true,
      remediation: def.url
        ? `check the endpoint/network; if it requires OAuth, run \`trellis mcp auth ${name}\``
        : `check that \`${def.command ?? "the MCP command"}\` is installed and responsive`,
    };
  }
  const envNames = [...(def.env ?? []), ...Object.keys(def.envAliases ?? {})];
  const missingExecutable = /ENOENT|not found|no such file/i.test(detail);
  return {
    name,
    transport: def.transport === "sse" ? "sse" : def.url ? "http" : "stdio",
    status: "unavailable",
    detail,
    remediationKind: def.url ? "endpoint" : (missingExecutable ? "install" : "environment"),
    requiresHuman: true,
    requiresSessionRestart: true,
    remediation: def.url
      ? `check the MCP endpoint and credentials; run \`trellis mcp auth ${name}\` if it uses OAuth`
      : envNames.length > 0
        ? `check the configured environment variables (${envNames.join(", ")}) and rerun \`trellis mcp sync\``
        : `check that \`${def.command ?? "the MCP command"}\` is installed and responsive`,
  };
}

/**
 * Attaches a stored OAuth token, refreshing it first if it has expired.
 *
 * Returns the definition unchanged when nothing is stored for this
 * server: the overwhelmingly common case is a remote server that uses no
 * OAuth at all, or one whose credential lives in `headers` already, and
 * neither should be disturbed.
 *
 * An explicit `Authorization` header in canonical wins. Someone who wrote
 * one meant it, and silently overriding it with a stored token would be
 * the kind of invisible precedence that is impossible to debug.
 */
export async function withOAuthHeader(name: string, def: McpServerDef, homeDir: string): Promise<McpServerDef> {
  const hasExplicitAuth = Object.keys(def.headers ?? {}).some((key) => key.toLowerCase() === "authorization");
  if (hasExplicitAuth) return def;

  const token = await ensureFreshToken(homeDir, name);
  if (!token) return def;

  return { ...def, headers: { ...(def.headers ?? {}), Authorization: `Bearer ${token.accessToken}` } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
