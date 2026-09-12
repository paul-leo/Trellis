/**
 * Codex adapter: `~/.agents/skills/<name>` symlinks (Codex's own built-in
 * convention, per docs/research.md — never `~/.codex/skills`, that's the
 * duplication bug this project already found and fixed once). Instructions
 * sync targets whatever `config.toml`'s `instructions` key names; if unset,
 * this is a no-op with a diagnostic — Trellis never guesses or writes a
 * path Codex itself didn't declare (design.md Risks, trellis-sync-p1).
 */

import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import type { CanonicalSource } from "../core/types.js";
import * as codexProbe from "../probes/codex.js";
import { readInstructionsPath } from "../probes/codex.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";

export class CodexAdapter implements TrellisAdapter {
  readonly name = "Codex";
  readonly id = "codex" as const;

  constructor(private readonly homeDir: string = homedir()) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await codexProbe.probe(this.homeDir);
    return { present: snapshot.present, version: snapshot.version };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const canonicalRoot = dirname(canonical.instructionsFile);
    const skillsRoot = join(this.homeDir, ".agents", "skills");

    const desiredSkills = canonical.skills
      .filter((skill) => isInScope(this.id, skill.scope))
      .map((skill) => ({ name: skill.name, target: skill.dir }));

    const skillItems = planSymlinks({
      rootDir: skillsRoot,
      desired: desiredSkills,
      canonicalRoot: join(canonicalRoot, "skills"),
      kind: "skill",
    });

    const configuredInstructionsPath = readInstructionsPath(join(this.homeDir, ".codex", "config.toml"));
    if (!configuredInstructionsPath) {
      // Codex has no `instructions` key set — not Trellis's to decide.
      return skillItems;
    }

    const instructionsItems = planSymlinks({
      rootDir: dirname(configuredInstructionsPath),
      desired: [{ name: basename(configuredInstructionsPath), target: canonical.instructionsFile }],
      canonicalRoot,
      kind: "instructions",
    });

    return [...skillItems, ...instructionsItems];
  }

  async apply(plan: AdapterPlanItem[]): Promise<void> {
    await applySymlinkPlan(plan);
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await codexProbe.probe(this.homeDir);
    if (!snapshot.present) {
      return { ok: false, mismatches: ["codex is not present on this machine"] };
    }

    const mismatches: string[] = [];
    const desiredNames = new Set(canonical.skills.filter((s) => isInScope(this.id, s.scope)).map((s) => s.name));
    const actualSkills = new Set(snapshot.skillRoots.flatMap((root) => root.skills).map((s) => s.name));

    for (const name of desiredNames) {
      if (!actualSkills.has(name)) {
        mismatches.push(`skill "${name}" is in canonical scope for codex but missing on disk`);
      }
    }
    for (const name of actualSkills) {
      if (!desiredNames.has(name)) {
        mismatches.push(`skill "${name}" is present on disk but not in canonical scope for codex`);
      }
    }

    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
