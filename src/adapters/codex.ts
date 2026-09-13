/**
 * Codex adapter: `~/.agents/skills/<name>` symlinks (Codex's own built-in
 * convention, per docs/research.md — never `~/.codex/skills`, that's the
 * duplication bug this project already found and fixed once). Instructions
 * sync targets whatever `config.toml`'s `instructions` key names; if unset,
 * this is a no-op with a diagnostic — Trellis never guesses or writes a
 * path Codex itself didn't declare (design.md Risks, trellis-sync-p1).
 *
 * MCP servers are written via `src/lib/tomlSection.ts`'s line-based
 * section splicer, never a TOML library (trellis-mcp-sync-p2 design.md
 * D1/D2 — both rejected with evidence) — create/repair only, no
 * automatic removal (D7: no ownership marker exists for a bare TOML key
 * the way a symlink's realpath provides for skills).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import type { CanonicalSource } from "../core/types.js";
import * as codexProbe from "../probes/codex.js";
import { readInstructionsPath } from "../probes/codex.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";
import { resolveMcpPlan } from "./mcpPlan.js";
import { currentServerSectionText, renderServerSection, upsertSection } from "../lib/tomlSection.js";
import type { BackupSession } from "../lib/backup.js";

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
      .filter((skill) => isInScope(this.id, skill.scope, canonical.managedAgents))
      .map((skill) => ({ name: skill.name, target: skill.dir }));

    const skillItems = planSymlinks({
      rootDir: skillsRoot,
      desired: desiredSkills,
      canonicalRoot: join(canonicalRoot, "skills"),
      kind: "skill",
    });

    const mcpItems = this.planMcp(canonical);

    const configuredInstructionsPath = readInstructionsPath(join(this.homeDir, ".codex", "config.toml"));
    if (!configuredInstructionsPath) {
      // Codex has no `instructions` key set — not Trellis's to decide.
      // MCP planning is independent of this and must still run.
      return [...skillItems, ...mcpItems];
    }

    const instructionsItems = planSymlinks({
      rootDir: dirname(configuredInstructionsPath),
      desired: [{ name: basename(configuredInstructionsPath), target: canonical.instructionsFile }],
      canonicalRoot,
      kind: "instructions",
    });

    return [...skillItems, ...instructionsItems, ...mcpItems];
  }

  private planMcp(canonical: CanonicalSource): AdapterPlanItem[] {
    const configTomlPath = join(this.homeDir, ".codex", "config.toml");
    const content = existsSync(configTomlPath) ? readFileSync(configTomlPath, "utf-8") : "";
    const { desired, conflicts } = resolveMcpPlan(this.id, canonical.mcp, canonical.managedAgents);

    const items: AdapterPlanItem[] = [];
    for (const { name, def } of desired) {
      const current = currentServerSectionText(content, name);
      const rendered = renderServerSection(name, def);
      if (current === rendered) {
        continue; // already correct — no-op
      }
      items.push({
        action: "create",
        kind: "mcp",
        target: configTomlPath,
        mcpWrite: { name, def },
        description: `MCP server "${name}" ${current === null ? "created" : "updated"} in ${configTomlPath}`,
      });
    }
    for (const conflict of conflicts) {
      items.push({ action: "conflict", kind: "mcp", target: configTomlPath, description: conflict.message });
    }
    return items;
  }

  async apply(plan: AdapterPlanItem[], backup: BackupSession): Promise<void> {
    await applySymlinkPlan(
      plan.filter((item) => item.kind !== "mcp"),
      backup,
    );

    const mcpCreates = plan.filter((item) => item.kind === "mcp" && item.action === "create" && item.mcpWrite);
    if (mcpCreates.length === 0) {
      return;
    }
    const configTomlPath = mcpCreates[0].target;
    let content = existsSync(configTomlPath) ? readFileSync(configTomlPath, "utf-8") : "";
    for (const item of mcpCreates) {
      content = upsertSection(content, item.mcpWrite!.name, item.mcpWrite!.def);
    }
    backup.writeFile(configTomlPath, content);
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await codexProbe.probe(this.homeDir);
    if (!snapshot.present) {
      return { ok: false, mismatches: ["codex is not present on this machine"] };
    }

    const mismatches: string[] = [];
    const desiredNames = new Set(canonical.skills.filter((s) => isInScope(this.id, s.scope, canonical.managedAgents)).map((s) => s.name));
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
