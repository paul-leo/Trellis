/**
 * Runtime-first ZCode adapter.
 *
 * ZCode's native `~/.agents/skills` scan prevents scope-safe native delivery,
 * so Runtime-only delivery uses one MCP Runtime edge and turns off the two
 * native Skill switches through a ledger-backed, reversible config change.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import { capabilityDeliveryForAgent, usesNativeCapabilityDelivery } from "../core/types.js";
import type { CanonicalSource, McpConfig, McpServerDef, SecretsPolicy } from "../core/types.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";
import { renderJsonServerEntry } from "./jsonMcp.js";
import { LEGACY_GATEWAY_ENTRY_NAME, LEGACY_RUNTIME_ENTRY_NAME, resolveMcpPlan } from "./mcpPlan.js";
import { deepEqual } from "../lib/deepEqual.js";
import { forgetOwned, loadMcpOwnership, ownedByAgent, recordOwned, saveMcpOwnership } from "../lib/mcpOwnership.js";
import { forgetZcodeSettingsOwnership, loadZcodeSettingsOwnership, saveZcodeSettingsOwnership, type ZcodeSkillControlValues } from "../lib/zcodeOwnership.js";
import type { BackupSession } from "../lib/backup.js";
import * as zcodeProbe from "../probes/zcode.js";

type JsonRecord = Record<string, unknown>;

function readConfig(path: string): JsonRecord | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function zcodeServers(parsed: JsonRecord | undefined): JsonRecord {
  return record(record(parsed?.mcp).servers);
}

function planZcodeMcp(opts: {
  configPath: string;
  parsed: JsonRecord | undefined;
  mcp: McpConfig;
  managedAgents: readonly import("../core/types.js").AgentId[];
  policy: SecretsPolicy;
  ownership: JsonRecord;
}): AdapterPlanItem[] {
  const { desired, conflicts } = resolveMcpPlan("zcode", opts.mcp, opts.managedAgents, opts.policy);
  const existing = zcodeServers(opts.parsed);
  const items: AdapterPlanItem[] = [];
  for (const { name, def } of desired) {
    const rendered = renderJsonServerEntry(def);
    if (deepEqual(existing[name], rendered)) continue;
    items.push({
      action: "create",
      kind: "mcp",
      target: opts.configPath,
      mcpWrite: { name, def },
      description: `MCP server "${name}" ${existing[name] === undefined ? "created" : "updated"} in ${opts.configPath}`,
    });
  }
  for (const conflict of conflicts) {
    items.push({ action: "conflict", kind: "mcp", target: opts.configPath, description: conflict.message, ...(conflict.remediation ? { remediation: conflict.remediation } : {}) });
  }
  const desiredNames = new Set(desired.map((entry) => entry.name));
  for (const [name, expected] of Object.entries(opts.ownership)) {
    if (desiredNames.has(name)) continue;
    if ((name === LEGACY_GATEWAY_ENTRY_NAME || name === LEGACY_RUNTIME_ENTRY_NAME) && desiredNames.has("trellis")) continue;
    if (existing[name] === undefined || !deepEqual(existing[name], expected)) continue;
    items.push({
      action: "remove",
      kind: "mcp",
      target: opts.configPath,
      mcpRemove: { name },
      description: `MCP server "${name}" removed from ${opts.configPath} — no longer in canonical`,
    });
  }
  return items;
}

function applyZcodeMcp(parsed: JsonRecord | undefined, items: readonly AdapterPlanItem[]): JsonRecord {
  const base = parsed ?? {};
  const mcp = record(base.mcp);
  const servers = { ...record(mcp.servers) };
  for (const item of items) {
    if (item.kind !== "mcp") continue;
    if (item.action === "create" && item.mcpWrite) servers[item.mcpWrite.name] = renderJsonServerEntry(item.mcpWrite.def);
    if (item.action === "remove" && item.mcpRemove) delete servers[item.mcpRemove.name];
  }
  return { ...base, mcp: { ...mcp, servers } };
}

function currentSkillControls(parsed: JsonRecord | undefined): ZcodeSkillControlValues {
  const features = record(parsed?.features);
  const skills = record(parsed?.skills);
  return {
    featuresSkill: typeof features.skill === "boolean" ? features.skill : null,
    skillsEnabled: typeof skills.enabled === "boolean" ? skills.enabled : null,
  };
}

function applySkillControls(parsed: JsonRecord, controls: ZcodeSkillControlValues): JsonRecord {
  const features = { ...record(parsed.features) };
  const skills = { ...record(parsed.skills) };
  if (controls.featuresSkill === null) delete features.skill;
  else features.skill = controls.featuresSkill;
  if (controls.skillsEnabled === null) delete skills.enabled;
  else skills.enabled = controls.skillsEnabled;
  return { ...parsed, features, skills };
}

export class ZcodeAdapter implements TrellisAdapter {
  readonly name = "ZCode";
  readonly id = "zcode" as const;

  constructor(private readonly homeDir: string = homedir(), private readonly env: NodeJS.ProcessEnv = process.env) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await zcodeProbe.probe(this.homeDir, { env: this.env });
    return { present: snapshot.present, version: snapshot.version, ...(snapshot.diagnostics.length ? { detail: snapshot.diagnostics.join("; ") } : {}) };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const profile = zcodeProbe.resolveZcodeProfile(this.homeDir, this.env);
    if (!profile) return [];
    const parsed = readConfig(profile.configPath);
    const canonicalRoot = dirname(canonical.instructionsFile);
    const runtimeOnly = capabilityDeliveryForAgent(this.id, canonical.mcp) === "mcp";
    const items: AdapterPlanItem[] = [];

    items.push(...planSymlinks({
      rootDir: join(this.homeDir, ".zcode", "skills"),
      desired: usesNativeCapabilityDelivery(this.id, canonical.mcp)
        ? canonical.skills.filter((skill) => isInScope(this.id, skill.scope, canonical.managedAgents)).map((skill) => ({ name: skill.name, target: skill.dir }))
        : [],
      canonicalRoot: join(canonicalRoot, "skills"),
      kind: "skill",
    }));
    items.push(...planSymlinks({
      rootDir: join(this.homeDir, ".zcode"),
      desired: [{ name: "AGENTS.md", target: canonical.instructionsFile }],
      canonicalRoot,
      kind: "instructions",
    }));

    items.push(...planZcodeMcp({
      configPath: profile.configPath,
      parsed,
      mcp: canonical.mcp,
      managedAgents: canonical.managedAgents,
      policy: canonical.secretsPolicy,
      ownership: ownedByAgent(loadMcpOwnership(this.homeDir), this.id),
    }));

    const current = currentSkillControls(parsed);
    const ownership = loadZcodeSettingsOwnership(this.homeDir);
    if (runtimeOnly && (current.featuresSkill !== false || current.skillsEnabled !== false)) {
      items.push({
        action: "create",
        kind: "zcode-skill-control",
        target: profile.configPath,
        zcodeSkillControls: { featuresSkill: false, skillsEnabled: false, previous: current },
        description: `native ZCode Skill discovery disabled in ${profile.configPath} for Runtime-only delivery`,
      });
    } else if (!runtimeOnly && ownership?.configPath === profile.configPath && current.featuresSkill === false && current.skillsEnabled === false) {
      items.push({
        action: "remove",
        kind: "zcode-skill-control",
        target: profile.configPath,
        zcodeSkillControls: { ...ownership.previous },
        description: `previous native ZCode Skill settings restored in ${profile.configPath}`,
      });
    }
    return items;
  }

  async apply(plan: AdapterPlanItem[], backup: BackupSession): Promise<void> {
    await applySymlinkPlan(plan.filter((item) => item.kind === "skill" || item.kind === "instructions"), backup);
    const configItems = plan.filter((item) => (item.kind === "mcp" || item.kind === "zcode-skill-control") && (item.action === "create" || item.action === "remove"));
    if (configItems.length === 0) return;
    const configPath = configItems[0].target;
    let merged = applyZcodeMcp(readConfig(configPath), configItems);
    const control = configItems.find((item) => item.kind === "zcode-skill-control")?.zcodeSkillControls;
    if (control) merged = applySkillControls(merged, control);
    backup.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);

    let ownership = loadMcpOwnership(this.homeDir);
    for (const item of configItems) {
      if (item.kind !== "mcp") continue;
      if (item.action === "create" && item.mcpWrite) ownership = recordOwned(ownership, this.id, item.mcpWrite.name, renderJsonServerEntry(item.mcpWrite.def));
      if (item.action === "remove" && item.mcpRemove) ownership = forgetOwned(ownership, this.id, item.mcpRemove.name);
    }
    saveMcpOwnership(this.homeDir, ownership);
    const controlItem = configItems.find((item) => item.kind === "zcode-skill-control");
    if (controlItem?.action === "create" && controlItem.zcodeSkillControls?.previous) {
      saveZcodeSettingsOwnership(this.homeDir, {
        configPath,
        managed: { featuresSkill: false, skillsEnabled: false },
        previous: controlItem.zcodeSkillControls.previous,
      });
    } else if (controlItem?.action === "remove") {
      forgetZcodeSettingsOwnership(this.homeDir);
    }
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await zcodeProbe.probe(this.homeDir, { env: this.env });
    if (!snapshot.present) return { ok: false, mismatches: ["zcode is not present on this machine"] };
    const profile = zcodeProbe.resolveZcodeProfile(this.homeDir, this.env);
    if (!profile) return { ok: false, mismatches: ["zcode profile cannot be selected"] };
    const mismatches: string[] = [];
    const desiredNativeSkills = canonical.skills
      .filter((skill) => usesNativeCapabilityDelivery(this.id, canonical.mcp) && isInScope(this.id, skill.scope, canonical.managedAgents))
      .map((skill) => skill.name);
    const actualNativeSkills = new Set(snapshot.skillRoots.filter((root) => root.path === join(this.homeDir, ".zcode", "skills")).flatMap((root) => root.skills.map((skill) => skill.name)));
    for (const name of desiredNativeSkills) if (!actualNativeSkills.has(name)) mismatches.push(`skill "${name}" is missing on ZCode`);
    const expectedMcp = planZcodeMcp({
      configPath: profile.configPath,
      parsed: readConfig(profile.configPath),
      mcp: canonical.mcp,
      managedAgents: canonical.managedAgents,
      policy: canonical.secretsPolicy,
      ownership: ownedByAgent(loadMcpOwnership(this.homeDir), this.id),
    }).filter((item) => item.action === "create" || item.action === "conflict");
    mismatches.push(...expectedMcp.map((item) => item.description));
    if (!snapshot.instructionsFile?.isSymlink || snapshot.instructionsFile.target !== canonical.instructionsFile) mismatches.push("shared instructions are not linked into ~/.zcode/AGENTS.md");
    if (capabilityDeliveryForAgent(this.id, canonical.mcp) === "mcp") {
      const controls = currentSkillControls(readConfig(profile.configPath));
      if (controls.featuresSkill !== false || controls.skillsEnabled !== false) mismatches.push("native ZCode Skill discovery is still enabled during Runtime-only delivery");
    }
    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
