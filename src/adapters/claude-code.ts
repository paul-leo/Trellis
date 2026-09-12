/**
 * Claude Code adapter: `~/.claude/skills/<name>` symlinks per in-scope
 * skill, `~/.claude/CLAUDE.md` symlinked to canonical `agents.md`. Builds
 * out the create/repair/remove/refuse shape end-to-end (tasks.md 3.1)
 * before the other three adapters commit to reusing `symlinkPlan.ts`.
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import type { CanonicalSource } from "../core/types.js";
import * as claudeCodeProbe from "../probes/claude-code.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";

export class ClaudeCodeAdapter implements TrellisAdapter {
  readonly name = "Claude Code";
  readonly id = "claude-code" as const;

  constructor(private readonly homeDir: string = homedir()) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await claudeCodeProbe.probe(this.homeDir);
    return { present: snapshot.present, version: snapshot.version };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const canonicalRoot = dirname(canonical.instructionsFile);
    const skillsRoot = join(this.homeDir, ".claude", "skills");

    const desiredSkills = canonical.skills
      .filter((skill) => isInScope(this.id, skill.scope))
      .map((skill) => ({ name: skill.name, target: skill.dir }));

    const skillItems = planSymlinks({
      rootDir: skillsRoot,
      desired: desiredSkills,
      canonicalRoot: join(canonicalRoot, "skills"),
      kind: "skill",
    });

    const instructionsItems = planSymlinks({
      rootDir: join(this.homeDir, ".claude"),
      desired: [{ name: "CLAUDE.md", target: canonical.instructionsFile }],
      canonicalRoot,
      kind: "instructions",
    });

    return [...skillItems, ...instructionsItems];
  }

  async apply(plan: AdapterPlanItem[]): Promise<void> {
    await applySymlinkPlan(plan);
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await claudeCodeProbe.probe(this.homeDir);
    if (!snapshot.present) {
      return { ok: false, mismatches: ["claude-code is not present on this machine"] };
    }

    const mismatches: string[] = [];
    const desiredNames = new Set(canonical.skills.filter((s) => isInScope(this.id, s.scope)).map((s) => s.name));
    const actualSkills = new Set(snapshot.skillRoots.flatMap((root) => root.skills).map((s) => s.name));

    for (const name of desiredNames) {
      if (!actualSkills.has(name)) {
        mismatches.push(`skill "${name}" is in canonical scope for claude-code but missing on disk`);
      }
    }
    for (const name of actualSkills) {
      if (!desiredNames.has(name)) {
        mismatches.push(`skill "${name}" is present on disk but not in canonical scope for claude-code`);
      }
    }

    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
