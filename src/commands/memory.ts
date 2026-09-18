/**
 * `trellis memory sync`/`trellis memory extract` — the two one-directional
 * halves of Trellis's shared-memory story: sync ingests canonical
 * `memories/*.md` into the on-disk knowledge-graph file
 * `@modelcontextprotocol/server-memory` itself reads at startup, closing
 * P6's explicitly-left-open "auto-ingesting memories/*.md content into
 * the running memory server's store" gap (trellis-memory-sync); extract
 * reads the graph's own real, non-Trellis entities back into new
 * canonical files, closing P15's own explicitly-named "per-agent
 * extraction into canonical remains a separate, open gap"
 * (trellis-memory-extraction). Neither spawns or talks to a running
 * server process — both are plain file operations, same posture as
 * every other Trellis write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadCanonicalSource } from "../core/canonical.js";
import type { McpServerDef } from "../core/types.js";
import type { BackupSession } from "../lib/backup.js";
import { parseMemoryGraph, planMemoryExtraction, planMemorySync, renderMemoryGraph, type MemoryExtractionPlan, type MemorySyncPlan } from "../lib/memoryGraph.js";

/** Exported so `onboard` (`trellis onboard --memory on|off`,
 * trellis-onboard-mcp-mode) can look up and write this same entry
 * without hardcoding the name a second time. */
export const MEMORY_SERVER_NAME = "memory";

/**
 * The literal definition `trellis onboard --memory on` writes — the
 * same shape `schema/servers.example.yaml`'s commented-out `memory:`
 * block documents, now a real, code-owned constant instead of the only
 * place this shape existed being prose a user hand-transcribes
 * (trellis-onboard-mcp-mode design.md D9). `MEMORY_FILE_PATH` must be
 * set explicitly — see `resolveMemoryServerGraphPath`'s own comment for
 * why an unset one isn't safe to leave to the server's own default.
 */
export const DEFAULT_MEMORY_SERVER_DEF: McpServerDef = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
  staticEnv: { MEMORY_FILE_PATH: "~/.trellis/memories/graph.jsonl" },
};

export interface RunMemorySyncOptions {
  homeDir?: string;
  json?: boolean;
  dryRun?: boolean;
  selectedMemoryNames?: readonly string[];
}

export type MemorySyncResult = { configured: true; graphPath: string; plan: MemorySyncPlan } | { configured: false; reason: string };

type MemoryServerLookup = { configured: true; graphPath: string } | { configured: false; reason: string };

/**
 * Looks up `mcp.servers["memory"]` specifically (matching `schema/
 * servers.example.yaml`'s own naming convention for the default shared-
 * memory backend) — not a heuristic scan for any server whose command
 * happens to mention `@modelcontextprotocol/server-memory`, since a
 * user could reasonably name or configure it differently and this
 * would then silently miss it. `static_env.MEMORY_FILE_PATH` must be
 * set explicitly: the server's own unset-env default resolves relative
 * to wherever `npx` cached the package, a location Trellis has no
 * reliable way to predict. Shared by `collectMemorySyncResult` and
 * `collectMemoryExtractionResult` — both directions must never disagree
 * about which graph file they're reading/writing
 * (trellis-memory-extraction).
 */
function resolveMemoryServerGraphPath(homeDir: string): MemoryServerLookup {
  const canonical = loadCanonicalSource(homeDir);
  const server = canonical.mcp.servers[MEMORY_SERVER_NAME];
  const rawPath = server?.staticEnv?.MEMORY_FILE_PATH;
  if (!server || !rawPath) {
    return {
      configured: false,
      reason: `no "${MEMORY_SERVER_NAME}" MCP server with static_env.MEMORY_FILE_PATH configured in servers.yaml — see schema/servers.example.yaml`,
    };
  }
  return { configured: true, graphPath: rawPath.replace(/^~(?=$|\/)/, homeDir) };
}

export function collectMemorySyncResult(homeDir: string = homedir(), selectedMemoryNames?: readonly string[]): MemorySyncResult {
  const lookup = resolveMemoryServerGraphPath(homeDir);
  if (!lookup.configured) return lookup;

  const canonical = loadCanonicalSource(homeDir);
  const currentContent = existsSync(lookup.graphPath) ? readFileSync(lookup.graphPath, "utf-8") : undefined;
  const plan = planMemorySync(canonical, currentContent, selectedMemoryNames);
  return { configured: true, graphPath: lookup.graphPath, plan };
}

