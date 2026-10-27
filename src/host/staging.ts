/**
 * `host` facade — scratch staging (host-extension-points spec).
 *
 * Candidate edits must be evaluated against a COPY of the canonical
 * surface, never the live one: `staging 后真实 canonical 与 agent 原生
 * 配置逐字节不变` is a hard scenario of the spec. `createStaging` builds
 * a disposable scratch home (and optional scratch workspace) that the
 * check/apply/rollback half of the facade can read and write freely.
 *
 * What gets copied is deliberately bounded by `NATIVE_CHECK_SURFACE`:
 * only the configuration and skill surfaces the machine-readable checks
 * actually read. Account caches and credential stores — `.codex/auth.json`,
 * `.claude/projects`, OAuth token files — are NOT part of that surface and
 * never leave the real home (same boundary as the morphix-env rule: never
 * read or replicate agent account caches).
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

/**
 * Home-relative paths the machine-readable checks read — presence probes,
 * native config files, and skill roots for each agent. The staging copy
 * is exactly this set plus `~/.trellis/`, nothing more. Paths here are
 * the ONLY agent-native content that may be replicated into a scratch
 * home; anything credential-shaped stays out by construction.
 */
export const NATIVE_CHECK_SURFACE: readonly string[] = [
  // claude-code (probe: `.claude.json` exists)
  ".claude.json",
  ".claude/CLAUDE.md",
  ".claude/skills",
  ".claude/agents",
  // codex (probe: `.codex/config.toml` exists)
  ".codex/config.toml",
  ".codex/skills",
  // kiro
  ".kiro/settings",
  ".kiro/skills",
  ".kiro/steering",
  // kimi-code
  ".kimi-code/mcp.json",
  // zcode
  ".zcode/cli",
  ".zcode/skills",
  ".zcode/AGENTS.md",
  // pi
  ".pi/agent",
  // home-level shared skills root (codex plan reads `.agents/skills`)
  ".agents/skills",
  // kiro adapter's user-level settings file (macOS layout)
  "Library/Application Support/Kiro/User/settings.json",
];

export interface CreateStagingOptions {
  homeDir: string;
  /** Real workspace root to replicate, or omit/null for global-only. */
  workspaceRoot?: string | null;
  /** Where to place the scratch root. Defaults to the OS temp dir. */
  tmpRoot?: string;
}

export interface Staging {
  /** Scratch root: everything lives under here and dies with `dispose()`. */
  root: string;
  /** Scratch home — pass this where the facade wants `homeDir`. */
  homeDir: string;
  /** Scratch workspace root (`.agents/` layer + workspace MCP configs),
   * or null when staging is global-only. Pass this where the facade wants
   * `workspaceRoot`. */
  workspaceRoot: string | null;
  /** The REAL workspace root this staging replicates — the stable label
   * for layer attribution and id normalization. Physical scratch paths
   * must never appear in comparable identities. */
  logicalWorkspaceRoot: string | null;
  /** Delete the entire scratch tree. Safe to call twice. */
  dispose(): void;
}

/** True unless `src` is a `.git` directory — VCS metadata is neither a
 * check surface nor something a staging copy needs. */
function notGitDir(src: string): boolean {
  return basename(src) !== ".git";
}

/** `.trellis` subtrees that NEVER leave the real home: credential stores
 * (mcp/oauth token material), backup sessions, and evolve run state
 * (pending records carry config file contents). A job killed mid-gate
 * must not leave tokens behind in /tmp. */
const TRELLIS_STAGING_EXCLUDES = ["mcp/oauth", "backups", "evolve"] as const;

function trellisStagingFilter(sourceRoot: string): (src: string) => boolean {
  return (src) => {
    const rel = relative(sourceRoot, src).split(sep).join("/");
    return !TRELLIS_STAGING_EXCLUDES.some((excluded) => rel === excluded || rel.startsWith(excluded + "/"));
  };
}

function copyIfExists(from: string, to: string, filter?: (src: string) => boolean): void {
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, ...(filter ? { filter } : {}) });
}

/**
 * Build a disposable scratch home (and optional scratch workspace).
 * Copies `~/.trellis/` minus credential/state subtrees (`mcp/oauth`,
 * `backups`, `evolve` — see TRELLIS_STAGING_EXCLUDES) plus exactly
 * `NATIVE_CHECK_SURFACE`, then the workspace tree minus `.git`. The real
 * home and workspace are never written to, and credential material never
 * leaves it.
 */
export function createStaging(options: CreateStagingOptions): Staging {
  const logicalWorkspaceRoot = options.workspaceRoot ?? null;
  const root = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "trellis-staging-"));
  const scratchHome = join(root, "home");
  mkdirSync(scratchHome, { recursive: true });

  copyIfExists(
    join(options.homeDir, ".trellis"),
    join(scratchHome, ".trellis"),
    trellisStagingFilter(join(options.homeDir, ".trellis")),
  );
  for (const rel of NATIVE_CHECK_SURFACE) {
    copyIfExists(join(options.homeDir, rel), join(scratchHome, rel), notGitDir);
  }

  let scratchWorkspace: string | null = null;
  if (logicalWorkspaceRoot) {
    scratchWorkspace = join(root, "workspace");
    copyIfExists(logicalWorkspaceRoot, scratchWorkspace, notGitDir);
  }

  return {
    root,
    homeDir: scratchHome,
    workspaceRoot: scratchWorkspace,
    logicalWorkspaceRoot,
    dispose(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
