/**
 * `--real` sandbox mode's allowlist (trellis-real-sandbox-verification
 * design.md D1): every real dotfile path a probe (src/probes/*.ts) is
 * already known to read, and nothing else. Allowlist, not denylist —
 * anything this project doesn't already know to be structural (real
 * OAuth token storage, session/history logs, credentials) is never
 * copied out of a developer's real `$HOME` because it was never named
 * here, not because it was excluded after the fact. Kept in sync with
 * each probe's own `join(homeDir, ...)` calls by direct source
 * cross-reference, not by assumption.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const REAL_HOME_ALLOWLIST: readonly string[] = [
  // claude-code (src/probes/claude-code.ts)
  ".claude.json",
  ".claude/skills",
  ".claude/agents",
  ".claude/CLAUDE.md",
  // codex (src/probes/codex.ts)
  ".codex/config.toml",
  ".agents/skills",
  ".codex/skills",
  // kiro (src/probes/kiro.ts)
  ".kiro/settings/mcp.json",
  ".kiro/skills",
  ".kiro/steering/CLAUDE.md",
  // pi (src/probes/pi.ts)
  ".pi/agent/settings.json",
  ".pi/agent/skills",
  ".pi/agent/AGENTS.override.md",
  ".pi/agent/AGENTS.md",
  ".pi/agent/AGENTS.MD",
  ".pi/agent/CLAUDE.md",
  ".pi/agent/CLAUDE.MD",
  // this machine's own real canonical source, if it already has one —
  // Trellis's own managed data, not a third-party agent's.
  ".trellis",
];

/**
 * Copies only allowlisted paths that actually exist under `sourceHome`
 * into `destHome` — a missing entry is a normal, expected state (not
 * every agent is installed), never an error. `dereference: true` is
 * required, not incidental: `sync`'s own real output is symlinks
 * (skills, instructions) pointing back at `sourceHome`'s own
 * `.trellis/` — a container mounting a snapshot that kept those
 * symlinks as symlinks would get a dangling reference to a path that
 * doesn't exist inside it. Copying real content instead is what makes
 * the snapshot self-contained (found by actually running this against
 * a real, already-synced machine — not by inspection). Returns the
 * relative paths actually copied, for the caller to report.
 */
export function buildRealHomeSnapshot(sourceHome: string, destHome: string): string[] {
  const copied: string[] = [];
  for (const rel of REAL_HOME_ALLOWLIST) {
    const src = join(sourceHome, rel);
    if (!existsSync(src)) continue;
    const dest = join(destHome, rel);
    // On a case-insensitive filesystem (macOS default), two distinct
    // allowlist entries (e.g. `AGENTS.md`/`AGENTS.MD` — pi's own
    // case-sensitive candidate list, src/probes/pi.ts) can resolve to
    // the identical real file; a `dest` an earlier entry already
    // created (case-insensitively) needs no second, redundant copy —
    // found by actually running this against a real machine, where it
    // also tripped a Node `cpSync` quirk re-copying a symlink onto its
    // own already-materialized destination.
    if (existsSync(dest)) {
      copied.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    copied.push(rel);
  }
  return copied;
}
