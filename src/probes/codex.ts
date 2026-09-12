/**
 * Codex probe: MCP inventory via `codex mcp list --json` (design.md D2),
 * not TOML parsing — Codex already exposes this, so a read-only phase has
 * no reason to hand-roll a parser P2 will need to get right for writes
 * anyway. Skill root is `~/.agents/skills` (Codex's own convention,
 * confirmed in docs/research.md); `~/.codex/skills` is reported as a
 * second skill root so `doctor`'s within-agent duplication check
 * (src/commands/doctor.ts) can catch a physical copy living there —
 * exactly the regression already found and fixed once in this project.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeMcpServer } from "../lib/mcpProbe.js";
import { pathRef, resolveEnvRefs, scanSkillRoot } from "../lib/probeCommon.js";
import type { AgentSnapshot, AgentSnapshotMcpServer, Transport } from "../core/types.js";

interface CodexMcpEntry {
  name: string;
  enabled: boolean;
  transport: {
    type: string;
    command?: string;
    args?: string[];
    env_vars?: string[];
  };
}

/**
 * P0-only heuristic extraction of the single top-level `instructions = "..."`
 * key — not a TOML parser, and never feeds a write path. P2's writer uses a
 * real TOML library (docs/research.md "Codex — three hard constraints" #3);
 * this exists purely to display where Codex's instructions file lives.
 */
export function readInstructionsPath(configTomlPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(configTomlPath, "utf-8");
  } catch {
    return undefined;
  }
  return /^\s*instructions\s*=\s*"([^"]*)"/m.exec(content)?.[1];
}

export interface ProbeOptions {
  /** Spawn each configured stdio server for a live handshake. Off by
   * default — see docs/architecture.md "MCP handshake probing is opt-in". */
  probeMcp?: boolean;
}

export async function probe(homeDir: string = homedir(), opts: ProbeOptions = {}): Promise<AgentSnapshot> {
  const configTomlPath = join(homeDir, ".codex", "config.toml");

  if (!existsSync(configTomlPath)) {
    return { agent: "codex", present: false, skillRoots: [], mcpServers: [], diagnostics: [] };
  }

  const diagnostics: string[] = [];

  let version: string | undefined;
  try {
    version = execFileSync("codex", ["--version"], { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch {
    // config exists without the binary on PATH — unusual, still probeable
  }

  let mcpEntries: CodexMcpEntry[] = [];
  try {
    const raw = execFileSync("codex", ["mcp", "list", "--json"], { encoding: "utf-8", timeout: 5_000 });
    mcpEntries = JSON.parse(raw) as CodexMcpEntry[];
  } catch (err) {
    diagnostics.push(`codex mcp list --json failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mcpServers: AgentSnapshotMcpServer[] = mcpEntries.map((entry) => ({
    name: entry.name,
    transport: entry.transport.type === "stdio" ? "stdio" : ("http" as Transport),
  }));

  if (opts.probeMcp) {
    await Promise.all(
      mcpEntries.map(async (entry, index) => {
        if (!entry.enabled || entry.transport.type !== "stdio" || !entry.transport.command) return;
        mcpServers[index].probe = await probeMcpServer(
          { transport: "stdio", command: entry.transport.command, args: entry.transport.args },
          resolveEnvRefs(entry.transport.env_vars, process.env),
        );
      }),
    );
  }

  const primaryRoot = scanSkillRoot(join(homeDir, ".agents", "skills"));
  const codexOwnRoot = scanSkillRoot(join(homeDir, ".codex", "skills"));
  const skillRoots = [primaryRoot, codexOwnRoot].filter((r): r is NonNullable<typeof r> => r !== undefined);

  const instructionsPath = readInstructionsPath(configTomlPath);

  return {
    agent: "codex",
    present: true,
    version,
    skillRoots,
    mcpServers,
    instructionsFile: instructionsPath ? pathRef(instructionsPath) : undefined,
    diagnostics,
  };
}
