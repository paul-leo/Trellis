/**
 * 可编辑树 → canonical staging 的布局映射(trellis-evolve 任务 9.2)。
 *
 * 树的四个可编辑类目落到 canonical 的对应物:
 *
 *   agents.md                  →  <home>/.trellis/agents.md           整文件替换
 *   skills/<name>/**           →  <home>/.trellis/skills/<name>/**    原样落盘
 *   mcp/routes.yaml            →  <home>/.trellis/mcp/servers.yaml    只替换 routes: 节
 *   memory/policy.yaml         →  <home>/.trellis/scope.yaml          只替换 memories: 节
 *
 * 两个 section 文件的关键性质:servers.yaml 的 server 定义/auth 与
 * scope.yaml 的 skills/agents 节都不在可编辑 schema 内(Class C / 托管
 * 自有),所以落盘是节级 splice —— 解析目标文件、只替换对应顶层键、其余
 * 内容(含注释)原样保留 —— 而不是整文件覆盖。
 *
 * 严格性约定:section 文件本身必须是可解析的 YAML(语法级严格,坏树是
 * materialise 错误);section 内容语义由 canonical 加载器自行容错(语义级
 * 宽松,坏路由在检查结果里显形而不是炸掉 staging)。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Document, parse as parseYaml, parseDocument } from "yaml";
import type { Tree } from "@trellis/evolve-engine";

/** `routes:` 节的语义守卫:值必须是 {agent: {mode: direct|gateway|hub, servers?}}。
 * 语法可解析但形状明显错误的候选仍写进 staging(canonical 加载器容错,
 * 检查差集会显形);这里只拦"根本不是 map"的类别错误。 */
function assertSectionIsMap(key: string, value: unknown): void {
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`tree section for "${key}" must be a YAML mapping, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
}

/** Replace (or, for empty/null section content, delete) one top-level key
 * in a YAML file, preserving every other section byte-for-byte where the
 * parser allows. Creates the file when absent. */
export function spliceYamlSection(path: string, key: string, sectionContent: string): void {
  const value: unknown = parseYaml(sectionContent);
  assertSectionIsMap(key, value);
  const doc = existsSync(path) ? parseDocumentOrThrow(path) : new Document({});
  if (value === null || value === undefined) {
    doc.delete(key);
  } else {
    doc.set(key, value as Record<string, unknown>);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(doc));
}

function parseDocumentOrThrow(path: string): Document {
  const text = readFileSync(path, "utf-8");
  const parsed: unknown = parseYaml(text);
  if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new Error(`${path} is not a YAML mapping at the top level`);
  }
  return parseDocument(text);
}

/** The tree rel paths this mapping knows how to place. Anything else is a
 * bug in the caller (the engine's read_tree already filters by the
 * surface schema) — refuse loudly rather than drop a file silently. */
export function applyTreeToStaging(tree: Tree, stagingHome: string): void {
  const trellisRoot = join(stagingHome, ".trellis");
  for (const [rel, content] of Object.entries(tree)) {
    if (rel === "agents.md") {
      writeFileSync(join(trellisRoot, "agents.md"), content);
    } else if (rel === "mcp/routes.yaml") {
      spliceYamlSection(join(trellisRoot, "mcp", "servers.yaml"), "routes", content);
    } else if (rel === "memory/policy.yaml") {
      spliceYamlSection(join(trellisRoot, "scope.yaml"), "memories", content);
    } else if (rel.startsWith("skills/")) {
      const target = join(trellisRoot, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    } else {
      throw new Error(`tree path "${rel}" is on the surface schema but has no canonical mapping`);
    }
  }
}
