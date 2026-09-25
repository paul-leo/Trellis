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
import { delimiter, join } from "node:path";
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

/**
 * Codex resolves its config through HOME, but Volta's shim resolves its own
 * installation through VOLTA_HOME. A probe against a scratch HOME must keep
 * those identities separate or `codex mcp list` fails before it can read the
 * scratch config.
 */
export function codexEnv(homeDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const voltaHome = env.VOLTA_HOME ?? join(homedir(), ".volta");
  const voltaBin = join(voltaHome, "bin");
  const pathParts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const hasVolta = existsSync(voltaBin);
  if (hasVolta && !pathParts.includes(voltaBin)) pathParts.unshift(voltaBin);
  return {
    ...env,
    HOME: homeDir,
    // A host may inject CODEX_HOME for its own relay/session state. It has
    // higher priority than HOME inside Codex, so override it as well or a
    // scratch-home probe silently reads the host's real configuration.
    CODEX_HOME: join(homeDir, ".codex"),
    ...(hasVolta ? { VOLTA_HOME: voltaHome } : {}),
    ...(pathParts.length ? { PATH: pathParts.join(delimiter) } : {}),
  };
}

export async function probe(homeDir: string = homedir(), opts: ProbeOptions = {}): Promise<AgentSnapshot> {
  const configTomlPath = join(homeDir, ".codex", "config.toml");

  if (!existsSync(configTomlPath)) {
    return { agent: "codex", present: false, skillRoots: [], mcpServers: [], diagnostics: [] };
  }

  const diagnostics: string[] = [];
  // `codex` resolves its own config via $HOME (confirmed by running it with
  // an overridden HOME against an empty scratch dir — it returns `[]`, not
  // the real machine's servers), so every subprocess call here must be
  // scoped to `homeDir` explicitly — otherwise a caller probing a non-
  // default `homeDir` would silently get this real machine's real MCP
  // server list instead (trellis-migrate-mcp-servers found this gap in
  // src/lib/mcpMigrateRead.ts's own equivalent call; fixed there first).
  const scopedCodexEnv = codexEnv(homeDir);

  let version: string | undefined;
  try {
    version = execFileSync("codex", ["--version"], { encoding: "utf-8", timeout: 5_000, env: scopedCodexEnv }).trim();
  } catch {
    // config exists without the binary on PATH — unusual, still probeable
  }

  let mcpEntries: CodexMcpEntry[] = [];
  try {
    const raw = execFileSync("codex", ["mcp", "list", "--json"], { encoding: "utf-8", timeout: 5_000, env: scopedCodexEnv });
    mcpEntries = JSON.parse(raw) as CodexMcpEntry[];
  } catch (err) {
    // ENOENT means the binary itself isn't on PATH — the same benign,
    // config-without-binary condition the `--version` check above already
    // swallows silently, not a real failure worth alarming the user with a
    // raw spawn error string. Anything else (malformed JSON, a non-zero
    // exit for another reason, a timeout) is a genuine, unexpected failure
    // and stays a diagnostic.
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      diagnostics.push(`codex mcp list --json failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
