import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCanonicalSource } from "../core/canonical.js";
import { parseMemoryGraph, renderExtractedMemoryFile, type MemoryEntity, type MemoryRelation } from "../lib/memoryGraph.js";
import { slugify } from "../lib/slug.js";

export interface MemoryExportOptions { homeDir?: string; dryRun?: boolean; json?: boolean }

/** Export one graph-file snapshot without changing either live store. */
export function runMemoryExport(opts: MemoryExportOptions = {}): {exitCode: number} {
  try {
    const home = opts.homeDir ?? homedir();
    const server = loadCanonicalSource(home).mcp.servers.memory;
    const rawPath = server?.staticEnv?.MEMORY_FILE_PATH;
    if (!server || !rawPath) throw new Error("No local memory graph configured with MEMORY_FILE_PATH; nothing to export.");
    const graphPath = rawPath.replace(/^~(?=$|\/)/, home);
    if (!existsSync(graphPath)) throw new Error("Memory graph does not exist yet; save shared memory through MCP before exporting.");
    const snapshot = readFileSync(graphPath, "utf8");
    const parsed = parseMemoryGraph(snapshot);
    const entities = parsed.filter((line): line is MemoryEntity => line.type === "entity");
    const relations = parsed.filter((line): line is MemoryRelation => line.type === "relation");
    const exportedAt = new Date().toISOString();
    const directory = join(home, ".trellis", "archive", "memory", "snapshots", exportedAt.replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8));
    const records = entities.map((entity) => ({entity, filename: `${slugify(entity.name).slice(0, 100) || "entity"}-${createHash("sha256").update(entity.name).digest("hex").slice(0, 12)}.md`}));
    if (new Set(records.map(record => record.filename)).size !== records.length) throw new Error("Duplicate entity names in graph; refusing an ambiguous export.");
    const summary = {exportedAt, source: graphPath, directory, entities: entities.length, relations: relations.length, snapshotSha256: createHash("sha256").update(snapshot).digest("hex"), dryRun: Boolean(opts.dryRun)};
    if (!opts.dryRun) {
      mkdirSync(join(home, ".trellis", "archive", "memory", "snapshots"), {recursive: true, mode: 0o700});
      mkdirSync(directory, {mode: 0o700});
      writeFileSync(join(directory, "graph.jsonl"), snapshot, {mode: 0o600, flag: "wx"});
      for (const {entity, filename} of records) writeFileSync(join(directory, filename), renderExtractedMemoryFile(entity, relations), {mode: 0o600, flag: "wx"});
      writeFileSync(join(directory, "index.json"), JSON.stringify({...summary, records: records.map(({entity, filename}) => ({name: entity.name, filename}))}, null, 2) + "\n", {mode: 0o600, flag: "wx"});
    }
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(`${opts.dryRun ? "[dry run] " : ""}memory export — ${entities.length} entities, ${relations.length} relations\n  ${directory}`);
    return {exitCode: 0};
  } catch (error) {
    if (opts.json) console.log(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
    else console.error(error instanceof Error ? error.message : String(error));
    return {exitCode: 1};
  }
}
