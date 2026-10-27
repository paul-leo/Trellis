// 任务 3.1 验证:ledger 的 golden 对照(预算恒等式与 to_dict 键序)。
// golden summary.json 的 ledger 块即 Python 原版 Ledger.to_dict() 的输出。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BudgetError,
  Ledger,
  expected_rollouts,
  expected_sessions,
} from "../src/ledger.js";

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "golden",
  "demo-k2-both",
);

test("expected_rollouts / expected_sessions:R=4k、P=3k", () => {
  assert.equal(expected_rollouts(2), 8);
  assert.equal(expected_sessions(2), 6);
  assert.equal(expected_rollouts(0), 0);
});

test("golden: 重放 agg 模式记账,to_dict 与 summary.json 的 ledger 块逐键一致", async () => {
  const summary = JSON.parse(
    await readFile(
      join(GOLDEN, "runs", "demo-oc-agg2", "ledger-1", "summary.json"),
      "utf8",
    ),
  );
  const want = summary.modes.agg.ledger;

  const ledger = new Ledger("agg", "ledger-1", 2);
  for (const label of ["base1", "base2", "inv1", "dom1", "inv2", "dom2", "agg1", "agg2"]) {
    ledger.rollout(label);
  }
  for (const label of ["inv1", "dom1", "inv2", "dom2", "agg1", "agg2"]) {
    ledger.session(label);
  }
  ledger.assert_identity(); // 不抛
  assert.deepEqual(ledger.to_dict(), want);
  // 键序与 Python dict 字面量一致
  assert.deepEqual(Object.keys(ledger.to_dict()), Object.keys(want));
});

test("assert_identity:重复标签先于计数被报出,文案含 Python list repr", () => {
  // 计数恰好 R=4、P=3,但 rollout 里有一对重复标签(挤掉了一个真实臂)
  const tricky = new Ledger("agg", "t1", 1);
  for (const label of ["base1", "inv1", "dom1", "dom1"]) tricky.rollout(label);
  for (const label of ["inv1", "dom1", "agg1"]) tricky.session(label);
  const err = captureBudgetError(() => tricky.assert_identity());
  assert.match(err.message, /DUPLICATE labels: \['dom1'\] -- a repeated label/);
  assert.match(err.message, /^agg-1 t1: R=4 \(want 4\), P=3 \(want 3\)/);
});

function captureBudgetError(fn: () => void): BudgetError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BudgetError, `应为 BudgetError,实为 ${e}`);
    return e;
  }
  assert.fail("应抛出 BudgetError");
}

test("assert_identity:计数不符时的完整文案", () => {
  const ledger = new Ledger("seq", "t9", 2);
  ledger.rollout("base1");
  const err = captureBudgetError(() => ledger.assert_identity());
  assert.equal(
    err.message,
    "seq-2 t9: R=1 (want 8), P=0 (want 6)\n" +
      "  rollouts: base1\n" +
      "  sessions: (none)",
  );
});

test("usd 记账:round(x, 6) 为 half-even,分类汇总正确", () => {
  const ledger = new Ledger("agg", "t", 1);
  ledger.rollout("base1", 0.1);
  ledger.rollout("inv1", 0.2, { cached: true });
  ledger.session("inv1", 0.05, { attempts: 2 });
  ledger.session("dom1", 0.05);
  assert.equal(ledger.usd, 0.4);
  assert.equal(ledger.rollout_usd, 0.3);
  assert.equal(ledger.session_usd, 0.1);
  assert.equal(
    ledger.to_dict().session_attempts,
    3,
  );
  // half-even:0.125 的 6 位舍入不触发中间值,改用 0.0000005 验证
  const l2 = new Ledger("agg", "t", 1);
  l2.rollout("a", 0.0000005);
  assert.equal(l2.usd, 0); // round(0.0000005, 6) = 0(half-even 到 0)
  const l3 = new Ledger("agg", "t", 1);
  l3.rollout("a", 0.0000015);
  assert.equal(l3.usd, 0.000002); // round(0.0000015, 6) = 2e-6(half-even 到偶数)
});
