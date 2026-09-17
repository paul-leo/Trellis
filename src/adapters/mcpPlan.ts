/**
 * Storage-agnostic MCP planning shared by all three adapters (Claude
 * Code, Codex, Kiro): given canonical MCP config + an agent id, resolves
 * which (name, def) entries should exist and which are refused
 * (collision or literal-secret conflicts). Never touches a file itself —
 * each adapter turns this into plan items using its own read/write
 * mechanism (JSON merge vs. TOML section splice).
 *
 * Removal is NOT decided here (design.md D7, trellis-mcp-sync-p2): unlike
 * a skill's symlink, a plain key has no ownership marker of its own, so
 * "not in canonical anymore" can't be distinguished from "the user
 * configured this directly" from this function's storage-agnostic view
 * alone. Each format-specific caller (`jsonMcp.ts`'s `planJsonMcp`,
 * `codex.ts`'s own `planMcp`) computes removal candidates itself, against
 * `src/lib/mcpOwnership.ts`'s ledger and that format's own current
 * on-disk content (trellis-mcp-lifecycle-parity) — this function only
 * ever returns create/repair + refuse.
 */

import { isInScope } from "../core/adapter.js";
import { capabilityDeliveryForAgent } from "../core/types.js";
import type { AgentId, McpConfig, McpRoute, McpServerDef, SecretsPolicy } from "../core/types.js";
import { codexBearerTokenEnvVar } from "../lib/tomlSection.js";
import { resolveSecretEnv } from "../lib/secretEnv.js";

export const HUB_ENTRY_NAME = "trellis-hub";
export const GATEWAY_ENTRY_NAME = "trellis-gateway";
export const RUNTIME_ENTRY_NAME = "trellis-runtime";

/** The command an agent spawns in gateway mode. Bare `trellis` rather than
 * an absolute path: the entry has to keep working across reinstalls and
 * version bumps, and every agent resolves it through the same PATH the
 * user installed the CLI onto. */
export const GATEWAY_COMMAND = "trellis";
export const RUNTIME_COMMAND = "trellis";

/**
 * Gateway mode applies to every managed agent when `agents` is omitted —
 * the expected normal case (design.md D14). An explicit list narrows it,
 * letting some agents stay in direct or hub mode.
 */
export function isGatewayAgent(agentId: AgentId, mcp: McpConfig, managedAgents: readonly AgentId[]): boolean {
  const route = mcp.routes?.[agentId];
  if (route) return route.mode === "gateway";
  const gateway = mcp.gateway;
  if (!gateway?.enabled) return false;
  if (gateway.agents) return gateway.agents.includes(agentId);
  return managedAgents.includes(agentId);
}

function routeForAgent(agentId: AgentId, mcp: McpConfig, managedAgents: readonly AgentId[]): McpRoute {
  const explicit = mcp.routes?.[agentId];
  if (explicit) return explicit;
  if (isGatewayAgent(agentId, mcp, managedAgents)) return { mode: "gateway" };
  if (mcp.hub) return { mode: "hub" };
  return { mode: "direct" };
}

export interface DesiredMcpEntry {
  name: string;
  def: McpServerDef;
}

export interface McpConflict {
  name: string;
  message: string;
  /** The concrete next action, distinct from `message`'s restatement of
   * why (trellis-onboard-closed-loop design.md D7). */
  remediation?: string;
}

export interface McpPlanResult {
  desired: DesiredMcpEntry[];
  conflicts: McpConflict[];
}

const CODEX_STDIO_URL_CRASH_NOTE =
  ' On Codex specifically, this crashes the entire process at startup ("url is not supported for stdio"), not just this one server — see docs/research.md.';

function collisionMessage(name: string, agentId: AgentId): string {
  return `refusing to write MCP server "${name}": also appears in known_host_injected.${agentId === "codex" ? CODEX_STDIO_URL_CRASH_NOTE : ""}`;
}

function collisionRemediation(name: string): string {
  return `rename this server in servers.yaml, or remove "${name}" from known_host_injected if it's no longer actually host-injected on this machine`;
}

