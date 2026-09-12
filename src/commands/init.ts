/**
 * `trellis init` — bootstraps a minimal, valid `~/.trellis/` if one
 * doesn't already exist, per-file (never overwrites an existing file;
 * fills in only what's missing — trellis-cli-init). `loadCanonicalSource`
 * only actually requires the `.trellis/` directory itself to exist; this
 * command exists because an empty directory gives a new user nothing to
 * act on.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId } from "../core/types.js";

export interface RunInitOptions {
  json?: boolean;
  /** Defaults to the real `~`; overridable for tests only — same seam
   * every other Trellis entry point uses. */
  homeDir?: string;
}

export interface InitFileResult {
  path: string;
  action: "create" | "already-present";
}

export interface AgentPointer {
  agent: AgentId;
  present: boolean;
  message: string;
}

export interface InitReport {
  files: InitFileResult[];
  agents: AgentPointer[];
}

/** Exported so `migrate` can byte-compare canonical `agents.md` against
 * this exact string (design.md D3, trellis-cli-migrate) rather than
 * retyping an equivalent one that could silently drift from this. */
export const AGENTS_MD_TEMPLATE = `# Shared instructions

Write what every agent should know here — communication preferences,
project conventions, anything you'd otherwise repeat per agent.

Already using Claude Code, Codex, Kiro, or pi? \`trellis migrate --from
<agent>\` imports its real instructions and skills instead of starting
from this placeholder.
`;

/**
 * `known_host_injected` starts empty deliberately (design.md D3, D1):
 * seeding it with any specific runtime's connector names (e.g. this
 * project's own mirasim) would be actively wrong on a machine without
 * that runtime. \`trellis doctor\`'s collision check reads this file's
 * real value once it exists, so leaving it empty is not just a stub —
 * it accurately means "nothing known to be host-injected here yet."
 */
function serversYamlTemplate(): string {
  return `# See schema/servers.example.yaml for the full documented shape
# (transports, env references, agent scoping, hub mode).
servers: {}

# Names a host environment (e.g. mirasim) injects into an agent process
# at runtime. A same-name static definition here would collide with it —
# on Codex that crashes the whole process at startup, not just that one
# server. Leave empty until you know what your own host injects; run
# \`trellis doctor\` to find out. See docs/research.md "Codex — three
# hard constraints".
known_host_injected: []
`;
}

/**
 * Reads schema/secrets.policy.example.yaml's own \`reject_patterns\`
 * rather than retyping them — those patterns are reviewed, shipped
 * content; duplicating them here would let the two drift (design.md D1).
 */
function secretsPolicyYamlTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const examplePath = join(here, "..", "..", "schema", "secrets.policy.example.yaml");
  const parsed = parseYaml(readFileSync(examplePath, "utf-8")) as { reject_patterns?: string[] };
  const patterns = parsed.reject_patterns ?? [];
  const patternLines = patterns.map((p) => `  - '${p}'`).join("\n");
  return `# See schema/secrets.policy.example.yaml for the full documented shape
# (env_file, what it does and doesn't protect).
allowed_vars: []

# Seeded from schema/secrets.policy.example.yaml's own reviewed list —
# generic credential shapes, not specific to any one project.
reject_patterns:
${patternLines}
`;
}

function ensureFile(path: string, template: string): InitFileResult {
  if (existsSync(path)) {
    return { path, action: "already-present" };
  }
  writeFileSync(path, template);
  return { path, action: "create" };
}

export async function collectInitReport(homeDir: string = homedir()): Promise<InitReport> {
  const root = join(homeDir, ".trellis");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "mcp"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "memories"), { recursive: true });

  const files: InitFileResult[] = [
    ensureFile(join(root, "agents.md"), AGENTS_MD_TEMPLATE),
    ensureFile(join(root, "mcp", "servers.yaml"), serversYamlTemplate()),
    ensureFile(join(root, "secrets.policy.yaml"), secretsPolicyYamlTemplate()),
  ];

  const probes: { agent: AgentId; run: () => Promise<{ present: boolean }> }[] = [
    { agent: "claude-code", run: () => claudeCodeProbe.probe(homeDir) },
    { agent: "codex", run: () => codexProbe.probe(homeDir) },
    { agent: "kiro", run: () => kiroProbe.probe(homeDir) },
    { agent: "pi", run: () => piProbe.probe(homeDir) },
  ];
  const settled = await Promise.allSettled(probes.map((p) => p.run()));
  const agents: AgentPointer[] = settled.map((result, index) => {
    const agent = ALL_AGENTS[index];
    const present = result.status === "fulfilled" && result.value.present;
    const message = present
      ? `${agent} is present — run \`trellis migrate --from ${agent}\` to import its skills and instructions`
      : `${agent} — not detected on this machine`;
    return { agent, present, message };
  });

  return { files, agents };
}

export async function runInit(opts: RunInitOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const report = await collectInitReport(homeDir);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return { exitCode: 0 };
}

function printReport(report: InitReport): void {
  const created = report.files.filter((f) => f.action === "create");
  if (created.length === 0) {
    console.log("~/.trellis already fully initialized — nothing to create.");
  } else {
    console.log(`Created ${created.length} file(s):`);
    for (const f of created) console.log(`  - ${f.path}`);
  }
  const alreadyPresent = report.files.filter((f) => f.action === "already-present");
  for (const f of alreadyPresent) console.log(`  - ${f.path} (already present, left untouched)`);

  console.log("");
  for (const a of report.agents) console.log(a.message);
}
