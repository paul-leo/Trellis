/**
 * pi adapter: `~/.pi/agent/skills/<name>` symlinks, `~/.pi/agent/AGENTS.md`
 * symlinked to canonical `agents.md` — specifically `AGENTS.md`, not
 * `AGENTS.override.md` (design.md D3, trellis-sync-p1: pi checks the
 * override name first, and Trellis's managed file is the baseline, not an
 * override of something else). pi has no native MCP client (docs/research.md),
 * so MCP access is delivered as a single symlinked bridge extension
 * instead of native config (trellis-pi-mcp-bridge-p4) — a different
 * mechanism from every other agent's config-generation adapter, but the
 * same symlink create/repair/remove machinery as skills/instructions.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { AdapterPlanItem, AdapterProbeResult, AdapterVerifyResult, TrellisAdapter } from "../core/adapter.js";
import { isInScope } from "../core/adapter.js";
import type { CanonicalSource } from "../core/types.js";
import * as piProbe from "../probes/pi.js";
import { applySymlinkPlan, planSymlinks } from "./symlinkPlan.js";
import type { BackupSession } from "../lib/backup.js";

const BRIDGE_SYMLINK_NAME = "trellis-mcp-bridge.js";

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

  constructor(private readonly homeDir: string = homedir()) {}

  async probe(): Promise<AdapterProbeResult> {
    const snapshot = await piProbe.probe(this.homeDir);
    return { present: snapshot.present, version: snapshot.version };
  }

  async plan(canonical: CanonicalSource): Promise<AdapterPlanItem[]> {
    const canonicalRoot = dirname(canonical.instructionsFile);
    const agentDir = join(this.homeDir, ".pi", "agent");

    const desiredSkills = canonical.skills
      .filter((skill) => isInScope(this.id, skill.scope, canonical.managedAgents))
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

    const { file: bridgeFile, symlinkName } = resolveBridgeFile();
    const extensionItems = planSymlinks({
      rootDir: join(agentDir, "extensions"),
      desired: [{ name: symlinkName, target: bridgeFile }],
      // The bridge file's own parent directory, not `~/.trellis/` —
      // proves ownership for removal against Trellis's own install path
      // (design.md D2), same role `canonicalRoot` plays for skills.
      canonicalRoot: dirname(bridgeFile),
      kind: "extension",
    });

    return [...skillItems, ...instructionsItems, ...extensionItems];
  }

  async apply(plan: AdapterPlanItem[], backup: BackupSession): Promise<void> {
    await applySymlinkPlan(plan, backup);
  }

  async verify(canonical: CanonicalSource): Promise<AdapterVerifyResult> {
    const snapshot = await piProbe.probe(this.homeDir);
    if (!snapshot.present) {
      return { ok: false, mismatches: ["pi is not present on this machine"] };
    }

    const mismatches: string[] = [];
    const desiredNames = new Set(canonical.skills.filter((s) => isInScope(this.id, s.scope, canonical.managedAgents)).map((s) => s.name));
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
