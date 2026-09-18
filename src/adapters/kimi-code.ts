/**
 * Kimi Code Runtime-first adapter.
 *
 * Runtime delivery owns only ~/.kimi-code/mcp.json. Native Kimi Skills and
 * AGENTS.md remain opt-in for `native`/`both`; Runtime-only delivery uses
 * `trellis kimi`, which launches Kimi with an empty --skills-dir root so the
 * shared ~/.agents/skills tree is not discovered a second time.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import { usesNativeCapabilityDelivery } from "../core/types.js";
import type { CanonicalSource, McpServerDef } from "../core/types.js";
import * as kimiProbe from "../probes/kimi-code.js";
import { applyJsonMcp, planJsonMcp, renderJsonServerEntry, type JsonMcpEntryRenderer } from "./jsonMcp.js";
import { RUNTIME_COMMAND, RUNTIME_ENTRY_NAME } from "./mcpPlan.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";
import { loadMcpOwnership, ownedByAgent, recordOwned, forgetOwned, saveMcpOwnership } from "../lib/mcpOwnership.js";
import type { BackupSession } from "../lib/backup.js";

const KIMI_RUNTIME_STARTUP_TIMEOUT_MS = 30_000;

function renderKimiServerEntry(def: McpServerDef, name: string): Record<string, unknown> {
  const entry = renderJsonServerEntry(def);
  if (def.transport === "stdio") delete entry.type;
  if (name === RUNTIME_ENTRY_NAME && def.command === RUNTIME_COMMAND) {
    entry.deferred = true;
    entry.startupTimeoutMs = KIMI_RUNTIME_STARTUP_TIMEOUT_MS;
  }
  return entry;
}

export class KimiCodeAdapter implements TrellisAdapter {
  readonly name = "Kimi Code";
  readonly id = "kimi-code" as const;

  constructor(private readonly homeDir: string = homedir()) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await kimiProbe.probe(this.homeDir);
    return { present: snapshot.present, version: snapshot.version };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const native = usesNativeCapabilityDelivery(this.id, canonical.mcp);
    const items: AdapterPlanItem[] = [];
    if (native) {
      const root = join(this.homeDir, ".kimi-code");
      const canonicalRoot = dirname(canonical.instructionsFile);
      items.push(...planSymlinks({
        rootDir: join(root, "skills"),
        desired: canonical.skills
          .filter((skill) => isInScope(this.id, skill.scope, canonical.managedAgents))
          .map((skill) => ({ name: skill.name, target: skill.dir })),
        canonicalRoot: join(canonicalRoot, "skills"),
        kind: "skill",
      }));
      items.push(...planSymlinks({
        rootDir: root,
        desired: [{ name: "AGENTS.md", target: canonical.instructionsFile }],
        canonicalRoot,
        kind: "instructions",
      }));
    }

    const configPath = join(this.homeDir, ".kimi-code", "mcp.json");
    const parsed = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown> : undefined;
    const ownership = ownedByAgent(loadMcpOwnership(this.homeDir), this.id);
    items.push(...planJsonMcp({
      configPath,
      parsed,
      mcp: canonical.mcp,
      agentId: this.id,
      managedAgents: canonical.managedAgents,
      policy: canonical.secretsPolicy,
      ownership,
      render: renderKimiServerEntry satisfies JsonMcpEntryRenderer,
    }));
    return items;
  }

  async apply(plan: AdapterPlanItem[], backup: BackupSession): Promise<void> {
    await applySymlinkPlan(plan.filter((item) => item.kind === "skill" || item.kind === "instructions"), backup);
    const mcpWrites = plan.filter((item) => item.kind === "mcp" && (item.action === "create" || item.action === "remove"));
    if (mcpWrites.length === 0) return;
    const configPath = mcpWrites[0].target;
    const parsed = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown> : undefined;
    const merged = applyJsonMcp(parsed, mcpWrites, renderKimiServerEntry);
    backup.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);

    let ownership = loadMcpOwnership(this.homeDir);
    for (const item of mcpWrites) {
      if (item.action === "create" && item.mcpWrite) ownership = recordOwned(ownership, this.id, item.mcpWrite.name, renderKimiServerEntry(item.mcpWrite.def, item.mcpWrite.name));
      if (item.action === "remove" && item.mcpRemove) ownership = forgetOwned(ownership, this.id, item.mcpRemove.name);
    }
    saveMcpOwnership(this.homeDir, ownership);
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await kimiProbe.probe(this.homeDir);
    if (!snapshot.present) return { ok: false, mismatches: ["kimi-code is not present on this machine"] };
    const desired = new Set(canonical.skills.filter((skill) => usesNativeCapabilityDelivery(this.id, canonical.mcp) && isInScope(this.id, skill.scope, canonical.managedAgents)).map((skill) => skill.name));
    const actual = new Set(snapshot.skillRoots.flatMap((root) => root.skills).filter((skill) => skill.dir.includes("/.kimi-code/skills/")).map((skill) => skill.name));
    const mismatches = [
      ...[...desired].filter((name) => !actual.has(name)).map((name) => `skill "${name}" is missing on Kimi Code`),
      ...[...actual].filter((name) => !desired.has(name)).map((name) => `skill "${name}" is not in Kimi Code's canonical scope`),
    ];
    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
