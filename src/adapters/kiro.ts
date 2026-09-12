/**
 * Kiro adapter: same shape as Claude Code — `~/.kiro/skills/<name>`
 * symlinks, `~/.kiro/steering/CLAUDE.md` symlinked to canonical `agents.md`.
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import type { CanonicalSource } from "../core/types.js";
import * as kiroProbe from "../probes/kiro.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";

export class KiroAdapter implements TrellisAdapter {
  readonly name = "Kiro";
  readonly id = "kiro" as const;

  constructor(private readonly homeDir: string = homedir()) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await kiroProbe.probe(this.homeDir);
    return { present: snapshot.present, version: snapshot.version };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const canonicalRoot = dirname(canonical.instructionsFile);
    const skillsRoot = join(this.homeDir, ".kiro", "skills");

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
      rootDir: join(this.homeDir, ".kiro", "steering"),
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
    const snapshot = await kiroProbe.probe(this.homeDir);
    if (!snapshot.present) {
      return { ok: false, mismatches: ["kiro is not present on this machine"] };
    }

    const mismatches: string[] = [];
    const desiredNames = new Set(canonical.skills.filter((s) => isInScope(this.id, s.scope)).map((s) => s.name));
    const actualSkills = new Set(snapshot.skillRoots.flatMap((root) => root.skills).map((s) => s.name));

    for (const name of desiredNames) {
      if (!actualSkills.has(name)) {
        mismatches.push(`skill "${name}" is in canonical scope for kiro but missing on disk`);
      }
    }
    for (const name of actualSkills) {
      if (!desiredNames.has(name)) {
        mismatches.push(`skill "${name}" is present on disk but not in canonical scope for kiro`);
      }
    }

    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
