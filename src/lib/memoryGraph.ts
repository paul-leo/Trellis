/**
 * Converts canonical `memories/*.md` into `@modelcontextprotocol/
 * server-memory`'s own on-disk JSON-lines knowledge-graph format, and
 * upserts them into an existing graph file without disturbing anything
 * else in it (trellis-memory-sync) — closing P6's explicitly-left-open
 * "auto-ingesting memories/*.md content into the running memory
 * server's store" gap.
 *
 * Each line in that file is one JSON object, either
 * `{type:"entity", name, entityType, observations}` or
 * `{type:"relation", from, to, relationType}` — the real, documented
 * shape the official server persists and reads back on its own next
 * startup (this project writes the file directly; it never spawns or
 * talks to a running server process).
 *
 * `entityType: "trellis-memory"` is this project's own in-band ownership
 * marker — simpler than a separate ledger file (unlike MCP server sync,
 * every agent connected to this one server shares the exact same graph,
 * so there's no per-agent rendering to track). An existing entity with
 * the same name but a different `entityType` was created by something
 * else (an agent's own runtime tool calls, most likely) and is left
 * completely untouched — reported as a conflict, never overwritten.
 */

import { readFileSync } from "node:fs";
import type { CanonicalSource } from "../core/types.js";

export interface MemoryEntity {
  type: "entity";
  name: string;
  entityType: string;
  observations: string[];
}

export interface MemoryRelation {
  type: "relation";
  from: string;
  to: string;
  relationType: string;
}

export type MemoryGraphLine = MemoryEntity | MemoryRelation;

export const TRELLIS_MEMORY_ENTITY_TYPE = "trellis-memory";

export function parseMemoryGraph(content: string): MemoryGraphLine[] {
  const lines: MemoryGraphLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as MemoryGraphLine;
      if (parsed.type === "entity" || parsed.type === "relation") {
        lines.push(parsed);
      }
    } catch {
      // Not valid JSON — skip rather than fail the whole file; a
      // hand-edited or partially-written line shouldn't block every
      // other, unrelated line in the graph.
    }
  }
  return lines;
}

export function renderMemoryGraph(lines: readonly MemoryGraphLine[]): string {
  if (lines.length === 0) return "";
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export type MemorySyncAction = "create" | "already-synced" | "remove" | "conflict";

export interface MemorySyncItem {
  name: string;
  action: MemorySyncAction;
  detail: string;
}

export interface MemorySyncPlan {
  items: MemorySyncItem[];
  /** The full graph content to write — `undefined` when there is
   * nothing to change (no create/remove items). */
  nextGraph?: MemoryGraphLine[];
}

/**
 * Pure: computes the next graph state and a human-readable plan, given
 * the current graph's raw content (or `undefined` if the file doesn't
 * exist yet) and canonical's memory entries. Every non-`trellis-memory`
 * entity and every relation passes through completely untouched,
 * regardless of what canonical wants.
 */
export function planMemorySync(canonical: Pick<CanonicalSource, "memories">, currentGraphContent: string | undefined): MemorySyncPlan {
  const existingLines = currentGraphContent !== undefined ? parseMemoryGraph(currentGraphContent) : [];
  const untouchedLines = existingLines.filter((line) => !(line.type === "entity" && line.entityType === TRELLIS_MEMORY_ENTITY_TYPE));
  const existingTrellisEntities = new Map(
    existingLines.filter((line): line is MemoryEntity => line.type === "entity" && line.entityType === TRELLIS_MEMORY_ENTITY_TYPE).map((e) => [e.name, e]),
  );
  const existingOtherEntityNames = new Set(
    existingLines.filter((line): line is MemoryEntity => line.type === "entity" && line.entityType !== TRELLIS_MEMORY_ENTITY_TYPE).map((e) => e.name),
  );

  const items: MemorySyncItem[] = [];
  const nextTrellisEntities: MemoryEntity[] = [];
  let changed = false;

  const canonicalNames = new Set(canonical.memories.map((m) => m.name));

  for (const memory of canonical.memories) {
    if (existingOtherEntityNames.has(memory.name)) {
      items.push({ name: memory.name, action: "conflict", detail: `an entity named "${memory.name}" already exists in the graph and wasn't created by Trellis — resolve by hand` });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(memory.file, "utf-8");
    } catch (err) {
      items.push({ name: memory.name, action: "conflict", detail: `could not read ${memory.file}: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const desired: MemoryEntity = { type: "entity", name: memory.name, entityType: TRELLIS_MEMORY_ENTITY_TYPE, observations: [content] };
    const existing = existingTrellisEntities.get(memory.name);
    nextTrellisEntities.push(desired);
    if (existing && existing.observations.length === 1 && existing.observations[0] === content) {
      items.push({ name: memory.name, action: "already-synced", detail: "graph content is already identical" });
    } else {
      items.push({ name: memory.name, action: "create", detail: existing ? "will update the existing entity's observation" : "will create a new entity" });
      changed = true;
    }
  }

  for (const [name] of existingTrellisEntities) {
    if (canonicalNames.has(name)) continue; // still wanted, handled above
    items.push({ name, action: "remove", detail: "no longer in canonical — will be removed from the graph" });
    changed = true;
  }

  if (!changed) {
    return { items };
  }
  return { items, nextGraph: [...untouchedLines, ...nextTrellisEntities] };
}
