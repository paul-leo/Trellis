/**
 * pi adapter: `~/.pi/agent/skills/<name>` symlinks, `~/.pi/agent/AGENTS.md`
 * symlinked to canonical `agents.md` — specifically `AGENTS.md`, not
 * `AGENTS.override.md` (design.md D3, trellis-sync-p1: pi checks the
 * override name first, and Trellis's managed file is the baseline, not an
 * override of something else).
 *
 * MCP delivery is version-gated (trellis-pi-native-mcp-migration):
 *
 * - pi >= 1.1.0 has a native MCP client, so `trellis mcp sync` merges
 *   Trellis-managed entries into `~/.pi/agent/mcp.json` through the shared
 *   `planJsonMcp`/`applyJsonMcp` machinery (ownership ledger, conflict
 *   detection, user entries preserved) with the pi-shaped renderer from
 *   `piMcp.ts`. Gateway route → the single `trellis` runtime entry;
 *   agent-owned OAuth servers → bare `{url}` entries the user authorizes
 *   with `pi mcp login`.
 * - Older pis (or an unprobeable version) keep the legacy delivery: a
 *   single symlinked bridge extension (`dist/pi-bridge/bundle.js`,
 *   trellis-pi-mcp-bridge-p4). The version gate never moves a machine
 *   FROM the bridge TO native until the mcp.json write succeeds — the
 *   bridge-removal item rides along in the same plan, ordered after the
 *   config write, and is withheld entirely when any write conflicts
 *   (design.md D3: the two deliveries may never be active at once, every
 *   tool would register twice).
 */

import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import { usesNativeCapabilityDelivery } from "../core/types.js";
import type { CanonicalSource } from "../core/types.js";
import * as piProbe from "../probes/pi.js";
import { probePiVersion } from "../probes/pi.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";
import { applyJsonMcp, planJsonMcp } from "./jsonMcp.js";
import { piRenderer, supportsNativeMcp } from "./piMcp.js";
import { loadMcpOwnership, ownedByAgent, recordOwned, forgetOwned, saveMcpOwnership } from "../lib/mcpOwnership.js";
import { currentLinkTarget, type BackupSession } from "../lib/backup.js";
import { globalLayerMcp, globalLayerSkills } from "../lib/workspaceMerge.js";

const BRIDGE_SYMLINK_NAME = "trellis-mcp-bridge.js";

/**
 * A source-checkout bridge can survive a switch to the packaged CLI. Adopt it
 * only when it has the Trellis bridge artifact shape and is byte-identical
 * to the bundle this installation would write. This is intentionally not a
 * general symlink ownership rule.
 */
function isEquivalentTrellisBridge(existingTarget: string, desiredTarget: string): boolean {
  if (!existingTarget.endsWith(`${sep}${join("dist", "pi-bridge", "bundle.js")}`)) return false;
  try {
    return readFileSync(existingTarget).equals(readFileSync(desiredTarget));
  } catch {
    return false;
  }
}

/**
 * The bundled bridge file's location — always `<repo-root>/dist/pi-bridge/
 * bundle.js`, never `~/.trellis/` (it's Trellis's own packaged code, not a
 * user-authored capability — design.md D2). Resolved relative to *this
 * currently executing module* rather than assumed: both `src/adapters/
 * pi.ts` (dev, via tsx) and `dist/adapters/pi.js` (published) sit exactly
 * two directories below the repo root, so `../../dist/pi-bridge/bundle.js`
 * resolves correctly from either.
 *
 * Always the *bundled* output, in dev too — never the raw
 * `src/pi-bridge/index.ts` source. Node's loader resolves a symlinked
 * file's own bare-specifier imports relative to the *symlink's path*
 * (`~/.pi/agent/extensions/...`), not its realpath, so an unbundled file
 * can never resolve `typebox`/`@modelcontextprotocol/sdk` once symlinked
 * into an arbitrary user's home directory — confirmed empirically in the
 * real sandbox (design.md D6). `scripts/build-pi-bridge.mjs` must have run
 * (part of `npm run build`) before this symlink is of any use to pi.
 */
