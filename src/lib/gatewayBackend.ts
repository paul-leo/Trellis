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
import { isOAuthAuth, oauthOwner } from "../core/types.js";
import { connectServer, type McpClientInfo } from "./mcpConnect.js";
import { withTimeout } from "./mcpConnect.js";
import { ensureFreshToken, forceRefresh, RefreshError } from "./oauth/refresh.js";
import { readToken } from "./oauth/store.js";
import type { FetchLike } from "./oauth/discovery.js";
import { McpToolRegistry, type AggregatedTool, type ToolUpstream } from "./mcpToolRegistry.js";
import type { AuthProvider, Client, Resource, ReadResourceResult } from "@modelcontextprotocol/client";
import { ProtocolError, SdkHttpError } from "@modelcontextprotocol/client";
import type { SkillEntry } from "./skillManifest.js";
import { UpstreamResources } from "./upstreamResources.js";

export interface GatewayBackend {
  /** Every tool available through this backend, under its aggregated name. */
  listTools(): Promise<AggregatedTool[]>;
  /** Invoke one aggregated tool; implementations route it to its owner. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Sanitized connection state for user/Agent remediation. */
  listStatus?(): readonly UpstreamStatus[];
  listResources?(): Promise<Resource[]>;
  readResource?(uri: string): Promise<ReadResourceResult>;
  listSkills?(): Promise<SkillEntry[]>;
  getSkill?(uri: string): Promise<SkillEntry | undefined>;
  /** Release everything this backend holds. Must be safe to call twice. */
  close(): Promise<void>;
}

/** One in-scope upstream, already resolved from canonical by the caller —
 * `LocalBackend` does not decide scope, it connects what it is given. */
export interface UpstreamSpec {
  name: string;
  def: McpServerDef;
}

/** `reconnecting` is the transient state between a detected session
 * invalidation and the recovery outcome (spec: an upstream whose MCP
 * session is invalidated mid-session is recovered alone, with a status
 * that never claims ready in the meantime). */
export type UpstreamStatusKind = "ready" | "auth-required" | "unavailable" | "timeout" | "degraded" | "reconnecting";

export interface UpstreamStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  status: UpstreamStatusKind;
  /** How many tools this upstream contributed at connect time — the
   * structured form of the count `detail` already carries in prose, so
   * Agents reasoning about capability never parse a sentence
   * (trellis-mcp-status-credential-health design.md D5). */
  toolCount?: number;
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
  /** How long a server whose mid-session recovery failed refuses automatic
   * re-attempts, so a down upstream cannot trigger a reconnect storm. Test
   * seam; defaults to `SESSION_RECOVERY_COOLDOWN_MS`. */
  sessionRecoveryCooldownMs?: number;
}

