/**
 * pi probe. Skill root and global instructions file are both under
 * `~/.pi/agent` — confirmed by direct source read of
 * `@earendil-works/pi-coding-agent`'s `dist/core/skills.js` (`loadSkills`)
 * and `dist/core/resource-loader.js` (`loadContextFileFromDir(resolvedAgentDir)`),
 * not by assumption. See design.md D5 (openspec/changes/trellis-doctor-p0).
 *
 * pi has no native MCP client (docs/research.md) — nothing to read or
 * probe, so `mcpServers` is always empty here. That's real information
 * (this is why P4 has to write a runtime bridge extension instead of
 * generating config), not an omission.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathRef, scanSkillRoot } from "../lib/probeCommon.js";
import type { AgentSnapshot } from "../core/types.js";

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

  let version: string | undefined;
  try {
    version = execFileSync("pi", ["--version"], { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch {
    // config exists without the binary on PATH — unusual, still probeable
  }

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
