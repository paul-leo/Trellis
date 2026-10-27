import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 任务 8.7:"托管不依赖消费者"的构建级测试。
//
// 对应 spec 场景:把自我进化子系统的源码整体移出构建 → 托管层的构建与
// 测试结果不变,且无任何对被移除代码的引用。
//
// 以构建图断言代替昂贵的物理移出重建(物理移出等价于这三条同时成立):
//   1. 托管层源码(src/**)与测试套件(test/**)中没有任何指向消费者的
//      import(包名 @trellis/evolve-engine、src/evolve、packages/ 下的
//      任何路径)——移除消费者后没有任何悬空引用;
//   2. src/** 的相对 import 全部解析回 src/ 内部——托管层编译单元自包含,
//      根 tsconfig 的 include 只覆盖 src,引擎包有自己独立的构建与测试;
//   3. 根 package.json 的依赖面不含引擎包——npm 层面托管产物不拉入消费者。

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const srcRoot = join(repoRoot, "src");
const testRoot = join(repoRoot, "test");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) yield* walk(path);
    else if (name.name.endsWith(".ts") || name.name.endsWith(".tsx")) yield path;
  }
}

/** Every module specifier a file references: static import/export-from
 * and dynamic import(). */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  const found: string[] = [];
  for (const match of text.matchAll(/\b(?:import|export)\b[^"']*?\bfrom\s+["']([^"']+)["']/g)) found.push(match[1]!);
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  for (const match of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(match[1]!);
  return found;
}

const CONSUMER_MARKERS = [/evolve-engine/, /@trellis\/evolve/, /packages[\\/]evolve/, /[\\/]evolve[\\/]/, /[\\/]evolve\.js$/];

/** The consumer's own files — removed together when the self-evolution
 * subsystem moves out of the build, and the ONLY places allowed to
 * reference it. Everything outside this list is the hosting layer. */
const CONSUMER_OWNED = [
  /^src\/evolve\//,
  // 12.4 管理面命令(`trellis evolve …`)是消费者功能:物理移出时命令
  // 模块与 CLI 挂载一并删除。放 commands/ 下只为 CLI 命令族就近组织。
  /^src\/commands\/evolve\.ts$/,
  /^test\/unit\/evolve[\\/]/,
  /^test\/unit\/hostingIndependence\.test\.ts$/,
  // 10.3 的消费者边界元测试:反例 fixture 的文本里合法地出现引擎包名,
  // 与本文件自身同理,不算托管层的消费者引用。
  /^test\/unit\/evolveImportBoundary\.test\.ts$/,
];

/** Explicitly registered consumer wiring points inside the hosting layer.
 * 8.7 场景"把进化各部分移出构建"包含这些接线行:物理移出消费者时,
 * 本表每一行对应的 import 与调用分支必须一并删除。测试只放行登记过的
 * (file, specifier) 对——零未登记引用,登记本身即移出清单,可审计。 */
const CONSUMER_WIRING: ReadonlyArray<{ file: string; spec: string }> = [
  // cli 分发器挂 `trellis evolve` 子命令(12.4 管理面)。
  { file: "src/cli.ts", spec: "./commands/evolve.js" },
];

function isConsumerOwned(relPath: string): boolean {
  return CONSUMER_OWNED.some((pattern) => pattern.test(relPath));
}

function isRegisteredWiring(relPath: string, spec: string): boolean {
  return CONSUMER_WIRING.some((w) => w.file === relPath && w.spec === spec);
}

test("托管层源码与测试不 import 消费者(自我进化引擎)", () => {
  const offenders: string[] = [];
  const seenWiring = new Set<string>();
  for (const root of [srcRoot, testRoot]) {
    for (const file of walk(root)) {
      const rel = file.slice(repoRoot.length + 1);
      if (isConsumerOwned(rel)) continue;
      for (const spec of specifiersOf(file)) {
        if (!CONSUMER_MARKERS.some((marker) => marker.test(spec))) continue;
        if (isRegisteredWiring(rel, spec)) {
          seenWiring.add(`${rel} ${spec}`);
          continue;
        }
        offenders.push(`${rel} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  // 登记完备性:CONSUMER_WIRING 的每条边必须在源码真实存在,
  // 防止登记腐烂成死豁免(移出清单与源码保持同真)。
  const stale = CONSUMER_WIRING.map((w) => `${w.file} ${w.spec}`).filter((k) => !seenWiring.has(k));
  assert.deepEqual(stale, [], "CONSUMER_WIRING 登记了源码中已不存在的接线");
});

test("托管层编译单元自包含:src 的相对 import 全部留在 src 内,tsconfig 只编 src", () => {
  const escapees: string[] = [];
  for (const file of walk(srcRoot)) {
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith(".")) continue;
      const resolved = resolve(dirname(file), spec);
      if (!resolved.startsWith(srcRoot + "/") && resolved !== srcRoot) {
        escapees.push(`${file.slice(repoRoot.length + 1)} escapes src via ${spec}`);
      }
    }
  }
  assert.deepEqual(escapees, []);

  const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf-8")) as { include?: string[] };
  assert.deepEqual(tsconfig.include, ["src"]);
});

test("根 package.json 依赖面:发布面不含引擎包,devDependencies 至多声明消费者本身", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  // dependencies/peerDependencies 随 npm 发布:永不含消费者。
  for (const section of ["dependencies", "peerDependencies"] as const) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      assert.ok(!CONSUMER_MARKERS.some((marker) => marker.test(name)), `${section} contains consumer package ${name}`);
    }
  }
  // devDependencies 不进发布产物;允许恰好一条消费者边(src/evolve →
  // @trellis/evolve-engine 的 workspace 链接),移除消费者时一并移除。
  const devConsumerDeps = Object.keys(pkg.devDependencies ?? {}).filter((name) =>
    CONSUMER_MARKERS.some((marker) => marker.test(name)),
  );
  assert.deepEqual(devConsumerDeps, ["@trellis/evolve-engine"]);
});