export function applyMemorySync(result: MemorySyncResult, backup?: BackupSession): void {
  if (!result.configured || !result.plan.nextGraph) return;
  mkdirSync(dirname(result.graphPath), { recursive: true });
  const content = renderMemoryGraph(result.plan.nextGraph);
  if (backup) backup.writeFile(result.graphPath, content);
  else writeFileSync(result.graphPath, content);
}

/**
 * Extracted from `runMemorySync` (trellis-onboard-mcp-memory) so
 * `onboard`'s own chained output can print this stage in the exact same
 * format without a second, drifting copy — mirrors the
 * `collect...Report`/`print...Report` export pair every other chained
 * stage (`sync`, `mcp sync`, `secrets audit`) already has.
 */
export function printMemorySyncResult(result: MemorySyncResult, dryRun: boolean): void {
  if (!result.configured) {
    console.log(result.reason);
    return;
  }
  console.log(`${dryRun ? "[dry run] " : ""}memory sync — ${result.graphPath}`);
  if (result.plan.items.length === 0) {
    console.log("  nothing in canonical memories/ yet");
  }
  for (const item of result.plan.items) {
    console.log(`  [${item.action}] "${item.name}" — ${item.detail}`);
  }
}

export function runMemorySync(opts: RunMemorySyncOptions = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  let result: MemorySyncResult;
  try {
    result = collectMemorySyncResult(homeDir, opts.selectedMemoryNames);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (!opts.dryRun) {
    applyMemorySync(result);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printMemorySyncResult(result, opts.dryRun ?? false);
  }

  const hasConflict = result.configured && result.plan.items.some((i) => i.action === "conflict");
  return { exitCode: hasConflict ? 1 : 0 };
}

export interface RunMemoryExtractionOptions {
  homeDir?: string;
  json?: boolean;
  dryRun?: boolean;
}

export type MemoryExtractionResult = { configured: true; graphPath: string; plan: MemoryExtractionPlan } | { configured: false; reason: string };

function canonicalMemoryFilePath(homeDir: string, slug: string): string {
  return join(homeDir, ".trellis", "memories", `${slug}.md`);
}

/**
 * The reverse direction of `collectMemorySyncResult`: reads the same
 * graph file, but plans which of its real, non-`trellis-memory` entities
 * (`planMemoryExtraction`) should become new canonical files — never the
 * other way around, and never touching an entity `memory sync` itself
 * owns (trellis-memory-extraction).
 */
export function collectMemoryExtractionResult(homeDir: string = homedir()): MemoryExtractionResult {
  const lookup = resolveMemoryServerGraphPath(homeDir);
  if (!lookup.configured) return lookup;

  const graphContent = existsSync(lookup.graphPath) ? readFileSync(lookup.graphPath, "utf-8") : undefined;
  const graphLines = graphContent !== undefined ? parseMemoryGraph(graphContent) : [];
  const plan = planMemoryExtraction(graphLines, (slug) => {
    const file = canonicalMemoryFilePath(homeDir, slug);
    return existsSync(file) ? readFileSync(file, "utf-8") : undefined;
  });
  return { configured: true, graphPath: lookup.graphPath, plan };
}

export function applyMemoryExtraction(result: MemoryExtractionResult, homeDir: string = homedir()): void {
  if (!result.configured) return;
  for (const item of result.plan.items) {
    if (item.action !== "create" || item.content === undefined) continue;
    const file = canonicalMemoryFilePath(homeDir, item.slug);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, item.content);
  }
}

/** Mirrors `printMemorySyncResult`'s own export-pair convention — reused
 * verbatim if `onboard` ever chains this stage too, not a second,
 * drifting copy. */
export function printMemoryExtractionResult(result: MemoryExtractionResult, dryRun: boolean): void {
  if (!result.configured) {
    console.log(result.reason);
    return;
  }
  console.log(`${dryRun ? "[dry run] " : ""}memory extract — ${result.graphPath}`);
  if (result.plan.items.length === 0) {
    console.log("  nothing to extract — no non-trellis-memory entities with observations in the graph");
  }
  for (const item of result.plan.items) {
    console.log(`  [${item.action}] "${item.name}" (${item.slug}.md) — ${item.detail}`);
  }
}

export function runMemoryExtraction(opts: RunMemoryExtractionOptions = {}): { exitCode: number } {
  const homeDir = opts.homeDir ?? homedir();
  let result: MemoryExtractionResult;
  try {
    result = collectMemoryExtractionResult(homeDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (!opts.dryRun) {
    applyMemoryExtraction(result, homeDir);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printMemoryExtractionResult(result, opts.dryRun ?? false);
  }

  const hasConflict = result.configured && result.plan.items.some((i) => i.action === "conflict");
  return { exitCode: hasConflict ? 1 : 0 };
}
