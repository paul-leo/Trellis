/**
 * Shared fake-HOME fixture builders for unit tests.
 *
 * Two kinds of duplication lived in ~20 test files before this module:
 *
 * 1. Per-agent presence markers (`~/.claude.json`, `~/.codex/config.toml`,
 *    …) hand-written to satisfy each probe's own "present" check — a
 *    contract encoded identically in every file that needed it, drifting
 *    silently if a probe ever changes. `seedAgentPresence` encodes each
 *    probe's contract once, next to a comment naming the probe file that
 *    owns it.
 * 2. The canonical `.trellis/` skeleton (agents.md / managed.yaml /
 *    mcp/servers.yaml / secrets.policy.yaml) re-typed with slight
 *    variations. `seedCanonical` writes exactly the pieces asked for.
 *
 * Everything here writes into a fresh `mkdtempSync` scratch dir — the same
 * sandboxing rule as every test that used its own `scratchHome`: these
 * builders must never touch the real HOME (docs/architecture.md's testing
 * philosophy).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../../src/core/types.js";

/** A fresh, empty scratch HOME. `prefix` names the owning test file so
 * leftover dirs in $TMPDIR are attributable (`trellis-<prefix>-XXXXXX`). */
export function scratchHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `trellis-${prefix}-`));
}

/** Minimal per-agent presence markers, matching each probe's own "present"
 * check (src/probes/<agent>.ts) — no real agent binaries required. Content
 * is the simplest each probe accepts; tests needing richer starting content
 * overwrite the file after seeding. */
export function seedAgentPresence(home: string, agents: readonly AgentId[]): void {
  for (const agent of agents) {
    switch (agent) {
      case "claude-code":
        // probes/claude-code.ts: present iff ~/.claude.json parses.
        writeFileSync(join(home, ".claude.json"), "{}");
        break;
      case "codex":
        // probes/codex.ts: present iff ~/.codex/config.toml exists.
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(join(home, ".codex", "config.toml"), `model = "x"\n`);
        break;
      case "kiro":
        // probes/kiro.ts: present iff settings/mcp.json, skills, or steering exists.
        mkdirSync(join(home, ".kiro", "settings"), { recursive: true });
        writeFileSync(join(home, ".kiro", "settings", "mcp.json"), "{}");
        break;
      case "pi":
        // probes/pi.ts: present iff agent/settings.json or the skills dir exists.
        mkdirSync(join(home, ".pi", "agent"), { recursive: true });
        writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
        break;
      case "kimi-code":
        // probes/kimi-code.ts: present iff ~/.kimi-code/ exists.
        mkdirSync(join(home, ".kimi-code"), { recursive: true });
        break;
      case "zcode":
        // probes/zcode.ts: ~/.zcode/ root is the configuration-only profile.
        mkdirSync(join(home, ".zcode"), { recursive: true });
        break;
    }
  }
}

export interface SeedCanonicalOptions {
  /** `agents: [...]` for managed.yaml. Omitted → no managed.yaml written. */
  managed?: readonly AgentId[];
  /** Full body for ~/.trellis/mcp/servers.yaml (including the `servers:` key). */
  serversYaml?: string;
  /** ~/.trellis/agents.md content. */
  instructions?: string;
  /** ~/.trellis/secrets.policy.yaml content. */
  secretsPolicyYaml?: string;
}

/** The canonical `.trellis/` skeleton — only the requested pieces. */
export function seedCanonical(home: string, opts: SeedCanonicalOptions = {}): void {
  if (opts.managed !== undefined || opts.instructions !== undefined || opts.serversYaml !== undefined || opts.secretsPolicyYaml !== undefined) {
    mkdirSync(join(home, ".trellis"), { recursive: true });
  }
  if (opts.managed !== undefined) {
    writeFileSync(join(home, ".trellis", "managed.yaml"), `agents: [${opts.managed.join(", ")}]\n`);
  }
  if (opts.instructions !== undefined) {
    writeFileSync(join(home, ".trellis", "agents.md"), opts.instructions);
  }
  if (opts.serversYaml !== undefined) {
    mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
    writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), opts.serversYaml);
  }
  if (opts.secretsPolicyYaml !== undefined) {
    writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), opts.secretsPolicyYaml);
  }
}
