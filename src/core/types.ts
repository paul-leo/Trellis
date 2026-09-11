/**
 * Canonical schema types. These mirror the `.trellis/` directory layout
 * documented in docs/architecture.md — this file is the source of truth
 * for what a "canonical source" object looks like in memory; the YAML/MD
 * files on disk are its serialization, not the other way around.
 */

export type Transport = "stdio" | "http";

export interface McpServerDef {
  transport: Transport;
  /** stdio only */
  command?: string;
  args?: string[];
  /** http only */
  url?: string;
  auth?: "oauth" | "bearer-env";
  /**
   * Variable NAMES the server process needs, never values. See
   * docs/research.md "Secrets" and schema/secrets.policy.example.yaml.
   */
  env?: string[];
}

export interface McpConfig {
  servers: Record<string, McpServerDef>;
  /**
   * Server names a host environment (e.g. mirasim) is known to inject at
   * runtime. An adapter must refuse to define a local server under any of
   * these names — see docs/research.md "Codex — three hard constraints" for
   * why a same-name collision is not a soft failure on every agent.
   */
  knownHostInjected: string[];
}

export interface SkillRef {
  name: string;
  /** Absolute path to the skill's directory. Must contain `SKILL.md` — the
   * filename is case-sensitive on at least one target agent (Codex). */
  dir: string;
}

export interface AgentProfile {
  name: string;
  /** Path to the profile's markdown file (Claude-style frontmatter today). */
  file: string;
}

export interface SecretsPolicy {
  allowedVars: string[];
  rejectPatterns: RegExp[];
}

export interface CanonicalSource {
  instructionsFile: string;
  skills: SkillRef[];
  agents: AgentProfile[];
  mcp: McpConfig;
  secretsPolicy: SecretsPolicy;
}
