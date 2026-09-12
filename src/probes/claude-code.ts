/**
 * Claude Code probe: `~/.claude.json` (`mcpServers`), `~/.claude/skills`,
 * `~/.claude/agents`, `~/.claude/CLAUDE.md`. Built first (tasks.md 4.1) to
 * validate the shared `AgentSnapshot` shape before the other three probes
 * commit to it.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeMcpServer } from "../lib/mcpProbe.js";
import { countDirEntries, pathRef, readJsonFile, resolveEnvRefs, scanSkillRoot } from "../lib/probeCommon.js";
import type { AgentSnapshot, AgentSnapshotMcpServer, Transport } from "../core/types.js";

interface ClaudeJsonServerDef {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

interface ClaudeJson {
  mcpServers?: Record<string, ClaudeJsonServerDef>;
}

export interface ProbeOptions {
  /** Spawn each configured stdio server for a live handshake. Off by
   * default — see docs/architecture.md "MCP handshake probing is opt-in". */
  probeMcp?: boolean;
}

export async function probe(homeDir: string = homedir(), opts: ProbeOptions = {}): Promise<AgentSnapshot> {
  const claudeJson = readJsonFile<ClaudeJson>(join(homeDir, ".claude.json"));

  if (claudeJson === undefined) {
    return { agent: "claude-code", present: false, skillRoots: [], mcpServers: [], diagnostics: [] };
  }

  let version: string | undefined;
  try {
    version = execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim();
  } catch {
    // Config exists without the CLI on PATH — still probeable, just unversioned.
  }

  const mcpServers: AgentSnapshotMcpServer[] = Object.entries(claudeJson.mcpServers ?? {}).map(([name, def]) => ({
    name,
    transport: def.url ? "http" : ("stdio" as Transport),
  }));

  if (opts.probeMcp) {
    await Promise.all(
      Object.entries(claudeJson.mcpServers ?? {}).map(async ([name, def], index) => {
        if (def.url || !def.command) return;
        mcpServers[index].probe = await probeMcpServer(
          { transport: "stdio", command: def.command, args: def.args },
          resolveEnvRefs(def.env, process.env),
        );
      }),
    );
  }

  const skillRoot = scanSkillRoot(join(homeDir, ".claude", "skills"));
  const agentsDir = join(homeDir, ".claude", "agents");
  const agentsRef = pathRef(agentsDir);

  return {
    agent: "claude-code",
    present: true,
    version,
    skillRoots: skillRoot ? [skillRoot] : [],
    mcpServers,
    instructionsFile: pathRef(join(homeDir, ".claude", "CLAUDE.md")),
    subagentsDir: agentsRef ? { ...agentsRef, count: countDirEntries(agentsDir) } : undefined,
    diagnostics: [],
  };
}