function resolveBridgeFile(): { file: string; symlinkName: string } {
  const currentFile = fileURLToPath(import.meta.url);
  return {
    file: join(dirname(currentFile), "..", "..", "dist", "pi-bridge", "bundle.js"),
    symlinkName: BRIDGE_SYMLINK_NAME,
  };
}

export class PiAdapter implements TrellisAdapter {
  readonly name = "pi";
  readonly id = "pi" as const;

  constructor(
    private readonly homeDir: string = homedir(),
    /** Test seam: the version gate must not depend on whatever pi happens
     * to be installed on the machine running the tests. */
    private readonly versionProbe: () => string | undefined = probePiVersion,
  ) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await piProbe.probe(this.homeDir);
    return { present: snapshot.present, version: snapshot.version };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const canonicalRoot = dirname(canonical.instructionsFile);
    const agentDir = join(this.homeDir, ".pi", "agent");

    const desiredSkills = globalLayerSkills(canonical)
      .filter((skill) => usesNativeCapabilityDelivery(this.id, canonical.mcp) && isInScope(this.id, skill.scope, canonical.managedAgents))
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

    if (supportsNativeMcp(this.versionProbe())) {
      return [...skillItems, ...instructionsItems, ...this.planNativeMcp(canonical)];
    }

    const { file: bridgeFile, symlinkName } = resolveBridgeFile();
    const extensionItems = planSymlinks({
      rootDir: join(agentDir, "extensions"),
      desired: [{ name: symlinkName, target: bridgeFile }],
      // The bridge file's own parent directory, not `~/.trellis/` —
      // proves ownership for removal against Trellis's own install path
      // (design.md D2), same role `canonicalRoot` plays for skills.
      canonicalRoot: dirname(bridgeFile),
      kind: "extension",
      adoptExistingSymlink: isEquivalentTrellisBridge,
    });

