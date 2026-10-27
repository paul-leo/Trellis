// 任务 6.1 验证:report 移植——summaryKey、Summary.line 格式、summarise 分组、
// render 的噪底注与四类 WARNING 文案(逐字)。
// report 是纯转写:无 I/O、无通道,直接构造 Scored 行断言输出字符串。
import assert from "node:assert/strict";
import test from "node:test";

import { Scored } from "../src/judge.js";
import { pyRound } from "../src/pyutil.js";
import { Summary, render, summarise, summaryKey } from "../src/report.js";

function row(input: {
  task_id: string;
  mode: string;
  k: number;
  label: string;
  chosen_is_base?: boolean;
  n_passed?: number | null;
  n_criteria?: number | null;
  all_pass?: boolean;
  raw?: Record<string, unknown>;
}): Scored {
  const s = new Scored({
    task_id: input.task_id,
    mode: input.mode,
    k: input.k,
    label: input.label,
    run_id: `rid/${input.label}`,
    chosen_is_base: input.chosen_is_base ?? false,
  });
  s.n_passed = input.n_passed ?? null;
  s.n_criteria = input.n_criteria ?? null;
  s.all_pass = input.all_pass ?? false;
  s.raw = input.raw ?? {};
  return s;
}

test("summaryKey:mode|k 编码(单射)", () => {
  assert.equal(summaryKey("agg", 2), "agg|2");
  assert.equal(summaryKey("seq", 1), "seq|1");
});

test("Summary.name:MODE_NAMES 映射,未知 mode 原样透传", () => {
  assert.equal(new Summary("agg", 3).name, "parallel k=3");
  assert.equal(new Summary("seq", 1).name, "sequential k=1");
  assert.equal(new Summary("bogus", 2).name, "bogus k=2");
});

test("Summary.line:n=0 无分级;非 lab 走 score;lab 走 partial|pass", () => {
  const empty = new Summary("agg", 2);
  assert.equal(empty.line(), "  parallel k=2: no graded task");

  const s = new Summary("agg", 2);
  s.n = 4;
  s.score = 75;
  s.chose_final = 2;
  s.chose_candidate = 1;
  s.kept_base = 1;
  assert.equal(
    s.line(),
    "  parallel k=2: n=  4 | score  75.00% | picked output: final 2 / candidate 1 / base 1",
  );

  s.fell_back = 1;
  s.n_ungraded = 2;
  assert.equal(
    s.line(),
    "  parallel k=2: n=  4 | score  75.00% | picked output: final 2 / candidate 1 / base 1" +
      " | fell back 1 | ungraded 2",
  );

  const lab = new Summary("seq", 1);
  lab.n = 4;
  lab.score = 50;
  lab.all_pass = 25;
  assert.equal(
    lab.line("lab"),
    "  sequential k=1: n=  4 | partial  50.00% | pass  25.0% | picked output: final 0 / candidate 0 / base 0",
  );
});

test("summarise:按 (mode,k) 分组;ungraded 计数但不进分母;_kind 分类 base/final/candidate", () => {
  const rows = [
    // agg k=2:两个 final 选中、一个 candidate、一个 base;其中一个 ungraded
    row({ task_id: "t1", mode: "agg", k: 2, label: "agg1", n_passed: 2, n_criteria: 2, all_pass: true, raw: { metric: "points" } }),
    row({ task_id: "t2", mode: "agg", k: 2, label: "agg2", n_passed: 1, n_criteria: 2, all_pass: false, raw: { metric: "points" } }),
    row({ task_id: "t3", mode: "agg", k: 2, label: "inv1", n_passed: 2, n_criteria: 2, all_pass: true, raw: { metric: "points" } }),
    row({ task_id: "t4", mode: "agg", k: 2, label: "base1", chosen_is_base: true, n_passed: 0, n_criteria: 2, all_pass: false, raw: { metric: "points" } }),
    row({ task_id: "t5", mode: "agg", k: 2, label: "agg1", n_passed: null, n_criteria: null }), // ungraded
    // seq k=1:c1 是 final;base 选中
    row({ task_id: "t1", mode: "seq", k: 1, label: "c1", n_passed: 1, n_criteria: 1, all_pass: true }),
    row({ task_id: "t2", mode: "seq", k: 1, label: "base1", chosen_is_base: true, n_passed: 1, n_criteria: 1, all_pass: true }),
  ];
  const out = summarise(rows, {
    fell_back: { "agg|2": 3 },
    usd: { "agg|2": 1.234, "seq|1": 0.005 },
  });
  assert.equal(out.length, 2);
  // 排序:mode 字典序 → agg 在 seq 前
  assert.equal(out[0]?.mode, "agg");
  assert.equal(out[1]?.mode, "seq");

  const agg = out[0] as Summary;
  assert.equal(agg.n, 4);
  assert.equal(agg.n_ungraded, 1);
  assert.equal(agg.chose_final, 2); // agg1, agg2
  assert.equal(agg.chose_candidate, 1); // inv1
  assert.equal(agg.kept_base, 1); // base1
  assert.equal(agg.fell_back, 3);
  // mean(frac) = (1 + 0.5 + 1 + 0) / 4 = 0.625 → 62.5
  assert.equal(agg.score, 62.5);
  // all_pass 2/4 → 50
  assert.equal(agg.all_pass, 50);
  assert.equal(agg.usd, 1.23); // pyRound(1.234, 2) half-even → 1.23
  assert.deepEqual(agg.metrics, ["points"]);

  const seq = out[1] as Summary;
  assert.equal(seq.n, 2);
  assert.equal(seq.n_ungraded, 0);
  assert.equal(seq.chose_final, 1); // c1
  assert.equal(seq.kept_base, 1); // base1
  assert.equal(seq.score, 100);
  assert.equal(seq.all_pass, 100);
  assert.equal(seq.usd, pyRound(0.005, 2)); // 与 report 的 pyRound 口径一致(0.005 有二进制近似)
  assert.deepEqual(seq.metrics, []);
});