/**
 * Known-dangerous literal patterns (design.md D5) — mirrors
 * schema/secrets.policy.example.yaml's own examples. A narrow, hardcoded
 * floor, not the full configurable policy (P3's job).
 */
const DANGEROUS_LITERAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "GitLab personal access token (glpat-)", pattern: /glpat-/ },
  { label: "OpenAI-style secret key (sk-)", pattern: /\bsk-[A-Za-z0-9]/ },
  { label: "GitHub personal access token (ghp_)", pattern: /ghp_/ },
  { label: "mcp-router token (mcpr_)", pattern: /mcpr_/ },
];

/** Which field on `McpServerDef` a literal-secret match came from —
 * `migrate`'s extraction path (trellis-migrate-extract-static-env-secrets
 * design.md D1) needs this to decide whether a natural variable name
 * exists to extract to: only `staticEnv` has one (its own dict key).
 * A match in any other field still just refuses, unchanged. */
export type LiteralSecretField = "command" | "url" | "args" | "headers" | "staticEnv";

export interface LiteralSecretMatch {
  label: string;
  field: LiteralSecretField;
  /** The dict key the match came from, only set for `staticEnv`/`headers`
   * (the only two `Record<string, string>` fields) — `migrate`'s
   * extraction path uses this as the variable name to extract to when
   * `field === "staticEnv"` (its own key is already a natural name). */
  key?: string;
}

/**
 * Exported so `migrate`'s own read path (`src/commands/migrate.ts`) can
 * apply the identical check on the way *into* canonical, not just on the
 * way out to an agent's native config. Found via real-machine dogfooding:
 * `migrate --from kiro --only mcp` happily copied a real, live
 * `MCPR_TOKEN` literal into `~/.trellis/mcp/servers.yaml` because this
 * check previously existed only here, in `resolveMcpPlan` — canonical
 * itself was never guarded, only the sync-out boundary was. A canonical
 * file that briefly held a real secret before a later `mcp sync` refused
 * to propagate it further already violates "never write a literal
 * secret, ever" — the write already happened, in a file meant to be
 * read, diffed, and committed as plain text. One shared implementation,
 * not two that can drift, for the same reason `mcpConnect.ts`/
 * `mcpToolRegistry.ts` are shared between pi-bridge and the gateway.
 *
 * Scanning order is `command, url, args, headers, staticEnv` — a def
 * matching in more than one field returns whichever is found first, same
 * as before this function reported a field at all.
 */
export function findLiteralSecret(def: McpServerDef): LiteralSecretMatch | undefined {
  const candidates: { value: string; field: LiteralSecretField; key?: string }[] = [
    ...(def.command !== undefined ? [{ value: def.command, field: "command" as const }] : []),
    ...(def.url !== undefined ? [{ value: def.url, field: "url" as const }] : []),
    ...(def.args ?? []).map((value) => ({ value, field: "args" as const })),
    ...Object.entries(def.headers ?? {}).map(([key, value]) => ({ value, field: "headers" as const, key })),
    ...Object.entries(def.staticEnv ?? {}).map(([key, value]) => ({ value, field: "staticEnv" as const, key })),
  ];
  for (const { value, field, key } of candidates) {
    for (const { label, pattern } of DANGEROUS_LITERAL_PATTERNS) {
      if (pattern.test(value)) {
        return { label, field, key };
      }
    }
  }
  return undefined;
}

/**
 * Name-only `env` entries that don't resolve to anything would otherwise
 * be written and silently break the agent's connection to that server —
 * found via real-machine dogfooding (trellis-mcp-static-env-and-disabled-servers
 * proposal.md "Why"). Uses the identical `resolveSecretEnv` `secrets
 * audit`/the pi bridge already call, so this and a later `secrets audit`
 * run can never disagree about what resolves.
 *
 * `envAliases`' values are themselves source variable names needing the
 * exact same resolution — checked in the same pass so a differently-named
 * reference gets the same pre-write refusal `env` already has, naming the
 * unresolved *source* name (what the caller must find a value for), not
 * the target key it would have been written under
 * (trellis-migrate-env-var-alias).
 */
