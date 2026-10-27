// 任务 3.2 验证:judge 的 None 语义——评分失败 = null,不计入分母、永不记 0。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Scored,
  judgeOne,
  judgeSelections,
  write,
  type JudgeAdapter,
} from "../src/judge.js";

const okAdapter: JudgeAdapter = {
  score: async () => ({ n_passed: 2, n_criteria: 3, extra: "kept" }),
};

test("judgeOne 正常路径:frac = 2/3,raw 保留全部字段", async () => {
  const s = await judgeOne(okAdapter, "t1", "agg", 2, "agg1", "r1", "/tmp/run");
  assert.equal(s.graded, true);
  assert.equal(s.frac, 2 / 3);
  assert.equal(s.all_pass, false);
  assert.deepEqual(s.raw, { n_passed: 2, n_criteria: 3, extra: "kept" });
  assert.equal(s.error, "");
});

test("judgeOne 失败 = null,不是 0:score 抛错", async () => {
  const bad: JudgeAdapter = {
    score: async () => {
      throw new TypeError("boom");
    },
  };
  const s = await judgeOne(bad, "t1", "agg", 2, "agg1", "r1", "/tmp/run");
  assert.equal(s.n_passed, null);
  assert.equal(s.n_criteria, null);
  assert.equal(s.graded, false);
  assert.equal(s.frac, null); // 不计入分母的关键:frac 是 null 而非 0
  assert.equal(s.error, "TypeError: boom");
});

test("judgeOne:score 返回空 = 'judge returned nothing'", async () => {
  const empty: JudgeAdapter = { score: async () => null };
  const s = await judgeOne(empty, "t1", "agg", 2, "agg1", "r1", "/tmp/run");
  assert.equal(s.graded, false);
  assert.equal(s.frac, null);
  assert.equal(s.error, "judge returned nothing");
});

test("judgeOne:all_pass 缺省推导为 graded && n_passed === n_criteria", async () => {
  const full: JudgeAdapter = { score: async () => ({ n_passed: 3, n_criteria: 3 }) };
  const s = await judgeOne(full, "t1", "agg", 2, "agg1", "r1", "/tmp/run");
  assert.equal(s.all_pass, true);
  // n_criteria = 0 → graded 为 false → all_pass 缺省也是 false(不是 0/0 = true)
  const zero: JudgeAdapter = { score: async () => ({ n_passed: 0, n_criteria: 0 }) };
  const z = await judgeOne(zero, "t1", "agg", 2, "agg1", "r1", "/tmp/run");
  assert.equal(z.graded, false);
  assert.equal(z.all_pass, false);
});

test("judgeSelections:未完成的 selection 直接记 error,不进评分", async () => {
  let calls = 0;
  const counting: JudgeAdapter = {
    score: async () => {
      calls++;
      return { n_passed: 1, n_criteria: 1 };
    },
  };
  const rows = await judgeSelections(counting, [
    { ok: false, task_id: "t0", mode: "agg", k: 1 }, // 未完成
    { ok: true, chosen_label: "", task_id: "t0", k: 1 }, // 无 label
    { ok: true, chosen_label: "agg1", task_id: "t1", mode: "agg", k: 1, chosen_run_id: "r1", chosen_run_dir: "/tmp/r1" },
    { ok: true, chosen_label: "c1", task_id: "t2", arm: "seq", k: 1, chosen_run_id: "r2", chosen_run_dir: "/tmp/r2" }, // legacy "arm" 键
  ]);
  assert.equal(calls, 2); // 只有两条真正评分
  assert.equal(rows[0].error, "selection did not complete successfully");
  assert.equal(rows[0].graded, false);
  assert.equal(rows[1].error, "selection did not complete successfully");
  assert.equal(rows[2].frac, 1);
  assert.equal(rows[2].mode, "agg");
  assert.equal(rows[3].mode, "seq"); // legacy 键被读出
});

test("judgeSelections:单个评分异常只落该条目的 error,不拖垮整批", async () => {
  const flaky: JudgeAdapter = {
    score: async (dir) => {
      if (dir.includes("bad")) throw new Error("nope");
      return { n_passed: 1, n_criteria: 2 };
    },
  };
  const mk = (id: string) => ({
    ok: true,
    task_id: id,
    mode: "agg",
    k: 1,
    chosen_label: "agg1",
    chosen_run_id: "r",
    chosen_run_dir: `/tmp/${id}`,
  });
  const rows = await judgeSelections(flaky, [mk("good1"), mk("bad"), mk("good2")]);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.graded).length, 2);
  const bad = rows.find((r) => r.task_id === "bad");
  assert.equal(bad?.error, "Error: nope");
  assert.equal(bad?.frac, null);
});

test("write:字段序 = dataclass 字段 + frac + graded,null 原样落盘", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "judge-test-"));
  try {
    const good = await judgeOne(okAdapter, "t1", "agg", 2, "agg1", "r1", "/tmp/run");
    const failed = new Scored({
      task_id: "t2",
      mode: "seq",
      k: 2,
      label: "c1",
      run_id: "r9",
      chosen_is_base: true,
    });
    failed.error = "judge returned nothing";
    const path = await write([good, failed], join(tmp, "out", "judge.json"));
    const rows = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(Object.keys(rows[0]), [
      "task_id", "mode", "k", "label", "run_id", "chosen_is_base",
      "n_passed", "n_criteria", "all_pass", "raw", "error", "frac", "graded",
    ]);
    assert.equal(rows[1].n_passed, null);
    assert.equal(rows[1].frac, null);
    assert.equal(rows[1].graded, false);
    assert.equal(rows[1].chosen_is_base, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