test("summarise:分数为均值百分比;seq 的 c1..ck 是 final,inv/dom 是 candidate", () => {
  const rows = [
    row({ task_id: "t1", mode: "seq", k: 2, label: "c2", n_passed: 3, n_criteria: 4 }),
    row({ task_id: "t2", mode: "seq", k: 2, label: "inv2", n_passed: 1, n_criteria: 4 }),
    row({ task_id: "t3", mode: "seq", k: 2, label: "dom1", n_passed: 1, n_criteria: 4 }),
    row({ task_id: "t4", mode: "seq", k: 2, label: "base2", chosen_is_base: true, n_passed: 4, n_criteria: 4 }),
  ];
  const s = summarise(rows)[0] as Summary;
  assert.equal(s.mode, "seq");
  assert.equal(s.chose_final, 1); // c2
  assert.equal(s.chose_candidate, 2); // inv2, dom1
  assert.equal(s.kept_base, 1); // base2(标签 base* 恒为 base,c2 不在 base 判定)
  // mean = (0.75 + 0.25 + 0.25 + 1) / 4 = 0.5625 → 56.25
  assert.equal(s.score, 56.25);
});

test("render:标题下划线 max(40, 码点长度);按 (k, mode) 排序", () => {
  const s1 = new Summary("agg", 2);
  s1.n = 1;
  s1.score = 100;
  s1.chose_final = 1;
  const s2 = new Summary("seq", 1);
  s2.n = 1;
  s2.score = 100;
  s2.chose_final = 1;
  const text = render([s1, s2], { title: "短" });
  const lines = text.split("\n");
  assert.equal(lines[0], "短");
  assert.equal(lines[1], "=".repeat(40)); // 1 码点 < 40
  // k=1 的 seq 行在 k=2 的 agg 行之前
  assert.ok(lines[2]?.includes("sequential k=1"));
  assert.ok(lines[3]?.includes("parallel k=2"));

  const long = "x".repeat(50);
  const text2 = render([s1], { title: long });
  assert.equal(text2.split("\n")[1], "=".repeat(50));
});

test("render:k=1 双模式分数齐 → 噪底注(gap 两位小数)", () => {
  const agg = new Summary("agg", 1);
  agg.n = 2;
  agg.score = 80;
  agg.chose_final = 2;
  const seq = new Summary("seq", 1);
  seq.n = 2;
  seq.score = 65.5;
  seq.chose_final = 2;
  const text = render([agg, seq]);
  assert.ok(text.includes("NOTE  at k=1 the parallel and sequential modes are the same procedure"));
  assert.ok(text.includes("The 14.50 pt between them is therefore a NOISE FLOOR"));
  // 只有 k=1 一侧有分 → 无噪底注
  const only = render([agg]);
  assert.ok(!only.includes("NOISE FLOOR"));
});

test("render:chose_final ≤ 0.25n / kept_base ≥ 0.8n / fell_back / mixed-units 四类 WARNING 文案逐字", () => {
  const s = new Summary("agg", 2);
  s.n = 8;
  s.score = 50;
  s.chose_final = 2; // 2 ≤ 0.25*8 → 触发
  s.kept_base = 7; // 7 ≥ 0.8*8=6.4 → 触发
  s.fell_back = 3;
  s.metrics = ["criteria_count", "weighted_points"];
  const text = render([s]);
  assert.ok(
    text.includes(
      "  WARNING  parallel k=2: the mode's own final was chosen on only " +
        "2/8 tasks. These records include outputs outside the published pool of 2 composed finals.",
    ),
  );
  assert.ok(
    text.includes(
      "  WARNING  parallel k=2: selection chose a reference output on " +
        "7/8 tasks, outside the published pool of composed outputs.",
    ),
  );
  assert.ok(
    text.includes(
      "  WARNING  parallel k=2: 3 stage(s) fell back to the " +
        "inherited harness. Inspect the stage errors when interpreting these results.",
    ),
  );
  assert.ok(
    text.includes(
      "  WARNING  parallel k=2: graded rows carry MIXED scoring units " +
        "(criteria_count, weighted_points). The score averages weighted points with " +
        "unweighted criteria counts (about 20 pt apart on JobBench); re-judge " +
        "the fallback rows before comparing this line with any published " +
        "number.",
    ),
  );

  // 阈值边界:chose_final = 2.0/8 = 0.25 恰在阈值上仍触发;kept_base = 6 < 6.4 不触发
  const s2 = new Summary("seq", 1);
  s2.n = 8;
  s2.score = 50;
  s2.chose_final = 2;
  s2.kept_base = 5;
  const text2 = render([s2]);
  assert.ok(text2.includes("the mode's own final was chosen on only 2/8 tasks"));
  assert.ok(!text2.includes("selection chose a reference output"));
  assert.ok(!text2.includes("fell back to the"));
  assert.ok(!text2.includes("MIXED scoring units"));
});
