/**
 * `trellis memory sync` — ingests canonical `memories/*.md` into the
 * on-disk knowledge-graph file `@modelcontextprotocol/server-memory`
 * itself reads at startup, closing P6's explicitly-left-open "auto-
 * ingesting memories/*.md content into the running memory server's
 * store" gap (trellis-memory-sync). Never spawns or talks to a running
 * server process — this is a plain file write, same posture as every
 * other Trellis write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { loadCanonicalSource } from "../core/canonical.js";
import { planMemorySync, renderMemoryGraph, type MemorySyncPlan } from "../lib/memoryGraph.js";

const MEMORY_SERVER_NAME = "memory";

export interface RunMemorySyncOptions {
  homeDir?: string;
  json?: boolean;
  dryRun?: boolean;
}

export type MemorySyncResult = { configured: true; graphPath: string; plan: MemorySyncPlan } | { configured: false; reason: string };

/**
 * Looks up `mcp.servers["memory"]` specifically (matching `schema/
 * servers.example.yaml`'s own naming convention for the default shared-
 * memory backend) — not a heuristic scan for any server whose command
 * happens to mention `@modelcontextprotocol/server-memory`, since a
 * user could reasonably name or configure it differently and this
 * would then silently miss it. `static_env.MEMORY_FILE_PATH` must be
 * set explicitly: the server's own unset-env default resolves relative
 * to wherever `npx` cached the package, a location Trellis has no
 * reliable way to predict.
 */
export function collectMemorySyncResult(homeDir: string = homedir()): MemorySyncResult {
  const canonical = loadCanonicalSource(homeDir);
  const server = canonical.mcp.servers[MEMORY_SERVER_NAME];
  const rawPath = server?.staticEnv?.MEMORY_FILE_PATH;
  if (!server || !rawPath) {
    return {
      configured: false,
      reason: `no "${MEMORY_SERVER_NAME}" MCP server with static_env.MEMORY_FILE_PATH configured in servers.yaml — see schema/servers.example.yaml`,
    };
  }

  const graphPath = rawPath.replace(/^~(?=$|\/)/, homeDir);
  const currentContent = existsSync(graphPath) ? readFileSync(graphPath, "utf-8") : undefined;
  const plan = planMemorySync(canonical, currentContent);
  return { configured: true, graphPath, plan };
}

export function applyMemorySync(result: MemorySyncResult): void {
  if (!result.configured || !result.plan.nextGraph) return;
  mkdirSync(dirname(result.graphPath), { recursive: true });
  writeFileSync(result.graphPath, renderMemoryGraph(result.plan.nextGraph));
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
    result = collectMemorySyncResult(homeDir);
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
