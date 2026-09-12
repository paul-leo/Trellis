/**
 * Kiro probe: same shape as Claude Code — `~/.kiro/settings/mcp.json`,
 * `~/.kiro/skills`, `~/.kiro/steering/CLAUDE.md`. No subagent concept
 * confirmed for Kiro (docs/research.md), so `subagentsDir` is never set.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeMcpServer } from "../lib/mcpProbe.js";
import { pathRef, readJsonFile, resolveEnvRefs, scanSkillRoot } from "../lib/probeCommon.js";
import type { AgentSnapshot, AgentSnapshotMcpServer, Transport } from "../core/types.js";

interface KiroMcpServerDef {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

interface KiroMcpJson {
  mcpServers?: Record<string, KiroMcpServerDef>;
}

export interface ProbeOptions {
  /** Spawn each configured stdio server for a live handshake. Off by
   * default — see docs/architecture.md "MCP handshake probing is opt-in". */
  probeMcp?: boolean;
}

export async function probe(homeDir: string = homedir(), opts: ProbeOptions = {}): Promise<AgentSnapshot> {
  const mcpJsonPath = join(homeDir, ".kiro", "settings", "mcp.json");
  const skillsPath = join(homeDir, ".kiro", "skills");
  const steeringPath = join(homeDir, ".kiro", "steering", "CLAUDE.md");

  const mcpJson = readJsonFile<KiroMcpJson>(mcpJsonPath);
  const present = mcpJson !== undefined || pathRef(skillsPath) !== undefined || pathRef(steeringPath) !== undefined;

  if (!present) {
    return { agent: "kiro", present: false, skillRoots: [], mcpServers: [], diagnostics: [] };
  }

  let version: string | undefined;
  try {
    version = execFileSync("kiro-cli", ["--version"], { encoding: "utf-8" }).trim();
  } catch {
    // binary not on PATH — config existing without it is still probeable
  }

  const mcpServers: AgentSnapshotMcpServer[] = Object.entries(mcpJson?.mcpServers ?? {}).map(([name, def]) => ({
    name,
    transport: def.url ? "http" : ("stdio" as Transport),
  }));

  if (opts.probeMcp) {
    await Promise.all(
      Object.entries(mcpJson?.mcpServers ?? {}).map(async ([name, def], index) => {
        if (def.url || !def.command) return;
        mcpServers[index].probe = await probeMcpServer(
          { transport: "stdio", command: def.command, args: def.args },
          resolveEnvRefs(def.env, process.env),
        );
      }),
    );
  }

  const skillRoot = scanSkillRoot(skillsPath);

  return {
    agent: "kiro",
    present: true,
    version,
    skillRoots: skillRoot ? [skillRoot] : [],
    mcpServers,
    instructionsFile: pathRef(steeringPath),
    diagnostics: [],
  };
}
