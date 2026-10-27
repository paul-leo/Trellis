/**
 * `host` facade — structured machine-readable checks
 * (host-extension-points spec).
 *
 * One composition of the three read-only checkers — doctor findings,
 * `sync --check` plan items, secrets audit — into a flat, comparable
 * result set. Every entry carries:
 *
 *   - a STABLE `id` whose identity is path-normalized (`<home>` /
 *     `<workspace>` placeholders), so the same logical finding produced
 *     against a real home and against a staging copy compares equal and
 *     two runs can be differenced as sets;
 *   - layer attribution (global vs a concrete workspace root), so a
 *     workspace-layer candidate can be evaluated without the global
 *     layer's own noise drowning it;
 *   - the collector's original `message` text (comparison is by `id`
 *     only — the message stays human-faithful).
 *
 * Checks stay read-only by construction: doctor runs with `probeMcp:
 * false` (no handshakes, no PATH scan — that's `runDoctor` CLI surface),
 * sync runs with `check: true` (zero writes, no backup session), and the
 * secrets audit only ever reads.
 */

import { collectDoctorReport, resolveKnownHostInjected } from "../commands/doctor.js";
import { collectSyncReport } from "../commands/sync.js";
import { collectSecretsAuditReport } from "../commands/secretsAudit.js";
import type { SurfaceLayer } from "./surface.js";

export type CheckSource = "doctor" | "sync" | "secrets";

export interface CheckEntry {
  /** Stable, path-normalized identity. Equal for the same logical finding
   * across a real run and a staging run; safe to use as a set key. */
  id: string;
  source: CheckSource;
  /** Collector-specific finding kind (doctor `FindingKind`, sync
   * `AdapterPlanItem.kind`, secrets audit's finding kind). */
  kind: string;
  layer: SurfaceLayer;
  /** The collector's original message text. NOT part of the identity. */
  message: string;
}

export interface CheckResult {
  /** Sorted by `id` for deterministic output. */
  entries: CheckEntry[];
}

export interface RunChecksOptions {
  homeDir: string;
  /** Physical workspace root to check — the scratch root when checking a
   * staging copy. Always passed explicitly; never inferred from cwd. */
  workspaceRoot?: string | null;
  /** The real workspace root a staging copy stands for. Used for id
   * normalization and as the layer label so scratch paths never leak
   * into comparable identities. Defaults to `workspaceRoot`. */
  logicalWorkspaceRoot?: string | null;
}

/** Escape a path root and replace it with a label only at path
 * boundaries (`/`, `:` as in `path:line:col`, or end of string), so a
 * home like `/tmp/ho` can never corrupt `/tmp/home/...`. Longest roots
 * must be replaced first by the caller (workspace before home). */
function replaceRoot(text: string, root: string, label: string): string {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?=[/:]|$)`, "g"), label);
}

function makeNormalizer(homeDir: string, roots: readonly (string | null | undefined)[]): (text: string) => string {
  const pairs: Array<{ root: string; label: string }> = [];
  for (const root of roots) {
    if (root) pairs.push({ root, label: "<workspace>" });
  }
  pairs.push({ root: homeDir, label: "<home>" });
  // Longest first: a workspace nested under home must be replaced before
  // the home prefix swallows it.
  pairs.sort((a, b) => b.root.length - a.root.length);
  return (text) => {
    let out = text;
    for (const { root, label } of pairs) out = replaceRoot(out, root, label);
    return out;
  };
}

interface LayerContext {
  /** Physical + logical workspace roots for "is this path under a
   * workspace" probes (raw text check). */
  physicalWorkspaceRoot: string | null;
  logicalWorkspaceRoot: string | null;
  /** Normalized text: a `<workspace>` marker is itself proof the entry
   * touched the workspace layer. */
  normalizedText: string;
}

function layerOf(kind: string, rawText: string, ctx: LayerContext): SurfaceLayer {
  const root = ctx.logicalWorkspaceRoot ?? ctx.physicalWorkspaceRoot;
  if (!root) return { kind: "global" };
  // Explicit kinds first (workspace-toml-invalid is workspace-born by
  // definition — it is parsed from a workspace-layer config file).
  if (kind === "workspace-toml-invalid") return { kind: "workspace", root };
  if (ctx.normalizedText.includes("<workspace>")) return { kind: "workspace", root };
  if (ctx.physicalWorkspaceRoot && rawText.includes(ctx.physicalWorkspaceRoot)) return { kind: "workspace", root };
  return { kind: "global" };
}

/**
 * Run the three machine-readable checks against one surface and return
 * their findings as one comparable set. Read-only: nothing on disk is
 * created, modified, or deleted by this function or its collectors.
 */
export async function runChecks(options: RunChecksOptions): Promise<CheckResult> {
  const homeDir = options.homeDir;
  const physicalWorkspaceRoot = options.workspaceRoot ?? null;
  const logicalWorkspaceRoot = options.logicalWorkspaceRoot ?? physicalWorkspaceRoot;
  const normalize = makeNormalizer(homeDir, [physicalWorkspaceRoot, logicalWorkspaceRoot]);
  const entries: CheckEntry[] = [];

  const doctorReport = await collectDoctorReport(
    homeDir,
    resolveKnownHostInjected({ homeDir }),
    false,
    physicalWorkspaceRoot,
  );
  for (const finding of doctorReport.findings) {
    const normalized = normalize(finding.message);
    entries.push({
      id: `doctor:${finding.kind}:${finding.agent ?? "-"}:${normalized}`,
      source: "doctor",
      kind: finding.kind,
      layer: layerOf(finding.kind, finding.message, { physicalWorkspaceRoot, logicalWorkspaceRoot, normalizedText: normalized }),
      message: finding.message,
    });
  }

  // `check: true` — plan only, zero writes, no backup session. The
  // managed set always comes from the surface's own canonical; and the
  // workspace layer is passed explicitly (null means "no layer", never
  // "guess from the caller's cwd").
  const syncReport = await collectSyncReport({
    homeDir,
    workspaceDir: physicalWorkspaceRoot,
    check: true,
  });
  for (const agentReport of syncReport.reports) {
    for (const item of agentReport.items) {
      const rawIdentity = `${item.action}:${item.kind}:${item.target}:${item.linkTarget ?? ""}:${item.mcpRemove?.name ?? item.mcpWrite?.name ?? ""}`;
      const normalized = normalize(rawIdentity);
      entries.push({
        id: `sync:${item.kind}:${item.action}:${normalized}`,
        source: "sync",
        kind: item.kind,
        layer: item.layer === "workspace"
          ? { kind: "workspace", root: logicalWorkspaceRoot ?? physicalWorkspaceRoot ?? "" }
          : layerOf(item.kind, rawIdentity, { physicalWorkspaceRoot, logicalWorkspaceRoot, normalizedText: normalized }),
        message: item.description,
      });
    }
  }

  const secretsReport = await collectSecretsAuditReport({ homeDir });
  for (const finding of secretsReport.findings) {
    const rawIdentity = `${finding.agent}:${finding.file}:${finding.detail}`;
    const normalized = normalize(rawIdentity);
    entries.push({
      id: `secrets:${finding.kind}:${normalized}`,
      source: "secrets",
      kind: finding.kind,
      layer: layerOf(finding.kind, rawIdentity, { physicalWorkspaceRoot, logicalWorkspaceRoot, normalizedText: normalized }),
      message: `${finding.agent} ${finding.file}: ${finding.detail}`,
    });
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries };
}