type ConnectedUpstream = Client;

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
  /** server name → the client currently serving that upstream. Keyed by
   * name (not a Set of clients) because recovery swaps the client under a
   * stable name and callTool must ask "is this still the client I called?"
   * by comparing against the current registration. */
  private readonly connected = new Map<string, ConnectedUpstream>();
  private readonly statuses = new Map<string, UpstreamStatus>();
  /** Saved at connect time so a mid-session recovery can rebuild the
   * upstream through `addUpstream` itself — the recovery path IS the
   * startup path, and inherits its OAuth resolution and special cases
   * (mcp-router) wholesale instead of growing a parallel one. */
  private readonly upstreamConfigs = new Map<string, { spec: UpstreamSpec; options: LocalBackendOptions }>();
  /** server name → in-flight session recovery; one recovery per server at
   * a time, every racing caller awaits the same promise. */
  private readonly recoveries = new Map<string, Promise<void>>();
  /** server name → cooldown expiry; a recently failed recovery is not
   * re-attempted until it lapses, so a down upstream sees one reconnect
   * attempt per window, not a storm. */
  private readonly sessionCooldowns = new Map<string, number>();
  private closed = false;
  private readonly resources: UpstreamResources;

  private constructor(
    private readonly warn: (message: string) => void,
    timeoutMs: number,
    private readonly sessionCooldownMs: number,
  ) {
    this.resources = new UpstreamResources(timeoutMs, warn);
  }

  static async connect(upstreams: readonly UpstreamSpec[], options: LocalBackendOptions): Promise<LocalBackend> {
    const warn = options.onWarning ?? ((message: string) => console.error(message));
    const backend = new LocalBackend(warn, options.connectTimeoutMs, options.sessionRecoveryCooldownMs ?? SESSION_RECOVERY_COOLDOWN_MS);
    await Promise.all(upstreams.map((upstream) => backend.addUpstream(upstream, options)));
    return backend;
  }

  private async addUpstream({ name, def }: UpstreamSpec, options: LocalBackendOptions, replaceOf?: ConnectedUpstream): Promise<void> {
    this.upstreamConfigs.set(name, { spec: { name, def }, options });
    const transport = def.transport === "http" || def.transport === "sse" ? def.transport : "stdio";
    // A recovery set `reconnecting` before calling us; a first connect
    // reports "connecting". The recovery's status stays until the outcome.
    if (replaceOf === undefined) {
      this.statuses.set(name, { name, transport, status: "unavailable", detail: "connecting" });
    }
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

    // Per-request credential resolution: the SDK calls token() as each
    // request's headers are assembled, so a token refreshed here — by this
    // process, or written to disk by `trellis mcp auth` in another
    // terminal — affects the very next request, no restart. The static
    // header from withOAuthHeader stays as the connect-time fallback.
    // (A mid-session recovery rebuilds this provider, so its `lastIssued`
    // starts empty again: the first post-recovery 401 force-refreshes with
    // no previous-token guard — at most one extra rotation, and safe,
    // because forceRefresh re-reads the token file under its lock.)
    const authProvider = options.homeDir && (transport === "http" || transport === "sse") && oauthAttachApplies(def)
      ? trellisAuthProvider({
          homeDir: options.homeDir,
          serverName: name,
          onCredentialRecovered: () => this.restoreIfAuthRequired(name),
          onCredentialFailure: (err) => this.markCredentialFailure(name, transport, err),
        })
      : undefined;

    let client: ConnectedUpstream;
    try {
      client = await connectServer(effectiveDef, options.secretsPolicy, options.connectTimeoutMs, options.clientInfo, authProvider);
    } catch (err) {
      this.warn(`trellis-mcp-gateway: failed to connect to MCP server "${name}": ${errorText(err)}`);
      // A failed recovery keeps the replaced client: its dead session is
      // what keeps surfacing the error that re-triggers recovery once the
      // cooldown expires — close-after-success, never orphaned mid-failure.
      if (replaceOf !== undefined) this.connected.set(name, replaceOf);
      this.statuses.set(name, failureStatus(name, def, err));
      return;
    }
    this.connected.set(name, client);

    // Routes (and any skill registrations) a previous incarnation of this
    // source left behind would route reads at the replaced client — forget
    // the source entirely; the fresh registration re-adds its routes below.
    this.resources.removeSource(name);

    let tools: AggregatedTool[];
    try {
      const result = client.getServerCapabilities()?.tools
        ? await withTimeout(client.listTools(), options.connectTimeoutMs, `listTools timed out after ${options.connectTimeoutMs}ms`)
        : { tools: [] };
      tools = result.tools;
    } catch (err) {
      this.warn(`trellis-mcp-gateway: failed to list tools for MCP server "${name}": ${errorText(err)}`);
      this.connected.delete(name);
      if (replaceOf !== undefined) this.connected.set(name, replaceOf);
      await this.closeClient(client);
      this.statuses.set(name, failureStatus(name, def, err));
      return;
    }

    // A recovery swaps this server's whole registration: its previous
    // candidates are dropped first, so a changed upstream tool set is
    // reflected exactly rather than accumulated.
    const { skipped } = replaceOf !== undefined
      ? this.registry.replace(name, client, tools)
      : this.registry.add(name, client, tools);
    this.resources.add(name, client);
    for (const collided of skipped) {
      this.warn(`trellis-mcp-gateway: tool "${collided}" from server "${name}" collides with an already-registered tool and was skipped`);
    }
    if (tools.length === 0 && name === "mcp-router") {
      this.statuses.set(name, {
        name,
        transport,
        status: "degraded",
        toolCount: 0,
        detail: "router connected but exposed no downstream tools",
        remediationKind: "router",
        requiresHuman: true,
        remediation: "check the MCP router's provider login/configuration and reconnect it, then restart the Agent session",
        requiresSessionRestart: true,
      });
    } else {
      this.statuses.set(name, { name, transport, status: "ready", toolCount: tools.length, detail: `connected; ${tools.length} tool(s) available` });
    }
    // The fresh registration serves; only now is the replaced client
    // retired. Callers mid-flight on it finish against it — their stale
    // session errors are guarded in callTool and never start a second
    // recovery — and a failed recovery left the old client connected.
    if (replaceOf !== undefined) await this.closeClient(replaceOf);
  }

  async listTools(): Promise<AggregatedTool[]> {
    return this.registry.listTools();
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    let target = this.registry.resolve(name);
    if (!target) throw new Error(`unknown tool "${name}"`);
    // A server inside its recovery cooldown fails hard and immediately:
    // its automatic recovery is known to be failing, and a reconnect
    // storm against a down upstream buys nothing (D3).
    const blocked = this.sessionCooldownBlock(target.serverName);
    if (blocked) throw blocked;
    // A recovery already in flight — started by a concurrent caller.
    // Wait it out and aim at whatever registration it lands.
    const pending = this.recoveries.get(target.serverName);
    if (pending) {
      await pending;
      target = this.registry.resolve(name);
      if (!target) throw new Error(`unknown tool "${name}"`);
    }
    try {
      return await target.upstream.callTool({ name: target.toolName, arguments: args });
    } catch (err) {
      const { serverName } = target;
      if (this.closed || !isSessionInvalidation(err)) throw this.upstreamCallError(serverName, err);
      // A completed recovery already replaced the client this error came
      // from (a racing caller's reconnect won): the stale error must not
      // start a second recovery — just aim at the fresh registration.
      const current = this.connected.get(serverName);
      if (current === undefined || current === target.upstream) {
        await this.ensureSessionRecovered(serverName, err);
      }
      const retried = this.registry.resolve(name);
      if (!retried) throw new Error(`unknown tool "${name}"`);
      try {
        return await retried.upstream.callTool({ name: retried.toolName, arguments: args });
      } catch (retryErr) {
        // The fresh session failed the same way: an honest terminal state
        // plus a cooldown — never a stale ready (D4).
        if (isSessionInvalidation(retryErr)) this.markRetrySessionFailure(retried.serverName, retryErr);
        throw this.upstreamCallError(retried.serverName, retryErr);
      }
    }
  }

  listResources(): Promise<Resource[]> { return this.resources.listResources(); }
  readResource(uri: string): Promise<ReadResourceResult> { return this.resources.readResource(uri); }
  listSkills(): Promise<SkillEntry[]> { return this.resources.listSkills(); }
  getSkill(uri: string): Promise<SkillEntry | undefined> { return this.resources.getSkill(uri); }

  listStatus(): readonly UpstreamStatus[] {
    return [...this.statuses.values()];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.connected.values()];
    this.connected.clear();
    await Promise.all(pending.map((client) => this.closeClient(client)));
  }

  private async closeClient(client: ConnectedUpstream): Promise<void> {
    try {
      await client.close();
    } catch (err) {
      // Cleanup is best-effort; one transport must not block the others.
      this.warn(`trellis-mcp-gateway: failed to close MCP client: ${errorText(err)}`);
    }
  }

  /** A dead grant surfaces mid-session: this upstream's calls now fail,
   * but its tools stay registered and every other upstream keeps serving.
   * The credential resolves per request, so the human's re-authorization
   * takes effect on the next call — no session restart required. */
  private markCredentialFailure(name: string, transport: UpstreamStatus["transport"], err: unknown): void {
    const previous = this.statuses.get(name);
    this.statuses.set(name, {
      name,
      transport,
      status: "auth-required",
      toolCount: previous?.toolCount,
      detail: errorText(err).slice(0, 300),
      remediationKind: "oauth",
      requiresHuman: true,
      requiresSessionRestart: false,
      remediation: `run \`trellis mcp auth ${name}\` in a human terminal — the running gateway picks the new credential up on its next request`,
    });
    this.warn(`trellis-mcp-gateway: MCP server "${name}" needs re-authorization: ${errorText(err)}`);
  }

  private restoreIfAuthRequired(name: string): void {
    const current = this.statuses.get(name);
    if (!current || current.status !== "auth-required") return;
    this.statuses.set(name, {
      ...current,
      status: "ready",
      detail: `credential recovered; ${current.toolCount ?? 0} tool(s) available`,
      remediation: undefined,
      remediationKind: undefined,
      requiresHuman: undefined,
      requiresSessionRestart: undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Mid-session recovery (spec: an upstream whose MCP session is invalidated
  // is recovered alone, in flight — restart is the remediation of last
  // resort, not the default)
  // ---------------------------------------------------------------------------

  /** The pre-call hard failure for a server inside its recovery cooldown. */
  private sessionCooldownBlock(serverName: string): Error | undefined {
    const until = this.sessionCooldowns.get(serverName);
    if (until === undefined || Date.now() >= until) return undefined;
    return new Error(sessionRecoveryHint(serverName, "a recovery attempt failed recently and its cooldown has not expired"));
  }

  private enterSessionCooldown(serverName: string): void {
    this.sessionCooldowns.set(serverName, Date.now() + this.sessionCooldownMs);
  }

  /** Join the server's in-flight recovery, or start exactly one. */
  private ensureSessionRecovered(serverName: string, trigger: unknown): Promise<void> {
    const blocked = this.sessionCooldownBlock(serverName);
    if (blocked) return Promise.reject(blocked);
    const existing = this.recoveries.get(serverName);
    if (existing) return existing;
    const pending = this.reconnectUpstream(serverName, trigger);
    this.recoveries.set(serverName, pending);
    const cleanup = () => {
      if (this.recoveries.get(serverName) === pending) this.recoveries.delete(serverName);
    };
    pending.then(cleanup, cleanup);
    return pending;
  }

  /** Drop and rebuild one upstream through the exact startup path
   * (`addUpstream`), keeping the old client connected until the fresh
   * registration serves — so a failed recovery still surfaces the old
   * session errors that re-trigger recovery after the cooldown, and the
   * replaced connection is never closed before its successor exists. */
  private async reconnectUpstream(serverName: string, trigger: unknown): Promise<void> {
    const config = this.upstreamConfigs.get(serverName);
    if (!config) throw new Error(sessionRecoveryHint(serverName, "no saved connection config exists for it"));
    // Preserve the tool count through reconnecting and failure: Agents
    // reasoning about capability see the same number on both sides of a
    // recovery, whatever its outcome (a success overwrites it with the
    // fresh count inside addUpstream).
    const toolCount = this.statuses.get(serverName)?.toolCount;
    this.statuses.set(serverName, {
      name: serverName,
      transport: transportOf(config.spec.def),
      status: "reconnecting",
      toolCount,
      detail: `MCP session invalidated; reconnecting (${errorText(trigger).slice(0, 160)})`,
    });
    try {
      await this.addUpstream(config.spec, config.options, this.connected.get(serverName));
    } catch (err) {
      // addUpstream isolates its own failures into statuses; reaching here
      // is a bug guard, not the expected failure path.
      this.statuses.set(serverName, { ...failureStatus(serverName, config.spec.def, err), toolCount, remediation: sessionRestartRemediation(serverName) });
      this.enterSessionCooldown(serverName);
      throw new Error(sessionRecoveryHint(serverName, errorText(err)));
    }
    const status = this.statuses.get(serverName);
    if (status?.status === "ready" || status?.status === "degraded") {
      this.sessionCooldowns.delete(serverName);
      return;
    }
    // A failed recovery already landed in its classified failure status;
    // sharpen its remediation to the restart hint and open the cooldown.
    this.statuses.set(serverName, { ...status!, toolCount, remediation: sessionRestartRemediation(serverName) });
    this.enterSessionCooldown(serverName);
    throw new Error(sessionRecoveryHint(serverName, status?.detail ?? "the reconnect failed"));
  }

  /** The retried request failed on the fresh session too: an honest
   * terminal state plus a cooldown — never a stale ready (D4). */
  private markRetrySessionFailure(serverName: string, err: unknown): void {
    const config = this.upstreamConfigs.get(serverName);
    const previous = this.statuses.get(serverName);
    const base = config
      ? failureStatus(serverName, config.spec.def, err)
      : {
          name: serverName,
          transport: "http" as const,
          status: "unavailable" as const,
          detail: errorText(err).slice(0, 300),
          requiresHuman: true,
          requiresSessionRestart: true,
        };
    this.statuses.set(serverName, {
      ...base,
      toolCount: previous?.toolCount,
      remediation: sessionRestartRemediation(serverName),
    });
    this.enterSessionCooldown(serverName);
  }

  /** Upstream-originated failures name their server (spec: call errors
   * name the failing upstream server). */
  private upstreamCallError(serverName: string, err: unknown): Error {
    return new Error(
      `upstream "${serverName}" tool call failed: ${errorText(err)}`,
      err instanceof Error ? { cause: err } : undefined,
    );
  }
}

/**
 * How long a server whose session recovery failed refuses automatic
 * re-attempts. Fixed by design: a reconnect storm against a down upstream
 * buys nothing; the honest failure state plus this window is the v1
 * answer, to be revisited with real-world data.
 */
export const SESSION_RECOVERY_COOLDOWN_MS = 30_000;

function transportOf(def: McpServerDef): UpstreamStatus["transport"] {
  if (def.transport === "sse") return "sse";
  return def.url ? "http" : "stdio";
}

function sessionRestartRemediation(serverName: string): string {
  return `restart the Agent session to re-establish the MCP session for "${serverName}"`;
}

function sessionRecoveryHint(serverName: string, reason: string): string {
  return `upstream "${serverName}" MCP session invalidated and automatic recovery failed (${reason}) — ${sessionRestartRemediation(serverName)}`;
}

/**
 * Whether an upstream error means "your MCP session no longer exists".
 *
 * The official TypeScript server SDK rejects an unknown session with HTTP
 * 404 carrying the JSON-RPC error "Session not found", and pairs 401/403
 * with -32000 for authentication rejections — so 401/403 gate the match
 * out first, and an auth rejection can never enter recovery. The body
 * reaches us inside the client SDK's `Error POSTing to endpoint: …`
 * wrapper, so a word match covers custom upstream wordings (the real-world
 * one says "MCP session no longer exists"). Real-machine verification
 * (2026-10-23) showed custom upstreams also answer with other non-auth
 * statuses — a 400 carrying that same -32000 body took the plain
 * `SdkHttpError` path, not the enveloped `ProtocolError` one — hence the
 * status gate is "not an auth rejection" rather than "exactly 404". A
 * stray non-auth response that merely mentions "session" costs one
 * idempotent-safe reconnect+retry, an acceptable price for covering every
 * upstream wording. The `ProtocolError` branch covers the HTTP-200
 * JSON-RPC error case, where the client SDK parses the envelope and
 * rejects with the upstream's error code instead.
 */
export function isSessionInvalidation(err: unknown): boolean {
  if (err instanceof SdkHttpError) return err.status !== 401 && err.status !== 403 && /session/i.test(err.message);
  if (err instanceof ProtocolError) return err.code === -32000 && /session/i.test(err.message);
  return false;
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
 * Whether the gateway manages the OAuth credential for this definition:
 * Trellis-owned OAuth, and no explicit `Authorization` header — someone
 * who wrote one in canonical meant it, and silently overriding it with a
 * stored token would be the kind of invisible precedence that is
 * impossible to debug. Both `withOAuthHeader` and the per-request
 * `AuthProvider` attach on exactly this predicate.
 */
export function oauthAttachApplies(def: McpServerDef): boolean {
  return isOAuthAuth(def.auth) && oauthOwner(def.auth) === "trellis"
    && !Object.keys(def.headers ?? {}).some((key) => key.toLowerCase() === "authorization");
}

/**
 * Attaches a stored OAuth token, refreshing it first if it has expired.
 *
 * Returns the definition unchanged when nothing is stored for this
 * server: the overwhelmingly common case is a remote server that uses no
 * OAuth at all, or one whose credential lives in `headers` already, and
 * neither should be disturbed.
 *
 * An explicit `Authorization` header in canonical wins.
 */
export async function withOAuthHeader(name: string, def: McpServerDef, homeDir: string): Promise<McpServerDef> {
  if (!oauthAttachApplies(def)) return def;

  const stored = readToken(homeDir, name);
  const resource = new URL(def.url!);
  resource.hash = "";
  if (stored?.resourceUrl && stored.resourceUrl !== resource.toString()) throw new Error("OAuth authorization required: saved credential targets another MCP resource");

  const token = await ensureFreshToken(homeDir, name);
  if (!token) return def;

  return { ...def, headers: { ...(def.headers ?? {}), Authorization: `Bearer ${token.accessToken}` } };
}

/**
 * The early-refresh window on the gateway's per-request path. Minute-scale
 * on purpose: a request that passes the freshness check must not carry a
 * token that dies mid-flight. `store.ts`'s 60s default is untouched —
 * `mcp auth`/`mcp renew` don't have this problem.
 */
export const GATEWAY_REFRESH_SKEW_MS = 300_000;

export interface TrellisAuthProviderOptions {
  homeDir: string;
  serverName: string;
  /** Test seam; defaults to the gateway window. */
  skewMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Fired when pre-request resolution produced a credential while this
   * server sat in auth-required — the backend restores its status. */
  onCredentialRecovered?: () => void;
  /** Fired when the 401-forced refresh failed — the backend marks this
   * server auth-required with the OAuth remediation. */
  onCredentialFailure?: (err: unknown) => void;
}

/**
 * The SDK `AuthProvider` for one Trellis-owned OAuth upstream: `token()`
 * runs as each outbound request's headers are assembled, so credentials
 * resolve per request instead of once at connect time.
 *
 * Every read goes back to the token file with no memory cache — that is
 * what makes a refresh by `trellis mcp auth` in another terminal take
 * effect on the very next request of a running gateway (D6).
 */
export function trellisAuthProvider(opts: TrellisAuthProviderOptions): AuthProvider {
  let lastIssued: string | undefined;
  return {
    token: async () => {
      try {
        const token = await ensureFreshToken(opts.homeDir, opts.serverName, {
          skewMs: opts.skewMs ?? GATEWAY_REFRESH_SKEW_MS,
          fetchImpl: opts.fetchImpl,
          now: opts.now,
        });
        if (!token) return undefined;
        lastIssued = token.accessToken;
        opts.onCredentialRecovered?.();
        return token.accessToken;
      } catch {
        // The pre-request credential check must never abort the request
        // pipeline (D3): send whatever is stored — possibly stale — and
        // let the server's 401 path decide the outcome.
        return readToken(opts.homeDir, opts.serverName)?.accessToken;
      }
    },
    onUnauthorized: async () => {
      // The server just rejected a token that looked fine locally; the
      // expiry check is exactly what must be bypassed. The transport
      // retries the request once after this resolves — and when this
      // throws instead, the SDK propagates the error to this one call
      // as-is (pinned by test), so the message names the way out.
      try {
        await forceRefresh(opts.homeDir, opts.serverName, {
          previousAccessToken: lastIssued,
          fetchImpl: opts.fetchImpl,
          now: opts.now,
        });
      } catch (err) {
        opts.onCredentialFailure?.(err);
        const base = err instanceof Error ? err.message : String(err);
        throw new RefreshError(
          base.includes("trellis mcp auth")
            ? base
            : `${base} — run \`trellis mcp auth ${opts.serverName}\` in a human terminal; the running gateway picks the new credential up on its next request`,
          err instanceof RefreshError ? err.oauthError : undefined,
        );
      }
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
