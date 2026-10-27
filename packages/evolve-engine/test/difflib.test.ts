// 任务 4.2 验证(部分):difflib 移植与 Python 标准库 difflib 逐字节一致。
// fixture 由 scripts/gen-diff-fixtures.py 用 Python stdlib 生成,test/fixtures/diffs/。
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { splitKeepEnds, unifiedDiff } from "../src/difflib.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "diffs");

interface CaseMeta {
  case: string;
  fromfile: string;
  tofile: string;
}

test("difflib: 与 Python difflib.unified_diff 输出逐字节一致(manifest 全量)", async () => {
  const manifest = JSON.parse(
    await readFile(join(FIXTURES, "manifest.json"), "utf8"),
  ) as CaseMeta[];
  assert.ok(manifest.length >= 12, "fixture 用例数");
  for (const { case: name, fromfile, tofile } of manifest) {
    const dir = join(FIXTURES, name);
    const a = await readFile(join(dir, "a.txt"), "utf8");
    const b = await readFile(join(dir, "b.txt"), "utf8");
    const expected = await readFile(join(dir, "expected.diff"), "utf8");
    const got = unifiedDiff(splitKeepEnds(a), splitKeepEnds(b), fromfile, tofile).join("");
    assert.equal(got, expected, `用例 ${name}`);
  }
});

test("difflib: identical 输入零输出(无 header)—— golden 空 harness.diff 语义", () => {
  const lines = splitKeepEnds("alpha\nbeta\n");
  assert.deepEqual(unifiedDiff(lines, lines, "current/x", "label/x"), []);
});

test("difflib: 空区间格式 N,M、单行区间格式 N(Python _format_range_unified)", () => {
  // 单行文件改动:@@ -1 +1 @@(length==1 → 只给行号)。
  const got1 = unifiedDiff(splitKeepEnds("a\n"), splitKeepEnds("b\n"), "f", "t").join("");
  assert.ok(got1.includes("@@ -1 +1 @@\n"), "单行区间");
  // 纯插入于文件首:length==0 的 from 区间 → 0,0。
  const got2 = unifiedDiff([], splitKeepEnds("x\n"), "f", "t").join("");
  assert.ok(got2.includes("@@ -0,0 +1 @@\n"), "空 from 区间");
  // 纯删除至空。
  const got3 = unifiedDiff(splitKeepEnds("x\n"), [], "f", "t").join("");
  assert.ok(got3.includes("@@ -1 +0,0 @@\n"), "空 to 区间");
});

test("difflib: splitKeepEnds 覆盖 Python splitlines 边界(含 \\r\\n 合并与 \\x0b)", () => {
  assert.deepEqual(splitKeepEnds(""), []);
  assert.deepEqual(splitKeepEnds("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitKeepEnds("a\r\nb"), ["a\r\n", "b"]);
  assert.deepEqual(splitKeepEnds("a\rb"), ["a\r", "b"]);
  assert.deepEqual(splitKeepEnds("a\x0bb"), ["a\x0b", "b"]);
  assert.deepEqual(splitKeepEnds("a\u2028b"), ["a\u2028", "b"]);
});

test("difflib: 目录遍历 fixture 目录包含全部 12 个用例", async () => {
  const names = (await readdir(FIXTURES, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(names, [
    "append-at-end",
    "autojunk",
    "content-to-empty",
    "delete-only",
    "empty-to-content",
    "identical",
    "insert-only",
    "middle-hunk",
    "multi-hunk",
    "no-trailing-newline",
    "one-line-change",
    "vtab-split",
  ]);
});
