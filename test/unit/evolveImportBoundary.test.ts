/**
 * 消费者 import 边界测试(trellis-evolve 任务 10.3)。
 *
 * `src/evolve/` 对 Trellis 代码的依赖只允许两条边:引擎包
 * `@trellis/evolve-engine` 与托管窄门面 `src/host/*`。`src/evolve/` 内部
 * 相对引用当然允许;node 内置与显式登记的第三方工具包(yaml)不属于
 * 宿主内部层。与 hostingIndependence(托管不依赖消费者)合成双向隔离。
 *
 * 验证含反例:临时假树里引入一条越界 import(如 `../lib/...`)会被判定
 * 器报出——即真实引入越界 import 时本测试失败。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const evolveRoot = join(repoRoot, "src", "evolve");
const hostRoot = join(repoRoot, "src", "host");

/** 第三方工具包显式清单:treeToCanonical 构造 YAML 内容时用的序列化库,
 * 是工具依赖、不是宿主内部层。新增第三方必须在此登记,让边界变化可见。 */
const ALLOWED_THIRD_PARTY = new Set(["yaml"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) yield* walk(path);
    else if (name.name.endsWith(".ts")) yield path;
  }
}

/** 与 hostingIndependence 同源的手法,外加跨行 `from` 支持(`[^;]*?`
 * 到语句分号为止),覆盖 `import {\n ...\n} from "..."` 形态。 */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|[;\n])(?:import|export)\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/g)) {
    found.push(match[1]!);
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(match[1]!);
  return found;
}

function isUnder(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** 判定单个说明符:ok = 允许边;violation = 越界。 */
function classify(spec: string, file: string, roots: { evolve: string; host: string }): "ok" | "violation" {
  if (spec.startsWith("node:")) return "ok";
  if (spec === "@trellis/evolve-engine" || spec.startsWith("@trellis/evolve-engine/")) return "ok";
  if (spec.startsWith(".")) {
    const target = resolve(dirname(file), spec);
    return isUnder(target, roots.host) || isUnder(target, roots.evolve) ? "ok" : "violation";
  }
  return ALLOWED_THIRD_PARTY.has(spec) ? "ok" : "violation";
}

function collectViolations(evolveDir: string, hostDir: string): string[] {
  const roots = { evolve: evolveDir, host: hostDir };
  const out: string[] = [];
  for (const file of walk(evolveDir)) {
    for (const spec of specifiersOf(file)) {
      if (classify(spec, file, roots) === "violation") out.push(`${file} imports ${spec}`);
    }
  }
  return out;
}

test("src/evolve 的 import 只指向引擎包、src/host、内部与登记的第三方", () => {
  assert.deepEqual(collectViolations(evolveRoot, hostRoot), []);
});

test("反例:引入一条越界 import 即被判出(多行 from 同样有效)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "trellis-evolve-boundary-"));
  try {
    const fakeEvolve = join(scratch, "src", "evolve");
    const fakeHost = join(scratch, "src", "host");
    mkdirSync(fakeEvolve, { recursive: true });
    mkdirSync(fakeHost, { recursive: true });
    mkdirSync(join(scratch, "src", "lib"), { recursive: true });

    // 合法边:引擎包 / src/host / 内部 / node 内置 / 登记第三方。
    writeFileSync(
      join(fakeEvolve, "ok.ts"),
      [
        'import { createHash } from "node:crypto";',
        'import { parse } from "yaml";',
        'import { makeSurfaceSpec } from "@trellis/evolve-engine";',
        'import { createStaging, readSurface } from "../host/index.js";',
        'import { TRELLIS_SURFACE } from "./surface.js";',
        "void createHash; void parse; void makeSurfaceSpec; void createStaging; void readSurface; void TRELLIS_SURFACE;",
        "",
      ].join("\n"),
    );
    // 越界边:宿主其他层(静态 + 多行 from + 动态 import 三种形态)。
    writeFileSync(
      join(fakeEvolve, "bad.ts"),
      [
        'import { workspaceRootFrom } from "../lib/workspace.js";',
        "import {",
        "  collectDoctorReport,",
        '} from "../commands/doctor.js";',
        'const lazy = () => import("../core/canonical.js");',
        "void workspaceRootFrom; void collectDoctorReport; void lazy;",
        "",
      ].join("\n"),
    );

    const violations = collectViolations(fakeEvolve, fakeHost);
    assert.deepEqual(violations, [
      `${join(fakeEvolve, "bad.ts")} imports ../lib/workspace.js`,
      `${join(fakeEvolve, "bad.ts")} imports ../commands/doctor.js`,
      `${join(fakeEvolve, "bad.ts")} imports ../core/canonical.js`,
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
