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
import type { AgentId, McpConfig, McpServerDef, SecretsPolicy } from "../core/types.js";
import { codexBearerTokenEnvVar } from "../lib/tomlSection.js";
import { resolveSecretEnv } from "../lib/secretEnv.js";

export const HUB_ENTRY_NAME = "trellis-hub";
export const GATEWAY_ENTRY_NAME = "trellis-gateway";

/** The command an agent spawns in gateway mode. Bare `trellis` rather than
 * an absolute path: the entry has to keep working across reinstalls and
 * version bumps, and every agent resolves it through the same PATH the
 * user installed the CLI onto. */
export const GATEWAY_COMMAND = "trellis";

/**
 * Gateway mode applies to every managed agent when `agents` is omitted —
 * the expected normal case (design.md D14). An explicit list narrows it,
 * letting some agents stay in direct or hub mode.
 */
export function isGatewayAgent(agentId: AgentId, mcp: McpConfig, managedAgents: readonly AgentId[]): boolean {
  const gateway = mcp.gateway;
  if (!gateway?.enabled) return false;
  if (gateway.agents) return gateway.agents.includes(agentId);
  return managedAgents.includes(agentId);
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
 */
export function findLiteralSecret(def: McpServerDef): string | undefined {
  const candidates = [def.command, def.url, ...(def.args ?? []), ...Object.values(def.headers ?? {}), ...Object.values(def.staticEnv ?? {})].filter(
    (v): v is string => typeof v === "string",
  );
  for (const candidate of candidates) {
    for (const { label, pattern } of DANGEROUS_LITERAL_PATTERNS) {
      if (pattern.test(candidate)) {
        return label;
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
  // Checked before `hub`: only one entry can be "the" MCP entry for an
  // agent, and gateway is the newer, purpose-built path (design.md D6).
  // `hub` stays available, unchanged, for anyone pointing an agent at an
  // externally-operated endpoint — including a different agent in the
  // same canonical source.
  if (isGatewayAgent(agentId, mcp, managedAgents)) {
    if (mcp.knownHostInjected.includes(GATEWAY_ENTRY_NAME)) {
      return {
        desired: [],
        conflicts: [{ name: GATEWAY_ENTRY_NAME, message: collisionMessage(GATEWAY_ENTRY_NAME, agentId), remediation: collisionRemediation(GATEWAY_ENTRY_NAME) }],
      };
    }
    // Every per-server check (enabled, scope, literal secrets, unresolved
    // env names, Codex's header shape) still runs — but at gateway
    // *startup*, inside the subcommand, since no adapter sees an
    // individual server in this mode (design.md D6).
    return {
      desired: [{ name: GATEWAY_ENTRY_NAME, def: { transport: "stdio", command: GATEWAY_COMMAND, args: ["mcp-gateway", "--agent", agentId] } }],
      conflicts: [],
    };
  }

  if (mcp.hub) {
    if (mcp.knownHostInjected.includes(HUB_ENTRY_NAME)) {
      return {
        desired: [],
        conflicts: [{ name: HUB_ENTRY_NAME, message: collisionMessage(HUB_ENTRY_NAME, agentId), remediation: collisionRemediation(HUB_ENTRY_NAME) }],
      };
    }
    return { desired: [{ name: HUB_ENTRY_NAME, def: { transport: "http", url: mcp.hub.url } }], conflicts: [] };
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

    if (mcp.knownHostInjected.includes(name)) {
      conflicts.push({ name, message: collisionMessage(name, agentId), remediation: collisionRemediation(name) });
      continue;
    }

    const secretLabel = findLiteralSecret(def);
    if (secretLabel) {
      conflicts.push({
        name,
        message: `refusing to write MCP server "${name}": a value matches a known-dangerous literal pattern (${secretLabel}) — configs must hold variable NAMES only, never real values (docs/research.md "Secrets")`,
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
