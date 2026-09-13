/**
 * Loads `~/.trellis/` into a `CanonicalSource`. Global only — no `root`
 * parameter, no workspace merge (docs/architecture.md "Global vs.
 * workspace scope"). See openspec/changes/trellis-sync-p1/specs/
 * canonical-source-loading/spec.md for the exact contract this implements.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentId, AgentProfile, CanonicalSource, McpConfig, McpServerDef, MemoryEntry, Scope, SecretsPolicy, SkillRef } from "./types.js";
import { ALL_AGENTS } from "./types.js";

interface ScopeYaml {
  skills?: Record<string, AgentId[]>;
  agents?: Record<string, AgentId[]>;
  memories?: Record<string, AgentId[]>;
}

interface ServersYaml {
  servers?: Record<string, McpServerDef>;
  known_host_injected?: string[];
  hub?: { url: string };
}

interface SecretsPolicyYaml {
  allowed_vars?: string[];
  reject_patterns?: string[];
  env_file?: string;
}

interface ManagedYaml {
  agents?: string[];
}

function trellisRoot(homeDir: string): string {
  return join(homeDir, ".trellis");
}

function listMarkdownFiles(dir: string): { name: string; file: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name: basename(name, ".md"), file: join(dir, name) }));
}

function listSkillDirs(dir: string): { name: string; dir: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: { name: string; dir: string }[] = [];
  for (const name of entries) {
    const skillDir = join(dir, name);
    try {
      if (statSync(skillDir).isDirectory()) {
        skills.push({ name, dir: skillDir });
      }
    } catch {
      // unreadable/broken entry — skip, not a load failure
    }
  }
  return skills;
}

function loadScopeYaml(path: string): ScopeYaml {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = parseYaml(readFileSync(path, "utf-8"));
  return (parsed ?? {}) as ScopeYaml;
}

function loadServersYaml(path: string): McpConfig {
  if (!existsSync(path)) {
    return { servers: {}, knownHostInjected: [] };
  }
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as ServersYaml;
  return {
    servers: parsed.servers ?? {},
    knownHostInjected: parsed.known_host_injected ?? [],
    hub: parsed.hub,
  };
}

function loadSecretsPolicyYaml(path: string, homeDir: string): SecretsPolicy {
  if (!existsSync(path)) {
    return { allowedVars: [], rejectPatterns: [] };
  }
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as SecretsPolicyYaml;
  return {
    allowedVars: parsed.allowed_vars ?? [],
    rejectPatterns: (parsed.reject_patterns ?? []).map((pattern) => new RegExp(pattern)),
    envFile: parsed.env_file ? parsed.env_file.replace(/^~(?=$|\/)/, homeDir) : undefined,
  };
}

/** `undefined` if the name has no entry in scope.yaml's map — "shared with
 * all four agents," the default. A recognized but empty list is left as
 * authored (an explicitly agent-less scope), not coerced to "all". */
/** Missing file and `agents: []` both resolve to `[]` — zero managed
 * agents (D1), never "everyone." An unrecognized id is dropped with a
 * diagnostic, same posture as an unrecognized scope.yaml agent id. */
function loadManagedYaml(path: string, diagnostics: string[]): AgentId[] {
  if (!existsSync(path)) {
    return [];
  }
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as ManagedYaml;
  const raw = parsed.agents ?? [];
  const valid: AgentId[] = [];
  for (const id of raw) {
    if ((ALL_AGENTS as readonly string[]).includes(id)) {
      valid.push(id as AgentId);
    } else {
      diagnostics.push(`managed.yaml: "${id}" is not a recognized agent id — ignored`);
    }
  }
  return valid;
}

function scopeFor(map: Record<string, AgentId[]> | undefined, name: string): Scope {
  return map?.[name];
}

function validAgentIds(scope: AgentId[] | undefined): scope is AgentId[] {
  if (!scope) return true;
  return scope.every((id) => (ALL_AGENTS as readonly string[]).includes(id));
}

/**
 * `homeDir` defaults to the real `~` and is only ever overridden for tests
 * and `scripts/sandbox.sh` — the same seam P0's probes use
 * (src/probes/*.ts) and for the same reason: never touch a developer's
 * real dotfiles from a test. It is not a workspace/project root — see
 * specs/canonical-source-loading's global-only requirement, which this
 * parameter does not weaken.
 */
export function loadCanonicalSource(homeDir: string = homedir()): CanonicalSource {
  const root = trellisRoot(homeDir);
  if (!existsSync(root)) {
    throw new Error(
      `No canonical source at ${root}. Create it before running trellis sync — see docs/architecture.md's canonical schema.`,
    );
  }

  const diagnostics: string[] = [];
  const managedAgents = loadManagedYaml(join(root, "managed.yaml"), diagnostics);
  const scopeYaml = loadScopeYaml(join(root, "scope.yaml"));

  const skillDirs = listSkillDirs(join(root, "skills"));
  const knownSkillNames = new Set(skillDirs.map((s) => s.name));
  const skills: SkillRef[] = skillDirs.map(({ name, dir }) => ({ name, dir, scope: scopeFor(scopeYaml.skills, name) }));

  const agentFiles = listMarkdownFiles(join(root, "agents"));
  const knownAgentProfileNames = new Set(agentFiles.map((a) => a.name));
  const agents: AgentProfile[] = agentFiles.map(({ name, file }) => ({
    name,
    file,
    scope: scopeFor(scopeYaml.agents, name),
  }));

  const memoryFiles = listMarkdownFiles(join(root, "memories"));
  const knownMemoryNames = new Set(memoryFiles.map((m) => m.name));
  const memories: MemoryEntry[] = memoryFiles.map(({ name, file }) => ({
    name,
    file,
    scope: scopeFor(scopeYaml.memories, name),
  }));

  for (const [section, known] of [
    ["skills", knownSkillNames],
    ["agents", knownAgentProfileNames],
    ["memories", knownMemoryNames],
  ] as const) {
    const map = scopeYaml[section];
    for (const name of Object.keys(map ?? {})) {
      if (!known.has(name)) {
        diagnostics.push(`scope.yaml: "${section}.${name}" does not match any known ${section.slice(0, -1)} — ignored`);
      } else if (!validAgentIds(map?.[name])) {
        diagnostics.push(`scope.yaml: "${section}.${name}" lists an unrecognized agent id — ignored`);
      }
    }
  }

  return {
    instructionsFile: join(root, "agents.md"),
    managedAgents,
    skills,
    agents,
    memories,
    mcp: loadServersYaml(join(root, "mcp", "servers.yaml")),
    // P2's pre-write guard (src/adapters/mcpPlan.ts) uses its own narrow,
    // hardcoded floor instead of this field — see design.md D1 in
    // trellis-secrets-audit-p3.
    secretsPolicy: loadSecretsPolicyYaml(join(root, "secrets.policy.yaml"), homeDir),
    diagnostics,
  };
}
