/**
 * Kimi Code probe. Kimi 2.x stores user MCP declarations in
 * `~/.kimi-code/mcp.json`, user Skills in `~/.kimi-code/skills`, and global
 * instructions in `~/.kimi-code/AGENTS.md`. Kimi also discovers the generic
 * `~/.agents/skills` root; it is reported so doctor can observe it, while the
 * Runtime-only launcher can explicitly isolate it later.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeMcpServer } from "../lib/mcpProbe.js";
import { pathRef, readJsonFile, resolveEnvRefs, scanSkillRoot } from "../lib/probeCommon.js";
import type { AgentSnapshot, AgentSnapshotMcpServer, Transport } from "../core/types.js";

interface KimiMcpServerDef {
  transport?: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

interface KimiMcpConfig {
  mcpServers?: Record<string, KimiMcpServerDef>;
}

export interface ProbeOptions {
  probeMcp?: boolean;
}

function kimiEnv(homeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: homeDir, KIMI_CODE_HOME: join(homeDir, ".kimi-code") };
}

export async function probe(homeDir: string = homedir(), opts: ProbeOptions = {}): Promise<AgentSnapshot> {
  const root = join(homeDir, ".kimi-code");
  const mcpPath = join(root, "mcp.json");
  const mcpConfig = readJsonFile<KimiMcpConfig>(mcpPath);
  const kimiRoot = pathRef(root);
  if (kimiRoot === undefined) {
    return { agent: "kimi-code", present: false, skillRoots: [], mcpServers: [], diagnostics: [] };
  }
  let version: string | undefined;
  try {
    version = execFileSync("kimi", ["--version"], { encoding: "utf-8", timeout: 5_000, env: kimiEnv(homeDir) }).trim();
  } catch {
    // A config-only fixture remains probeable without a binary on PATH.
  }

  const mcpServers: AgentSnapshotMcpServer[] = Object.entries(mcpConfig?.mcpServers ?? {}).map(([name, def]) => ({
    name,
    transport: def.url ? (def.transport === "sse" ? "sse" : "http") : ("stdio" as Transport),
  }));

  if (opts.probeMcp) {
    await Promise.all(Object.entries(mcpConfig?.mcpServers ?? {}).map(async ([name, def], index) => {
      if (def.url || !def.command) return;
      mcpServers[index].probe = await probeMcpServer(
        { transport: "stdio", command: def.command, args: def.args },
        resolveEnvRefs(def.env, kimiEnv(homeDir)),
      );
    }));
  }

  const skillRoots = [
    scanSkillRoot(join(root, "skills")),
    scanSkillRoot(join(homeDir, ".agents", "skills")),
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  return {
    agent: "kimi-code",
    present: true,
    version,
    skillRoots,
    mcpServers,
    instructionsFile: pathRef(join(root, "AGENTS.md")),
    diagnostics: [],
  };
}
