/**
 * pi probe. Skill root and global instructions file are both under
 * `~/.pi/agent` — confirmed by direct source read of
 * `@earendil-works/pi-coding-agent`'s `dist/core/skills.js` (`loadSkills`)
 * and `dist/core/resource-loader.js` (`loadContextFileFromDir(resolvedAgentDir)`),
 * not by assumption. See design.md D5 (openspec/changes/trellis-doctor-p0).
 *
 * pi >= 1.1.0 has a native MCP client (`~/.pi/agent/mcp.json`), which the
 * adapter manages (trellis-pi-native-mcp-migration); the probe still
 * reports `mcpServers: []` because server health is the runtime's job,
 * not the probe's. `probePiVersion` is split out so the adapter's
 * native-vs-bridge version gate shares exactly this exec and tests can
 * inject a seam.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathRef, scanSkillRoot } from "../lib/probeCommon.js";
import type { AgentSnapshot } from "../core/types.js";

export function probePiVersion(): string | undefined {
  try {
    return execFileSync("pi", ["--version"], { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch {
    return undefined;
  }
}

/** Priority order pi itself checks (`loadContextFileFromDir`), first match wins. */
const INSTRUCTIONS_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export async function probe(homeDir: string = homedir()): Promise<AgentSnapshot> {
  const agentDir = join(homeDir, ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");
  const skillsPath = join(agentDir, "skills");

  const present = existsSync(settingsPath) || existsSync(skillsPath);
  if (!present) {
    return { agent: "pi", present: false, skillRoots: [], mcpServers: [], diagnostics: [] };
  }

  // config can exist without the binary on PATH — unusual, still probeable
  const version = probePiVersion();

  const skillRoot = scanSkillRoot(skillsPath);

  let instructionsFile: AgentSnapshot["instructionsFile"];
  for (const candidate of INSTRUCTIONS_CANDIDATES) {
    const ref = pathRef(join(agentDir, candidate));
    if (ref) {
      instructionsFile = ref;
      break;
    }
  }

  return {
    agent: "pi",
    present: true,
    version,
    skillRoots: skillRoot ? [skillRoot] : [],
    mcpServers: [],
    instructionsFile,
    diagnostics: [],
  };
}
