#!/usr/bin/env node
// 依赖审计(任务 2.1):证明本包 runtime 依赖为空。
// 规则:package.json 的 dependencies 必须不存在或为空;
// src/ 内允许的唯一 bare import 前缀是 node:(Node 内建),其余一律失败。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

const failures = [];

const runtimeDeps = Object.keys(pkg.dependencies ?? {});
if (runtimeDeps.length > 0) {
  failures.push(`runtime dependencies 必须为空,实际: ${runtimeDeps.join(", ")}`);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

const importRe = /^\s*import(?:\s+type)?[\s\S]*?from\s+["']([^"']+)["']/gm;
for (const file of walk(join(pkgDir, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(importRe)) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("node:")) continue;
    failures.push(`${file}: 禁止的外部 import "${spec}"`);
  }
}

if (failures.length > 0) {
  console.error("依赖审计失败:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("依赖审计通过: runtime deps 为空,src 内无外部 import。");