function findUnresolvedEnvName(def: McpServerDef, policy: SecretsPolicy): string | undefined {
  const names = [...(def.env ?? []), ...Object.values(def.envAliases ?? {})];
  if (names.length === 0) return undefined;
  const resolved = resolveSecretEnv(names, policy);
  return names.find((name) => !resolved[name]);
}

export function resolveMcpPlan(agentId: AgentId, mcp: McpConfig, managedAgents: readonly AgentId[], policy: SecretsPolicy): McpPlanResult {
  const route = routeForAgent(agentId, mcp, managedAgents);
  const runtimeEnabled = capabilityDeliveryForAgent(agentId, mcp) !== "native";
  // Checked before `hub`: only one entry can be "the" MCP entry for an
  // agent, and gateway is the newer, purpose-built path (design.md D6).
  // `hub` stays available, unchanged, for anyone pointing an agent at an
  // externally-operated endpoint — including a different agent in the
  // same canonical source.
  if (route.mode === "gateway") {
    const entryName = runtimeEnabled ? RUNTIME_ENTRY_NAME : GATEWAY_ENTRY_NAME;
    if (mcp.knownHostInjected.includes(entryName)) {
      return {
        desired: [],
        conflicts: [{ name: entryName, message: collisionMessage(entryName, agentId), remediation: collisionRemediation(entryName) }],
      };
    }
    // Every per-server check (enabled, scope, literal secrets, unresolved
    // env names, Codex's header shape) still runs — but at gateway
    // *startup*, inside the subcommand, since no adapter sees an
    // individual server in this mode (design.md D6).
    return {
      desired: [{
        name: entryName,
        def: {
          transport: "stdio",
          command: runtimeEnabled ? RUNTIME_COMMAND : GATEWAY_COMMAND,
          args: [runtimeEnabled ? "mcp-runtime" : "mcp-gateway", "--agent", agentId],
        },
      }],
      conflicts: [],
    };
  }

  if (route.mode === "hub") {
    if (!mcp.hub) {
      return {
        desired: [],
        conflicts: [{
          name: HUB_ENTRY_NAME,
          message: `cannot resolve hub route "${agentId}": canonical mcp.hub.url is not configured`,
          remediation: `configure mcp.hub.url or choose direct/gateway mode for ${agentId}`,
        }],
      };
    }
    if (mcp.knownHostInjected.includes(HUB_ENTRY_NAME)) {
      return {
        desired: [],
        conflicts: [{ name: HUB_ENTRY_NAME, message: collisionMessage(HUB_ENTRY_NAME, agentId), remediation: collisionRemediation(HUB_ENTRY_NAME) }],
      };
    }
    if (route.servers) {
      return {
        desired: [],
        conflicts: [{
          name: HUB_ENTRY_NAME,
          message: `cannot restrict external hub route "${agentId}" to individual MCP servers: the hub owns its upstream set`,
          remediation: `remove the servers list from the ${agentId} hub route, or use direct/gateway mode for per-server selection`,
        }],
      };
    }
    const desired: DesiredMcpEntry[] = [{ name: HUB_ENTRY_NAME, def: { transport: "http", url: mcp.hub.url } }];
    if (runtimeEnabled) {
      if (mcp.knownHostInjected.includes(RUNTIME_ENTRY_NAME)) {
        return {
          desired: [],
          conflicts: [{ name: RUNTIME_ENTRY_NAME, message: collisionMessage(RUNTIME_ENTRY_NAME, agentId), remediation: collisionRemediation(RUNTIME_ENTRY_NAME) }],
        };
      }
      // The runtime provides Trellis-owned capabilities here. The external
      // hub remains the upstream MCP edge; the runtime does not connect to
      // canonical upstreams a second time for this route.
      desired.push({
        name: RUNTIME_ENTRY_NAME,
        def: { transport: "stdio", command: RUNTIME_COMMAND, args: ["mcp-runtime", "--agent", agentId] },
      });
    }
    return { desired, conflicts: [] };
  }

  if (runtimeEnabled) {
    if (mcp.knownHostInjected.includes(RUNTIME_ENTRY_NAME)) {
      return {
        desired: [],
        conflicts: [{ name: RUNTIME_ENTRY_NAME, message: collisionMessage(RUNTIME_ENTRY_NAME, agentId), remediation: collisionRemediation(RUNTIME_ENTRY_NAME) }],
      };
    }
    // Runtime mode owns the agent-facing MCP edge. It resolves the same
    // direct/gateway-compatible upstream route at startup, so native
    // per-server entries are not duplicated here.
    return {
      desired: [{
        name: RUNTIME_ENTRY_NAME,
        def: { transport: "stdio", command: RUNTIME_COMMAND, args: ["mcp-runtime", "--agent", agentId] },
      }],
      conflicts: [],
    };
  }

  const desired: DesiredMcpEntry[] = [];
  const conflicts: McpConflict[] = [];

  for (const [name, def] of Object.entries(mcp.servers)) {
    if (def.enabled === false) {
      continue;
    }

    if (!isInScope(agentId, def.agents, managedAgents)) {
      continue;
    }

    if (route.servers && !route.servers.includes(name)) {
      continue;
    }

    if (mcp.knownHostInjected.includes(name)) {
      conflicts.push({ name, message: collisionMessage(name, agentId), remediation: collisionRemediation(name) });
      continue;
    }

    // Only `staticEnv` is refused here: it's the one shape a real
    // credential is meant to leave via `env`/`env_vars`, proven to
    // resolve back to a real value for every consumer (pi-bridge,
    // claude-code, codex, kiro) — a literal surviving there means
    // something bypassed `migrate`'s own extraction (a hand-edited
    // servers.yaml, most likely) and must still be refused outright. A
    // match in `command`/`url`/`args`/`headers` is accepted and written
    // as ordinary literal config instead (trellis-migrate-extract-static-env-secrets
    // design.md D11) — none of those fields has a `${VAR}` resolution
    // mechanism proven across every consumer, so a fake reference there
    // would be strictly worse than the literal it replaced; `secrets
    // audit` keeps flagging canonical itself so this isn't silent.
    const secretMatch = findLiteralSecret(def);
    if (secretMatch?.field === "staticEnv") {
      conflicts.push({
        name,
        message: `refusing to write MCP server "${name}": a value matches a known-dangerous literal pattern (${secretMatch.label}) — configs must hold variable NAMES only, never real values (docs/research.md "Secrets")`,
        remediation: `replace the literal value in servers.yaml with a \`\${VAR_NAME}\` reference and put the real value wherever secrets.policy.yaml resolves it from`,
      });
      continue;
    }

    // Codex has no generic headers concept — only the single
    // Authorization-bearer-token shape is expressible there
    // (trellis-mcp-transport-auth design.md D4). Any other shape is
    // refused for Codex specifically; every other in-scope agent for
    // the same server is unaffected (this loop runs once per agentId).
    if (agentId === "codex" && def.headers && Object.keys(def.headers).length > 0 && !codexBearerTokenEnvVar(def)) {
      conflicts.push({
        name,
        message: `refusing to write MCP server "${name}" for codex: its "headers" field isn't the single { Authorization: "Bearer \${VAR}" } shape Codex's own config format can express — Codex has no generic headers concept, only \`bearer_token_env_var\`. Still written normally for every other in-scope agent.`,
        remediation: `reduce this server's headers to a single Authorization bearer token for Codex, enable gateway mode for Codex (which resolves headers itself and never hits this check), or accept that this server stays unreachable from Codex`,
      });
      continue;
    }

    const unresolvedName = findUnresolvedEnvName(def, policy);
    if (unresolvedName) {
      const source = policy.envFile ?? "process environment";
      conflicts.push({
        name,
        message: `refusing to write MCP server "${name}": its declared env var "${unresolvedName}" has no resolvable value in ${source} — writing it now would silently break this server's connection once the agent starts it (trellis-mcp-static-env-and-disabled-servers)`,
        remediation: `set "${unresolvedName}" in ${source}, or fix the name in servers.yaml if it was a typo, then re-run mcp sync`,
      });
      continue;
    }

    desired.push({ name, def });
  }

  return { desired, conflicts };
}
