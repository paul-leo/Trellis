/**
 * Canonical schema types. These mirror the `.trellis/` directory layout
 * documented in docs/architecture.md — this file is the source of truth
 * for what a "canonical source" object looks like in memory; the YAML/MD
 * files on disk are its serialization, not the other way around.
 */

export type Transport = "stdio" | "http" | "sse";

export type AgentId = "claude-code" | "codex" | "kiro" | "pi";

export const ALL_AGENTS: readonly AgentId[] = [
  "claude-code",
  "codex",
  "kiro",
  "pi",
];

/**
 * Every scopable item (skill, subagent, memory entry, MCP server) defaults
 * to "all four agents" when `scope` is omitted — sharing everywhere is the
 * common case Trellis exists for; restricting to specific agents is the
 * exception and must be declared explicitly. See docs/architecture.md
 * "Private / agent-specific capabilities".
 */
export type Scope = AgentId[] | undefined;

/**
 * `managedAgents` is the hard outer boundary (trellis-managed-agents
 * design.md D6): no-scope items resolve to it instead of `ALL_AGENTS`, and
 * an item WITH an explicit scope is intersected with it, never returned
 * verbatim — a skill scoped to `[kiro]` must still not reach Kiro if Kiro
 * isn't in the managed set. Presence on the machine is irrelevant here;
 * only membership in `managedAgents` is.
 */
export function resolveScope(scope: Scope, managedAgents: readonly AgentId[]): readonly AgentId[] {
  const candidates = scope ?? managedAgents;
  return candidates.filter((id) => managedAgents.includes(id));
}

export interface McpServerDef {
  transport: Transport;
  /** stdio only */
  command?: string;
  args?: string[];
  /** http/sse only */
  url?: string;
  /**
   * http/sse only. Values are `${VAR}` references, same discipline as
   * `env` — never a real value. Codex has no generic headers concept;
   * only the single shape `{ Authorization: "Bearer ${VAR}" }` is
   * expressible there (trellis-mcp-transport-auth design.md D4) — any
   * other shape is a Codex-only conflict, not silently dropped.
   */
  headers?: Record<string, string>;
  /**
   * Variable NAMES the server process needs, never values. See
   * docs/research.md "Secrets" and schema/secrets.policy.example.yaml.
   */
  env?: string[];
  /**
   * Literal, non-secret values written into the agent's config verbatim
   * — distinct from `env`'s names-only, resolved-at-runtime contract.
   * Still scanned against `reject_patterns` like every other literal
   * field (trellis-mcp-static-env-and-disabled-servers design.md D2):
   * this is for values that were never secrets (an email address, an
   * environment tag), not an escape hatch for real credentials.
   */
  staticEnv?: Record<string, string>;
  /**
   * Defaults to `true`. `false` keeps the definition in canonical
   * without writing it to any agent — matches a real host config's own
   * "defined but currently off" state (e.g. Codex's `enabled = false`)
   * that omitting the definition entirely can't represent, since that
   * would also throw away the definition itself.
   */
  enabled?: boolean;
  /** Omit for "all agents" (the default). See `Scope`. */
  agents?: Scope;
}

/**
 * If set, every agent's adapter writes exactly ONE entry — this URL —
 * instead of all N server definitions. What runs behind the URL (a
 * self-hosted mcp-hub, a hosted mcp-router account, anything else
 * speaking MCP over HTTP) is not Trellis's concern and not something
 * adapter code branches on — there is no "engine" switch to maintain.
 * See docs/architecture.md "MCP hub mode".
 */
export interface HubConfig {
  url: string;
}

export interface McpConfig {
  servers: Record<string, McpServerDef>;
  /**
   * Server names a host environment (e.g. mirasim) is known to inject at
   * runtime. Checked against every server name Trellis would write per
   * agent when `hub` is unset; against the single hub entry name only when
   * `hub` is set (there's nothing else to collide) — see docs/research.md
   * "Codex — three hard constraints" for why a same-name collision is not
   * a soft failure on every agent.
   */
  knownHostInjected: string[];
  /** Omit for direct mode (today's default: every agent gets all N server
   * definitions written into its native config). See `HubConfig`. */
  hub?: HubConfig;
}

export interface SkillRef {
  name: string;
  /** Absolute path to the skill's directory. Must contain `SKILL.md` — the
   * filename is case-sensitive on at least one target agent (Codex). */
  dir: string;
  /**
   * Omit for "all agents" (the default). Deliberately NOT read from
   * SKILL.md's own frontmatter — Codex validates SKILL.md frontmatter
   * against an allow-list of known keys and rejects unknown ones (see
   * docs/research.md), so a Trellis-only field embedded there would break
   * the skill on Codex specifically. Scope lives in `scope.yaml` instead,
   * outside every artifact the agents themselves parse.
   */
  scope?: Scope;
}

