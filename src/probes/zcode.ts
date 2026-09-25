/**
 * ZCode probe and profile selection.
 *
 * ZCode has two public configuration layouts in circulation. The official
 * source/distribution reads ~/.zcode/cli/config.json, while the installed
 * zcode-app-cli compatibility distribution keeps runtime settings (including
 * mcp.servers) in ~/.zcode/cli/setting.json. We select one profile before any
 * adapter plans a write; writing both would make ZCode's native precedence
 * ambiguous and can hide a managed MCP entry.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { probeMcpServer } from "../lib/mcpProbe.js";
import { pathRef, readJsonFile, resolveEnvRefs, scanSkillRoot } from "../lib/probeCommon.js";
import type { AgentSnapshot, AgentSnapshotMcpServer, Transport } from "../core/types.js";

export type ZcodeProfileKind = "community-cli" | "official" | "configuration-only";

export interface ZcodeProfile {
  kind: ZcodeProfileKind;
  configPath: string;
  executable?: string;
  executableVersion?: string;
  supportsExecution: boolean;
}

interface ZcodeMcpServerDef {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

interface ZcodeConfig {
  mcp?: { servers?: Record<string, ZcodeMcpServerDef> };
}

export interface ProbeOptions {
  probeMcp?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function zcodeEnv(homeDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // A Node host can inherit Volta's selected Node binary without inheriting
  // Volta's shim directory in PATH. Keep the user's explicit PATH order, but
  // add the documented Volta bin location when necessary so `zcode` resolves
  // the same way it does in their interactive terminal.
  const voltaBin = env.VOLTA_HOME ? join(env.VOLTA_HOME, "bin") : undefined;
  const pathParts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (voltaBin && !pathParts.includes(voltaBin)) pathParts.unshift(voltaBin);
  return { ...env, HOME: homeDir, ...(pathParts.length ? { PATH: pathParts.join(delimiter) } : {}) };
}

function configPaths(homeDir: string): { community: string; official: string; root: string } {
  const root = join(homeDir, ".zcode");
  return {
    root,
    community: join(root, "cli", "setting.json"),
    official: join(root, "cli", "config.json"),
  };
}

function publicCommand(env: NodeJS.ProcessEnv): string {
  return env.TRELLIS_ZCODE_BIN?.trim() || "zcode";
}

function cliFacts(homeDir: string, env: NodeJS.ProcessEnv): { command?: string; version?: string; help?: string; outputFormatSupported?: boolean } {
  const command = publicCommand(env);
  const childEnv = zcodeEnv(homeDir, env);
  try {
    const version = execFileSync(command, ["version"], { encoding: "utf-8", timeout: 5_000, env: childEnv }).trim();
    let help: string | undefined;
    let outputFormatSupported = false;
    try {
      help = execFileSync(command, ["--help"], { encoding: "utf-8", timeout: 5_000, env: childEnv });
    } catch {
      // A version identity still permits a configuration-only profile.
    }
    try {
      // Some zcode-app-cli builds accept --output-format but omit it from
      // their generated help text. --version never starts a model turn, so
      // it is a safe capability probe for the public argument contract.
      execFileSync(command, ["--output-format", "stream-json", "--version"], { encoding: "utf-8", timeout: 5_000, env: childEnv });
      outputFormatSupported = true;
    } catch {
      // Keep the false value; callers then leave execution disabled.
    }
    return { command, version, ...(help ? { help } : {}), outputFormatSupported };
  } catch {
    return {};
  }
}

export function selectZcodeProfile(
  homeDir: string,
  facts: { command?: string; version?: string; help?: string; outputFormatSupported?: boolean } = {},
): ZcodeProfile | undefined {
  const paths = configPaths(homeDir);
  const version = facts.version ?? "";
  const supportsExecution = Boolean(
    facts.command
    && facts.help?.includes("--prompt")
    && facts.help.includes("--resume")
    && (facts.help.includes("--output-format") || facts.outputFormatSupported === true),
  );
  if (/^zcode-app-cli\b/im.test(version) || (existsSync(paths.community) && !existsSync(paths.official))) {
    return {
      kind: "community-cli",
      configPath: paths.community,
      ...(facts.command ? { executable: facts.command } : {}),
      ...(facts.version ? { executableVersion: facts.version } : {}),
      supportsExecution,
    };
  }
  if (facts.command || existsSync(paths.official)) {
    return {
      kind: facts.command ? "official" : "configuration-only",
      configPath: paths.official,
      ...(facts.command ? { executable: facts.command } : {}),
      ...(facts.version ? { executableVersion: facts.version } : {}),
      supportsExecution,
    };
  }
  if (existsSync(paths.root)) {
    return { kind: "configuration-only", configPath: paths.official, supportsExecution: false };
  }
  return undefined;
}

export function resolveZcodeProfile(homeDir: string = homedir(), env: NodeJS.ProcessEnv = process.env): ZcodeProfile | undefined {
  // A public `zcode` binary is installed system-wide, whereas probes run
  // against an explicit home directory. Do not let the real machine's CLI
  // make an empty sandbox home appear to have ZCode installed; the profile
  // must have local `.zcode` state before any executable is queried.
  if (!existsSync(configPaths(homeDir).root)) return undefined;
  return selectZcodeProfile(homeDir, cliFacts(homeDir, env));
}

export async function probe(homeDir: string = homedir(), opts: ProbeOptions = {}): Promise<AgentSnapshot> {
  const env = opts.env ?? process.env;
  const profile = resolveZcodeProfile(homeDir, env);
  if (!profile) return { agent: "zcode", present: false, skillRoots: [], mcpServers: [], diagnostics: [] };

  const config = readJsonFile<ZcodeConfig>(profile.configPath);
  const mcpServers: AgentSnapshotMcpServer[] = Object.entries(config?.mcp?.servers ?? {}).map(([name, def]) => ({
    name,
    transport: def.url ? (def.type === "sse" ? "sse" : "http") : ("stdio" as Transport),
  }));
  if (opts.probeMcp) {
    await Promise.all(Object.entries(config?.mcp?.servers ?? {}).map(async ([name, def], index) => {
      if (def.url || !def.command) return;
      mcpServers[index].probe = await probeMcpServer(
        { transport: "stdio", command: def.command, args: def.args },
        resolveEnvRefs(def.env, zcodeEnv(homeDir, env)),
      );
    }));
  }

  const skillRoots = [
    scanSkillRoot(join(homeDir, ".zcode", "skills")),
    scanSkillRoot(join(homeDir, ".agents", "skills")),
  ].filter((root): root is NonNullable<typeof root> => root !== undefined);
  const diagnostics: string[] = [];
  if (!profile.supportsExecution) diagnostics.push("ZCode public CLI execution is unavailable; configuration-only management is supported");
  return {
    agent: "zcode",
    present: true,
    ...(profile.executableVersion ? { version: profile.executableVersion } : {}),
    skillRoots,
    mcpServers,
    instructionsFile: pathRef(join(homeDir, ".zcode", "AGENTS.md")),
    diagnostics,
  };
}