    return [...skillItems, ...instructionsItems, ...extensionItems];
  }

  /**
   * Native-delivery plan (design.md D1/D3). The write items come from the
   * shared JSON machinery unchanged; the bridge-removal item is appended
   * last and re-cast to kind "mcp" so it travels through `trellis mcp
   * sync` — the same command that writes mcp.json — never through bare
   * `trellis sync`. That is what makes the migration atomic from the
   * user's point of view: the config lands and the bridge leaves in one
   * apply, and a bare skills/instructions sync can neither remove the
   * bridge early nor resurrect it afterwards.
   */
  private planNativeMcp(canonical: CanonicalSource): AdapterPlanItem[] {
    const agentDir = join(this.homeDir, ".pi", "agent");
    const configPath = join(agentDir, "mcp.json");
    const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
    const ownership = ownedByAgent(loadMcpOwnership(this.homeDir), this.id);

    const items = planJsonMcp({
      configPath,
      parsed,
      mcp: globalLayerMcp(canonical),
      agentId: this.id,
      managedAgents: canonical.managedAgents,
      policy: canonical.secretsPolicy,
      ownership,
      render: piRenderer,
    }).map((item) => {
      // pi speaks stdio and streamable HTTP only — an sse server gets an
      // honest conflict instead of an entry pi could never connect.
      const write = item.mcpWrite;
      if (write?.def.transport !== "sse") return item;
      return {
        action: "conflict",
        kind: "mcp",
        target: item.target,
        description: `MCP server "${write.name}" uses the sse transport, which pi does not support (stdio and streamable HTTP only) — no entry written to ${item.target}`,
        remediation: "switch the server to streamable HTTP or stdio, or scope it away from pi",
      } satisfies AdapterPlanItem;
    });

    const bridgePath = join(agentDir, "extensions", BRIDGE_SYMLINK_NAME);
    const hasConflict = items.some((item) => item.action === "conflict");
    if (!hasConflict && this.isOwnedBridgeSymlink(bridgePath)) {
      items.push({
        action: "remove",
        kind: "mcp",
        target: bridgePath,
        description: `remove Trellis MCP bridge extension ${bridgePath} — pi >= 1.1.0 receives MCP natively via mcp.json`,
      });
    }
    return items;
  }

  /**
   * Removal ownership for the bridge, mirroring `planSymlinks`' rule: the
   * raw readlink target must resolve under this installation's
   * `dist/pi-bridge/` directory, or be a byte-identical bundle at the
   * Trellis artifact shape left by a previous install root. Anything else
   * is the user's and stays.
   */
  private isOwnedBridgeSymlink(bridgePath: string): boolean {
    const stat = lstatSync(bridgePath, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) return false;
    const rawTarget = readlinkSync(bridgePath);
    const { file } = resolveBridgeFile();
    const bridgeRoot = dirname(file);
    const resolved = rawTarget.startsWith(sep) ? rawTarget : join(dirname(bridgePath), rawTarget);
    if (resolved === file || resolved.startsWith(bridgeRoot.endsWith(sep) ? bridgeRoot : `${bridgeRoot}${sep}`)) return true;
    return isEquivalentTrellisBridge(resolved, file);
  }

  async apply(plan: AdapterPlanItem[], backup: BackupSession): Promise<void> {
    await applySymlinkPlan(
      plan.filter((item) => item.kind !== "mcp"),
      backup,
    );

    // Real config writes carry mcpWrite/mcpRemove; the bridge-removal
    // item is the only kind:"mcp" entry without either, and it must run
    // strictly after the config write (design.md D3).
    const mcpWrites = plan.filter((item) => item.kind === "mcp" && (item.mcpWrite || item.mcpRemove));
    const bridgeRemovals = plan.filter((item) => item.kind === "mcp" && item.action === "remove" && !item.mcpWrite && !item.mcpRemove);

    if (mcpWrites.length > 0) {
      const configPath = mcpWrites[0].target;
      const parsed = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>) : undefined;
      const merged = applyJsonMcp(parsed, mcpWrites, piRenderer);
      backup.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);

      let ownership = loadMcpOwnership(this.homeDir);
      for (const item of mcpWrites) {
        if (item.action === "create" && item.mcpWrite) {
          ownership = recordOwned(ownership, this.id, item.mcpWrite.name, piRenderer(item.mcpWrite.def, item.mcpWrite.name));
        } else if (item.action === "remove" && item.mcpRemove) {
          ownership = forgetOwned(ownership, this.id, item.mcpRemove.name);
        }
      }
      saveMcpOwnership(this.homeDir, ownership);
    }

    for (const item of bridgeRemovals) {
      const oldTarget = await currentLinkTarget(item.target);
      if (oldTarget === undefined) continue; // already gone — nothing to record
      await backup.removeSymlink(item.target, oldTarget);
    }
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await piProbe.probe(this.homeDir);
    if (!snapshot.present) {
      return { ok: false, mismatches: ["pi is not present on this machine"] };
    }

    const mismatches: string[] = [];
    const desiredNames = new Set(globalLayerSkills(canonical).filter((s) => usesNativeCapabilityDelivery(this.id, canonical.mcp) && isInScope(this.id, s.scope, canonical.managedAgents)).map((s) => s.name));
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

    if (supportsNativeMcp(this.versionProbe())) {
      // Native mode drift: anything the plan still wants to change is by
      // definition drift. The plan only ever names Trellis-owned entries
      // (the ownership ledger gates removals), so user-authored servers
      // can never surface here.
      for (const item of this.planNativeMcp(canonical)) {
        if (item.action === "create" && item.mcpWrite) {
          mismatches.push(`mcp.json entry "${item.mcpWrite.name}" is missing or differs from canonical — run trellis mcp sync`);
        } else if (item.action === "remove" && item.mcpRemove) {
          mismatches.push(`mcp.json entry "${item.mcpRemove.name}" is Trellis-owned but no longer in canonical — run trellis mcp sync`);
        } else if (item.action === "remove") {
          mismatches.push(`the Trellis MCP bridge extension is still installed but pi >= 1.1.0 uses native mcp.json — run trellis mcp sync`);
        } else if (item.action === "conflict") {
          mismatches.push(item.description);
        }
      }
    }

    return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
  }
}