export interface AgentProfile {
  name: string;
  /** Path to the profile's markdown file (Claude-style frontmatter today). */
  file: string;
  /**
   * Omit for "all agents that support subagents" — today that's
   * Claude Code only (see docs/research.md: Codex has no persistent
   * subagent concept, Kiro/pi unconfirmed), so this is normally implicit,
   * not something you write. Only set explicitly once more than one agent
   * supports subagents and a profile should NOT go to all of them.
   */
  scope?: Scope;
}

export interface MemoryEntry {
  name: string;
  file: string;
  /** Omit for "all agents" (the default). See `Scope`. */
  scope?: Scope;
}

export interface SecretsPolicy {
  allowedVars: string[];
  rejectPatterns: RegExp[];
  /**
   * Absolute path to a dotenv-format file. When set, it is the SOLE
   * source `resolveSecretEnv` consults for a declared name — never
   * merged with `process.env` (src/lib/secretEnv.ts). Unset preserves
   * ambient-`process.env` resolution, the only behavior that existed
   * before this field did.
   */
  envFile?: string;
}

/**
 * Result of one MCP stdio handshake probe (src/lib/mcpProbe.ts). `ok:
 * false` always carries `error` — "configured but unreachable" and "never
 * attempted" must stay distinguishable in an AgentSnapshot, so there's no
 * silent-false path.
 */
export interface McpProbeResult {
  ok: boolean;
  serverInfo?: { name?: string; version?: string };
  error?: string;
  stderr?: string;
}

export interface AgentSnapshotSkillEntry {
  name: string;
  /** The skill's directory (what would be symlinked). */
  dir: string;
  /** Resolved realpath of `dir` — what duplication/drift comparison keys
   * on (design.md D3), never `dir` itself. */
  realDir: string;
  isSymlink: boolean;
  /** From `findSkillFile` — false means a same-named file exists with the
   * wrong case and was NOT picked up by the target agent. */
  caseCorrect: boolean;
}

export interface AgentSnapshotSkillRoot {
  path: string;
  isSymlink: boolean;
  target?: string;
  skills: AgentSnapshotSkillEntry[];
}

/**
 * Every entry here came from an agent's own persisted, static config — a
 * probe has no way to observe a host environment's runtime-only
 * injection (e.g. mirasim's `-c` overrides never touch the config file
 * probes read). The static-vs-known-host-injected classification spec.md
 * describes is a comparison `trellis doctor` computes against
 * `known_host_injected`, not a field a probe can set — see
 * src/commands/doctor.ts's collision check.
 */
export interface AgentSnapshotMcpServer {
  name: string;
  transport?: Transport;
  probe?: McpProbeResult;
}

export interface AgentSnapshotPathRef {
  path: string;
  isSymlink: boolean;
  target?: string;
}

/**
 * One shape for every agent (design.md D4) — agent-specific detail lives
 * inside each probe(), never in this type, so comparison logic in
 * src/commands/doctor.ts never special-cases an agent.
 */
export interface AgentSnapshot {
  agent: AgentId;
  present: boolean;
  version?: string;
  skillRoots: AgentSnapshotSkillRoot[];
  mcpServers: AgentSnapshotMcpServer[];
  instructionsFile?: AgentSnapshotPathRef;
  subagentsDir?: AgentSnapshotPathRef & { count: number };
  /** Non-fatal issues hit while probing (e.g. a config file failed to
   * parse) — a doctor finding, never silently swallowed. */
  diagnostics: string[];
}

export interface CanonicalSource {
  /**
   * Global (`~/.trellis`) only for now. Project-local `.trellis/` and its
   * merge-over-global precedence are an explicit non-goal until a later
   * phase — see docs/roadmap.md. Don't build workspace resolution ahead of
   * that decision.
   */
  instructionsFile: string;
  /** From `~/.trellis/managed.yaml`. Missing file and `agents: []` both
   * resolve to `[]` — zero managed agents, never "everyone" (D1). */
  managedAgents: readonly AgentId[];
  skills: SkillRef[];
  agents: AgentProfile[];
  memories: MemoryEntry[];
  mcp: McpConfig;
  secretsPolicy: SecretsPolicy;
  /** e.g. a `scope.yaml` entry naming a skill/agent/memory that doesn't
   * exist — recorded, not a load failure. See `loadCanonicalSource`. */
  diagnostics: string[];
}
