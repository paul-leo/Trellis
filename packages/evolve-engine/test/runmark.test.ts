// 任务 3.1 验证:runmark 的 golden 对照与标记生命周期。
// 指纹期望值由 Python 原版 harness2(commit 1cfe254)在同一 golden 输入上计算后嵌入。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MARK,
  VERSION,
  fingerprint,
  is_complete,
  mark_complete,
  read_mark,
  why_not,
} from "../src/runmark.js";

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "golden",
  "demo-k2-both",
);
const AGG1 = join(GOLDEN, "runs", "demo-oc-agg2", "ledger-1", "harnesses", "agg1");
const AGG2 = join(GOLDEN, "runs", "demo-oc-agg2", "ledger-1", "harnesses", "agg2");

test("golden: fingerprint 与原版逐值一致(base / agg1 / agg2 / null / absent)", async () => {
  assert.equal(await fingerprint(join(GOLDEN, "base")), "d6ee8e8b0edbc3f9");
  assert.equal(await fingerprint(AGG1), "851f1352f3589138");
  assert.equal(await fingerprint(AGG2), "851f1352f3589138");
  assert.equal(await fingerprint(null), "base");
  assert.equal(await fingerprint(join(GOLDEN, "no-such-dir")), "absent");
});

test("mark_complete → read_mark → is_complete 全生命周期", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "runmark-test-"));
  try {
    const run = join(tmp, "run1");
    await mark_complete(run, { run_id: "agg1", harness_dir: AGG1 });
    const m = await read_mark(run);
    assert.ok(m);
    assert.equal(m.version, VERSION);
    assert.equal(m.run_id, "agg1");
    assert.equal(m.harness, "851f1352f3589138");
    assert.equal(typeof m.at, "number");

    assert.equal(await is_complete(run, { harness_dir: AGG1 }), true);
    // agg2 与 agg1 内容全同 → 指纹相同 → 同样可复用
    assert.equal(await is_complete(run, { harness_dir: AGG2 }), true);
    // 换了 harness(base)→ 指纹不符
    assert.equal(await is_complete(run, { harness_dir: join(GOLDEN, "base") }), false);
    // match_harness=false → 只看标记存在与版本
    assert.equal(
      await is_complete(run, { harness_dir: join(GOLDEN, "base"), match_harness: false }),
      true,
    );
    assert.equal(await why_not(run, { harness_dir: AGG1 }), "reusable");
    assert.equal(
      await why_not(run, { harness_dir: join(GOLDEN, "base") }),
      `harness fingerprint 851f1352f3589138 != d6ee8e8b0edbc3f9 -- produced by a different configuration`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("why_not 的另外两条文案逐字一致", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "runmark-test-"));
  try {
    const run = join(tmp, "never");
    assert.equal(
      await why_not(run),
      `no ${MARK} -- never finished, or finished before completion was recorded`,
    );
    // 版本不符:手写一个 version=0 的标记
    await writeFile(join(tmp, MARK), JSON.stringify({ version: 0, harness: "x" }));
    assert.equal(await why_not(tmp), `marker version 0 != ${VERSION}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("fingerprint 忽略 __pycache__/.pyc/.DS_Store 与标记文件本身", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "runmark-test-"));
  try {
    await writeFile(join(tmp, "a.txt"), "hello");
    const before = await fingerprint(tmp);
    await writeFile(join(tmp, ".DS_Store"), "junk");
    await writeFile(join(tmp, MARK), "{}");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmp, "__pycache__"));
    await writeFile(join(tmp, "__pycache__", "x.pyc"), "junk");
    assert.equal(await fingerprint(tmp), before);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
