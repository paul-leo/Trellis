/**
 * Kiro adapter: same shape as Claude Code — `~/.kiro/skills/<name>`
 * symlinks, `~/.kiro/steering/CLAUDE.md` symlinked to canonical `agents.md`.
 *
 * MCP servers: plain JSON parse → merge under `mcpServers` → stringify
 * (trellis-mcp-sync-p2 design.md D4) — create/repair only, no automatic
 * removal (D7).
 *
 * Kiro's own `${VAR}` substitution (real, found by reading Kiro's
 * installed extension source — trellis-kiro-approved-env-vars design.md
 * Context) is gated by `kiroAgent.mcpApprovedEnvVars`, a completely
 * separate, VS-Code-style global settings.json — not the mcp.json above.
 * A name absent from that list is silently never substituted. This
 * adapter keeps that list a superset of every env name it references,
 * additive only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import type { CanonicalSource } from "../core/types.js";
import * as kiroProbe from "../probes/kiro.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";
import { applyJsonMcp, planJsonMcp } from "./jsonMcp.js";
import { resolveMcpPlan } from "./mcpPlan.js";

/** VS-Code-family global settings path. macOS only — see
 * trellis-kiro-approved-env-vars proposal.md Non-Goals: Linux/Windows
 * equivalents are the well-known convention but unverified against a
 * real Kiro install on those platforms. */
function kiroSettingsPath(homeDir: string): string {
  return join(homeDir, "Library", "Application Support", "Kiro", "User", "settings.json");
}

const APPROVED_ENV_VARS_KEY = "kiroAgent.mcpApprovedEnvVars";

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

    const mcpItems = this.planMcp(canonical);
    const approvedEnvVarsItems = this.planApprovedEnvVars(canonical);

    return [...skillItems, ...instructionsItems, ...mcpItems, ...approvedEnvVarsItems];
  }

  private planMcp(canonical: CanonicalSource): AdapterPlanItem[] {
    const configPath = join(this.homeDir, ".kiro", "settings", "mcp.json");
    const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
    return planJsonMcp({ configPath, parsed, mcp: canonical.mcp, agentId: this.id });
  }

  /** Names come from `resolveMcpPlan`, not a raw scan of `canonical.mcp.servers`
   * (design.md D2) — a server scoped away from Kiro, or refused for a
   * known_host_injected collision, never contributes a name here either. */
  private desiredApprovedEnvVars(canonical: CanonicalSource): string[] {
    const { desired } = resolveMcpPlan(this.id, canonical.mcp);
    const names = new Set<string>();
    for (const { def } of desired) {
      for (const name of def.env ?? []) names.add(name);
    }
    return [...names];
  }

  private planApprovedEnvVars(canonical: CanonicalSource): AdapterPlanItem[] {
    const desired = this.desiredApprovedEnvVars(canonical);
    if (desired.length === 0) {
      return [];
    }

    const settingsPath = kiroSettingsPath(this.homeDir);
    let existing: string[] = [];
    if (existsSync(settingsPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        return [{ action: "conflict", kind: "kiro-approved-env-vars", target: settingsPath, description: `${settingsPath} is not valid JSON — refusing to touch it` }];
      }
      const current = (parsed as Record<string, unknown>)[APPROVED_ENV_VARS_KEY];
      if (Array.isArray(current)) {
        existing = current.filter((v): v is string => typeof v === "string");
      }
    }

    const union = [...new Set([...existing, ...desired])];
    if (union.length === existing.length && union.every((name) => existing.includes(name))) {
      return []; // already a superset — no-op (design.md D4)
    }

    return [
      {
        action: "create",
        kind: "kiro-approved-env-vars",
        target: settingsPath,
        approvedEnvVars: union,
        description: `${settingsPath}: ${APPROVED_ENV_VARS_KEY} updated to include ${desired.filter((n) => !existing.includes(n)).join(", ")}`,
      },
    ];
  }

  async apply(plan: AdapterPlanItem[]): Promise<void> {
    await applySymlinkPlan(plan.filter((item) => item.kind === "skill" || item.kind === "instructions"));

    const mcpCreates = plan.filter((item) => item.kind === "mcp" && item.action === "create" && item.mcpWrite);
    if (mcpCreates.length > 0) {
      const configPath = mcpCreates[0].target;
      const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
      const merged = applyJsonMcp(parsed, mcpCreates);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
    }

    const approvedEnvVarsCreate = plan.find((item) => item.kind === "kiro-approved-env-vars" && item.action === "create" && item.approvedEnvVars);
    if (approvedEnvVarsCreate) {
      const settingsPath = approvedEnvVarsCreate.target;
      const parsed = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>) : {};
      const merged = { ...parsed, [APPROVED_ENV_VARS_KEY]: approvedEnvVarsCreate.approvedEnvVars };
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    }
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

    const settingsPath = kiroSettingsPath(this.homeDir);
    const approved: string[] = (() => {
      if (!existsSync(settingsPath)) return [];
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        const current = parsed[APPROVED_ENV_VARS_KEY];
        return Array.isArray(current) ? current.filter((v): v is string => typeof v === "string") : [];
      } catch {
        return [];
      }
    })();
    for (const name of this.desiredApprovedEnvVars(canonical)) {
      if (!approved.includes(name)) {
        mismatches.push(`env var "${name}" is needed by a canonical MCP server for kiro but missing from ${APPROVED_ENV_VARS_KEY}`);
      }
    }

    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
