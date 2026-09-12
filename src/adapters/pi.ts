/**
 * pi adapter: `~/.pi/agent/skills/<name>` symlinks, `~/.pi/agent/AGENTS.md`
 * symlinked to canonical `agents.md` — specifically `AGENTS.md`, not
 * `AGENTS.override.md` (design.md D3, trellis-sync-p1: pi checks the
 * override name first, and Trellis's managed file is the baseline, not an
 * override of something else). MCP is out of scope here entirely — pi has
 * no native MCP client (docs/research.md); that's P4's bridge extension,
 * a different problem from this adapter's skills/instructions symlinks.
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import type { CanonicalSource } from "../core/types.js";
import * as piProbe from "../probes/pi.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";

export class PiAdapter implements TrellisAdapter {
  readonly name = "pi";
  readonly id = "pi" as const;

  constructor(private readonly homeDir: string = homedir()) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await piProbe.probe(this.homeDir);
    return { present: snapshot.present, version: snapshot.version };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const canonicalRoot = dirname(canonical.instructionsFile);
    const agentDir = join(this.homeDir, ".pi", "agent");

    const desiredSkills = canonical.skills
      .filter((skill) => isInScope(this.id, skill.scope))
      .map((skill) => ({ name: skill.name, target: skill.dir }));

    const skillItems = planSymlinks({
      rootDir: join(agentDir, "skills"),
      desired: desiredSkills,
      canonicalRoot: join(canonicalRoot, "skills"),
      kind: "skill",
    });

    const instructionsItems = planSymlinks({
      rootDir: agentDir,
      desired: [{ name: "AGENTS.md", target: canonical.instructionsFile }],
      canonicalRoot,
      kind: "instructions",
    });

    return [...skillItems, ...instructionsItems];
  }

  async apply(plan: AdapterPlanItem[]): Promise<void> {
    await applySymlinkPlan(plan);
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await piProbe.probe(this.homeDir);
    if (!snapshot.present) {
      return { ok: false, mismatches: ["pi is not present on this machine"] };
    }

    const mismatches: string[] = [];
    const desiredNames = new Set(canonical.skills.filter((s) => isInScope(this.id, s.scope)).map((s) => s.name));
    const actualSkills = new Set(snapshot.skillRoots.flatMap((root) => root.skills).map((s) => s.name));

    for (const name of desiredNames) {
      if (!actualSkills.has(name)) {
        mismatches.push(`skill "${name}" is in canonical scope for pi but missing on disk`);
      }
    }
    for (const name of actualSkills) {
      if (!desiredNames.has(name)) {
        mismatches.push(`skill "${name}" is present on disk but not in canonical scope for pi`);
      }
    }

    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
