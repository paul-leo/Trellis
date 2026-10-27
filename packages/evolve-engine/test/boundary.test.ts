// 边界测试(任务 2.1):引擎包不 import 任何 Trellis 代码。
// 反例规则:src/ 内出现指向 Trellis 宿主的 import(agent-trellis、
// 逃逸包根目录的相对路径)即失败。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkgDir = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const srcDir = join(pkgDir, "src");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

const importRe = /^\s*import(?:\s+type)?[\s\S]*?from\s+["']([^"']+)["']/gm;

test("引擎包不 import Trellis 宿主代码", () => {
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(importRe)) {
      const spec = m[1];
      if (spec === "agent-trellis" || spec.startsWith("agent-trellis/")) {
        offenders.push(`${file}: ${spec}`);
        continue;
      }
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (relative(pkgDir, target).startsWith("..")) {
          offenders.push(`${file}: 逃逸包根的相对 import "${spec}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
