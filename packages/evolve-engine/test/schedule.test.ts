// 任务 6.1 验证:schedule 移植——命名空间/流序、summary 合并与 resume 校验链、
// 单任务/单域失败不拖垮整轮 sweep、golden E2E 对照。
// tasks.md 显式验证点(schedule 部分):
//   - golden 对照全绿:runDemo(k=2, both) 与 golden/demo-k2-both 的 demo.json、
//     summary.json×2 对照(路径归一 <RUN_ROOT>,键序与尾换行保留);
//   - 单会话失败不拖垮整轮 sweep:任务级异常记 exception 行继续;域级异常收口为
//     {domain, error} 行,聚合按 domain 序。
// 通道执行一律用桩(覆写 call),不 spawn 真实 CLI;仅 demo E2E 走 python3 本地
// 确定性脚本(summarize.py),不是模型通道。
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OPENCODE_SURFACE, runDemo } from "../src/demo.js";
import { Proposer, Reply } from "../src/proposer.js";
import * as runmark from "../src/runmark.js";
import * as schedule from "../src/schedule.js";
import {
  makeBenchPrompts,
  makeBenchSpec,
  makeChannelSpec,
  type BenchmarkAdapter,
  type SurfaceSpec,
} from "../src/spec.js";
import * as harness_tree from "../src/tree.js";
import type { Tree } from "../src/tree.js";

const GOLDEN_ROOT = fileURLToPath(new URL("../golden/demo-k2-both", import.meta.url));

const CHAN = makeChannelSpec({ kind: "claude_cli", model: "claude-x" });

/** 通道绝不能被走到的 Proposer:resume/失败路径不应触发任何 call。 */
class NoopProposer extends Proposer {
  constructor() {
    super(CHAN);
  }
  override async call(
    _mission: string,
    _context_dir: string | null,
    label: string,
  ): Promise<Reply> {
    throw new Error(`channel must not be reached, got call(${label})`);
  }
}

function makeAdapter(
  opts: {
    taskIds?: string[];
    domainOf?: (tid: string) => string;
    surface?: () => SurfaceSpec;
    delivered?: (run_dir: string) => Promise<boolean>;
    artifactsIntact?: (run_dir: string) => Promise<boolean> | boolean;
  } = {},
): BenchmarkAdapter {
  return {
    spec: makeBenchSpec({
      name: "swp",
      runs_root: "/unused",
      install_mode: "workspace_agents_md",
      prompts: makeBenchPrompts({ work: "Sum every signed amount in a ledger." }),
      channels: { proposer: CHAN, selector: CHAN },
    }),
    substrate: { name: "oc", surface: opts.surface ?? (() => OPENCODE_SURFACE) },
    tasks: async () => [...(opts.taskIds ?? ["t1"])],
    domain_of: opts.domainOf ?? (() => "accounting"),
    task_prompt: () => "Sum every signed amount in ledger.csv.",
    task_files: async () => null,
    execute: async (_tid, _hdir, run_id) => {
      const dir = join(await fs.mkdtemp(join(tmpdir(), "evolve-sched-exec-")), run_id.replaceAll("/", "_"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, "answer.txt"), `ok:${run_id}\n`, "utf8");
      await fs.writeFile(
        join(dir, "trajectory.md"),
        `[ACTION] run\n[OBSERVATION]\nok:${run_id}\n`,
        "utf8",
      );
      return dir;
    },
    delivered:
      opts.delivered ??
      (async (run_dir) => {
        try {
          return (await fs.stat(join(run_dir, "answer.txt"))).isFile();
        } catch {
          return false;
        }
      }),
    trajectory: async (run_dir) => fs.readFile(join(run_dir, "trajectory.md"), "utf8"),
    deliverable_files: async (run_dir) => ({
      "answer.txt": await fs.readFile(join(run_dir, "answer.txt"), "utf8"),
    }),
    deliverable_text: async (run_dir) => fs.readFile(join(run_dir, "answer.txt"), "utf8"),
    base_harness: async () => await fs.mkdtemp(join(tmpdir(), "evolve-sched-base-")),
    validate_tree: async () => undefined,
    score: async () => null,
    ...(opts.artifactsIntact ? { artifacts_intact: opts.artifactsIntact } : {}),
  };
}

/** 捕获 console.log,避免测试输出被 run_domain/_resume 的进度行污染。 */
async function withLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const value = await fn();
    return { value, logs };
  } finally {
    console.log = orig;
  }
}

const BASE_TREE: Tree = {
  "systemprompt.md": "Reconcile the ledger using python scripts/summarize.py.\n",
  "guardrails.md": "",
  "LongTermMEMORY.md": "",
  "tool_descriptions/tool_guidance.md": "",
  "scripts/summarize.py": "print('total')\n",
};

/** 写一个可通过 is_tree 的 harness 目录,返回其 fingerprint。 */
async function mkHarness(dir: string): Promise<string> {
  await harness_tree.write_tree(OPENCODE_SURFACE, BASE_TREE, dir, { stubs: false });
  return runmark.fingerprint(dir);
}

/**
 * 预置一份 status=ok 的缓存 summary(run_task 的 summary 落在 agg 命名空间目录),
 * 供 _resume 各路径使用。返回 work 目录(task_dir)。
 */
async function writeCachedSummary(
  runs_root: string,
  task_id: string,
  k: number,
  sel: Record<string, unknown>,
  opts: { status?: string; errors?: string[]; modeOk?: boolean } = {},
): Promise<string> {
  const n = new schedule.Namespace("swp", "oc", "agg", k, null, "");
  const work = n.task_dir(runs_root, task_id);
  await fs.mkdir(work, { recursive: true });
  const summary = {
    task_id,
    domain: "accounting",
    k,
    seed: null,
    status: opts.status ?? "ok",
    base: [],
    modes: { agg: { ok: opts.modeOk ?? true } },
    selections: { agg: sel },
    errors: opts.errors ?? [],
  };
  await fs.writeFile(join(work, "summary.json"), JSON.stringify(summary, null, 2));
  return work;
}

function cachedSel(input: {
  label?: string;
  run_dir: string;
  fingerprint?: string;
  evidence?: string;
}): Record<string, unknown> {
  return {
    task_id: "t1",
    mode: "agg",
    k: 1,
    chosen_id: "A",
    chosen_label: input.label ?? "c1",
    chosen_run_id: "swp-oc-agg1/t1/c1",
    chosen_is_base: false,
    why: "w",
    id_map: { A: input.label ?? "c1" },
    dropped: [],
    n_candidates: 1,
    ok: true,
    fallback: false,
    error: "",
    usd: 0,
    experience: {},
    trivial: false,
    evidence: input.evidence ?? "deliverable",
    chosen_run_dir: input.run_dir,
    chosen_tree_is_base: false,
    ...(input.fingerprint !== undefined ? { harness_fingerprint: input.fingerprint } : {}),
  };
}

// ---------- mode_token / validate_tag / ns / Namespace ----------

test("mode_token:别名与大小写;未知 mode 文案逐字", () => {
  assert.equal(schedule.mode_token("agg"), "agg");
  assert.equal(schedule.mode_token("seq"), "seq");
  assert.equal(schedule.mode_token("parallel"), "agg");
  assert.equal(schedule.mode_token("sequential"), "seq");
  assert.equal(schedule.mode_token("Parallel"), "agg");
  assert.equal(schedule.mode_token("  SEQ  "), "seq");
  assert.throws(
    () => schedule.mode_token("bogus"),
    (exc: unknown) => {
      assert.ok(exc instanceof Error);
      assert.equal(exc.constructor.name, "ValueError");
      assert.equal(
        exc.message,
        "unknown mode 'bogus'; expected parallel | sequential (or the " +
          "on-disk tokens ('agg', 'seq'))",
      );
      return true;
    },
  );
  // null → pyRepr(None)
  assert.throws(() => schedule.mode_token(null), /unknown mode None/);
});

test("validate_tag:空放行;非法字符与 seed 段文案逐字", () => {
  schedule.validate_tag("");
  schedule.validate_tag("exp1");
  schedule.validate_tag("a_b.c-d");
  schedule.validate_tag("0");
  schedule.validate_tag("s"); // 不是 s<digits>
  schedule.validate_tag("s3foo"); // ^s\d+(-|$) 不匹配
  schedule.validate_tag("ss3");
  assert.throws(
    () => schedule.validate_tag("-x"),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "tag '-x' must be [A-Za-z0-9_.-] with no leading '-' and " +
          "no '/': it becomes a path segment and a run-id segment",
      );
      return true;
    },
  );
  assert.throws(() => schedule.validate_tag("a/b"), /it becomes a path segment/);
  schedule.validate_tag(".x"); // 首字符类 [A-Za-z0-9_.] 含 '.',合法
  assert.throws(
    () => schedule.validate_tag("s3"),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "tag 's3' spells a seed segment; pass --seed instead so " +
          "seeded and tagged namespaces can never collide",
      );
      return true;
    },
  );
  assert.throws(() => schedule.validate_tag("s10-x"), /spells a seed segment/);
});

test("ns:命名空间拼装与校验文案", () => {
  assert.equal(schedule.ns("demo", "oc", "agg", 2), "demo-oc-agg2");
  assert.equal(schedule.ns("demo", "oc", "seq", 2, { seed: 7 }), "demo-oc-seq2-s7");
  assert.equal(schedule.ns("demo", "oc", "agg", 2, { tag: "exp" }), "demo-oc-agg2-exp");
  assert.equal(
    schedule.ns("demo", "oc", "agg", 2, { seed: 7, tag: "exp" }),
    "demo-oc-agg2-s7-exp",
  );
  assert.equal(schedule.ns("demo", "oc", "agg", 2.9), "demo-oc-agg2"); // k 截断
  assert.throws(
    () => schedule.ns("demo", "oc", "bogus", 2),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "unknown mode 'bogus'; the method has exactly two: ('agg', 'seq')",
      );
      return true;
    },
  );
  assert.throws(
    () => schedule.ns("demo", "", "agg", 2),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "namespace needs a substrate name ('oc' | 'cx'); an empty one would " +
          "let the two substrates' caches collide on every label",
      );
      return true;
    },
  );
  assert.throws(() => schedule.ns("demo", "oc", "agg", 2, { tag: "s4" }), /spells a seed segment/);
});

test("Namespace:toString/run_id/task_dir/glob", () => {
  const n = new schedule.Namespace("demo", "oc", "agg", 2, 7, "x");
  assert.equal(String(n), "demo-oc-agg2-s7-x");
  // run_id 不折叠斜杠(任务 id 原样进 run 标识)
  assert.equal(n.run_id("t/1", "base1"), "demo-oc-agg2-s7-x/t/1/base1");
  // task_dir 把任务 id 里的 '/' 折叠为 '__'
  assert.equal(n.task_dir("/root", "t/1"), join("/root", "demo-oc-agg2-s7-x", "t__1"));
  // glob 默认模式段是 '*',一次覆盖 agg/seq 双模式
  assert.deepEqual(schedule.Namespace.glob("demo", "oc", 2), ["demo-oc-*2", "demo-oc-*2-*"]);
  assert.deepEqual(schedule.Namespace.glob("demo", "oc", 2, { mode: "seq" }), [
    "demo-oc-seq2",
    "demo-oc-seq2-*",
  ]);
});

// ---------- stream_order ----------

test("stream_order:seed=null 走 reference 序,任务排序;缺域抛陈旧清单文案", () => {
  const by = { acc: ["a2", "a1"], fin: ["f1"] };
  const out = schedule.stream_order(by, null, ["fin", "acc", "ops"]);
  assert.deepEqual(out, [
    ["fin", "f1"],
    ["acc", "a1"],
    ["acc", "a2"],
  ]);
  assert.throws(
    () => schedule.stream_order(by, null, ["fin"]),
    (exc: unknown) => {
      assert.equal(exc.constructor.name, "ValueError");
      assert.equal(
        (exc as Error).message,
        "reference_domain_order does not cover domain(s) ['acc']; the frozen " +
          "order list is stale — regenerate it rather than letting an unlisted domain " +
          "land in an arbitrary position",
      );
      return true;
    },
  );
});

test("stream_order:int seed 用 PyRandom 字符串种子(对齐 CPython 真值向量)", () => {
  // python3 -I:random.Random("7:__domains__").shuffle(["acc","fin","ops"]) → [ops,fin,acc]
  //           random.Random("7:acc").shuffle(["t1","t2","t3","t4"]) → [t4,t2,t1,t3]
  //           random.Random("42:__domains__") → [fin,acc,ops]
  const by = { acc: ["t1", "t2", "t3", "t4"], fin: ["f1"], ops: ["o1"] };
  const out7 = schedule.stream_order(by, 7, []);
  assert.deepEqual(out7, [
    ["ops", "o1"],
    ["fin", "f1"],
    ["acc", "t4"],
    ["acc", "t2"],
    ["acc", "t1"],
    ["acc", "t3"],
  ]);
  const out42 = schedule.stream_order(by, 42, []);
  // 域序 = 各域第一次出现的顺序(fin → acc → ops);流是按任务展开的
  assert.deepEqual([...new Set(out42.map(([d]) => d))], ["fin", "acc", "ops"]);
  assert.equal(out42.length, 6);
});

test("stream_order:域序与字典插入序无关(只依赖 seed/域/任务集)", () => {
  const a = { acc: ["t1", "t2"], fin: ["f1"], ops: ["o1"] };
  const b: Record<string, string[]> = { ops: ["o1"], acc: ["t2", "t1"], fin: ["f1"] };
  assert.deepEqual(schedule.stream_order(a, 7, []), schedule.stream_order(b, 7, []));
  assert.deepEqual(
    schedule.stream_order(a, null, ["ops", "fin", "acc"]),
    schedule.stream_order(b, null, ["ops", "fin", "acc"]),
  );
});

test("_default_reference_domain_order:数量降序再名字", () => {
  assert.deepEqual(
    schedule._default_reference_domain_order({ a: ["1", "2"], b: ["1"], c: ["1", "2"] }),
    ["a", "c", "b"],
  );
});

// ---------- TaskResult / _merged_status / _modes_of ----------

test("TaskResult.to_dict 键序固定;_merged_status 按 modes×selections×errors 判定", () => {
  const res = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 2 });
  assert.deepEqual(Object.keys(res.to_dict()), [
    "task_id",
    "domain",
    "k",
    "seed",
    "status",
    "base",
    "modes",
    "selections",
    "errors",
  ]);
  assert.equal(res.status, "running");

  assert.equal(schedule._merged_status({}), "partial"); // 无 modes
  assert.equal(
    schedule._merged_status({
      modes: { agg: { ok: true } },
      selections: { agg: { ok: true, chosen_label: "agg1" } },
      errors: [],
    }),
    "ok",
  );
  assert.equal(
    schedule._merged_status({
      modes: { agg: { ok: true } },
      selections: { agg: { ok: true, chosen_label: "agg1" } },
      errors: ["agg: boom"],
    }),
    "partial",
  );
  assert.equal(
    schedule._merged_status({
      modes: { agg: { ok: true } },
      selections: { agg: { ok: false, chosen_label: "agg1" } },
      errors: [],
    }),
    "partial",
  );
  assert.equal(
    schedule._merged_status({
      modes: { agg: { ok: true } },
      selections: { agg: { ok: true, chosen_label: "" } },
      errors: [],
    }),
    "partial",
  );
});

test("_modes_of:优先 modes 键,legacy arms 兜底", () => {
  assert.deepEqual(schedule._modes_of({ modes: { agg: 1 }, arms: { seq: 2 } }), { agg: 1 });
  assert.deepEqual(schedule._modes_of({ arms: { seq: 2 } }), { seq: 2 });
  assert.deepEqual(schedule._modes_of({}), {});
});

// ---------- _write_summary 合并语义 ----------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

test("_write_summary:首次写入即建 lock 且留存,tmp 改名后不残留", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "evolve-sched-sum-"));
  const p = join(dir, "summary.json");
  const res = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 2 });
  res.status = "partial";
  res.modes = { agg: { ok: false, error: "x" } };
  res.selections = { agg: { ok: false } };
  res.errors = ["agg: boom"];
  await schedule._write_summary(p, res);
  assert.ok(await exists(p));
  assert.ok(await exists(join(dir, "summary.lock"))); // lock 留存(与 Python 一致)
  assert.ok(!(await exists(join(dir, "summary.json.tmp"))));
  const got = JSON.parse(await fs.readFile(p, "utf8"));
  assert.deepEqual(got, res.to_dict());
  assert.equal(got.status, "partial"); // 首次写入不重推 status
});

test("_write_summary:多次写入累积 modes/selections,陈旧 errors 丢弃,status 重推", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "evolve-sched-sum-"));
  const p = join(dir, "summary.json");
  // 第一轮 agg 失败,写入 error
  const res1 = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 1 });
  res1.status = "partial";
  res1.modes = { agg: { ok: false } };
  res1.selections = { agg: { ok: false } };
  res1.errors = ["agg: selection failed: old boom"];
  await schedule._write_summary(p, res1);

  // 第二轮 agg 重跑成功并补写 seq;旧 error 冒号前的 mode 在【本次 res】的
  // modes/selections 已 ok+选中 → 丢弃(与 Python 同:条件查 res 而非合并结果)
  const res2 = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 1 });
  res2.status = "ok";
  res2.modes = { agg: { ok: true }, seq: { ok: true } };
  res2.selections = {
    agg: { ok: true, chosen_label: "agg1" },
    seq: { ok: true, chosen_label: "c1" },
  };
  res2.errors = [];
  await schedule._write_summary(p, res2);

  const got = JSON.parse(await fs.readFile(p, "utf8"));
  assert.deepEqual(Object.keys(got.modes), ["agg", "seq"]); // 旧在前、新追加
  assert.deepEqual(Object.keys(got.selections), ["agg", "seq"]);
  assert.deepEqual(got.errors, []); // "agg: ..." 已被本次 ok 的 agg 记录淘汰
  assert.equal(got.status, "ok"); // ok/partial 写入后按合并结果重推
});

test("_write_summary:no base rollout 陈旧错误的丢弃/保留边界", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "evolve-sched-sum-"));
  const p = join(dir, "summary.json");
  // 旧错误 "no base rollout produced anything" + 新一轮 ok/partial → 丢弃
  const res1 = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 1 });
  res1.status = "base-failed";
  res1.errors = ["no base rollout produced anything"];
  await schedule._write_summary(p, res1);
  const res2 = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 1 });
  res2.status = "partial";
  res2.modes = { agg: { ok: false } };
  res2.errors = ["agg: still broken"];
  await schedule._write_summary(p, res2);
  let got = JSON.parse(await fs.readFile(p, "utf8"));
  assert.deepEqual(got.errors, ["agg: still broken"]);
  assert.equal(got.status, "partial");

  // 重复 errors 去重:同一条只留一份
  const res3 = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 1 });
  res3.status = "base-failed";
  res3.errors = ["agg: still broken"];
  await schedule._write_summary(p, res3);
  got = JSON.parse(await fs.readFile(p, "utf8"));
  assert.deepEqual(got.errors, ["agg: still broken"]); // 旧的同文案不再并入
  assert.equal(got.status, "base-failed"); // 非 ok/partial 不重推
});

// ---------- _resume 各路径 ----------

test("_resume:unreadable JSON / status!=ok / 缺 mode 三条路径", async () => {
  const runs_root = await fs.mkdtemp(join(tmpdir(), "evolve-sched-res-"));
  const adapter = makeAdapter();
  const res = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k: 1 });

  // 1) 坏 JSON → false + 进度行
  const work = new schedule.Namespace("swp", "oc", "agg", 1, null, "").task_dir(runs_root, "t1");
  await fs.mkdir(work, { recursive: true });
  const p = join(work, "summary.json");
  await fs.writeFile(p, "{not json", "utf8");
  let r = await withLogs(() =>
    schedule._resume(p, "t1", 1, adapter, runs_root, ["agg"], null, "", {}, res),
  );
  assert.equal(r.value, false);
  assert.ok(r.logs.some((l) => l.includes("unreadable summary.json")), r.logs.join("\n"));

  // 2) status != "ok" → false 且静默
  await fs.writeFile(p, JSON.stringify({ status: "partial", modes: {}, selections: {} }));
  r = await withLogs(() =>
    schedule._resume(p, "t1", 1, adapter, runs_root, ["agg"], null, "", {}, res),
  );
  assert.equal(r.value, false);
  assert.equal(r.logs.length, 0);

  // 3) 缓存缺请求的 mode → false + 缺清单进度行
  await writeCachedSummary(runs_root, "t1", 1, cachedSel({ run_dir: join(work, "run") }));
  r = await withLogs(() =>
    schedule._resume(p, "t1", 1, adapter, runs_root, ["agg", "seq"], null, "", {}, res),
  );
  assert.equal(r.value, false);
  assert.ok(
    r.logs.some((l) =>
      l.includes("cached summary covers ['agg'], re-running for ['seq']"),
    ),
    r.logs.join("\n"),
  );
});

test("_resume:校验链五类 ValueError 文案逐字", async () => {
  const runs_root = await fs.mkdtemp(join(tmpdir(), "evolve-sched-res-"));
  const k = 1;

  async function attempt(sel: Record<string, unknown>): Promise<{ ok: boolean; logs: string[] }> {
    const res = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k });
    const work = await writeCachedSummary(runs_root, "t1", k, sel);
    const p = join(work, "summary.json");
    const adapter = makeAdapter();
    const r = await withLogs(() =>
      schedule._resume(p, "t1", k, adapter, runs_root, ["agg"], null, "", {}, res),
    );
    return { ok: r.value, logs: r.logs };
  }

  // 1) run 目录缺失
  let r = await attempt(cachedSel({ run_dir: join(tmpdir(), "evolve-no-such-run") }));
  assert.equal(r.ok, false);
  assert.ok(r.logs.some((l) => l.includes("cannot resume agg: adopted run directory is missing")));

  // 2) 产出缺失:目录在但无 deliverable
  const runDir = await fs.mkdtemp(join(tmpdir(), "evolve-sched-run-"));
  r = await attempt(cachedSel({ run_dir: runDir }));
  assert.equal(r.ok, false);
  assert.ok(r.logs.some((l) => l.includes("cannot resume agg: adopted output is missing")));

  // 3) 执行产物被改动
  await fs.writeFile(join(runDir, "answer.txt"), "ok\n", "utf8");
  {
    const res = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k });
    const work = await writeCachedSummary(runs_root, "t1", k, cachedSel({ run_dir: runDir }));
    const adapter = makeAdapter({ artifactsIntact: () => false });
    const rr = await withLogs(() =>
      schedule._resume(
        join(work, "summary.json"),
        "t1",
        k,
        adapter,
        runs_root,
        ["agg"],
        null,
        "",
        {},
        res,
      ),
    );
    assert.equal(rr.value, false);
    assert.ok(
      rr.logs.some((l) =>
        l.includes("cannot resume agg: adopted execution artifacts have changed"),
      ),
    );
  }

  // 4) harness 缺失
  r = await attempt(cachedSel({ run_dir: runDir }));
  assert.equal(r.ok, false);
  assert.ok(r.logs.some((l) => l.includes("cannot resume agg: adopted harness is missing")));

  // 5) harness 被改动(fingerprint 不合)
  {
    const res = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k });
    const work = await writeCachedSummary(
      runs_root,
      "t1",
      k,
      cachedSel({ run_dir: runDir, fingerprint: "0000000000000000" }),
    );
    await mkHarness(join(work, "harnesses", "c1"));
    const adapter = makeAdapter();
    const rr = await withLogs(() =>
      schedule._resume(
        join(work, "summary.json"),
        "t1",
        k,
        adapter,
        runs_root,
        ["agg"],
        null,
        "",
        {},
        res,
      ),
    );
    assert.equal(rr.value, false);
    assert.ok(rr.logs.some((l) => l.includes("cannot resume agg: adopted harness has changed")));
  }
});

test("_resume:全链通过 → status=skipped 并回填 base/modes/selections/errors", async () => {
  const runs_root = await fs.mkdtemp(join(tmpdir(), "evolve-sched-res-"));
  const k = 1;
  const runDir = await fs.mkdtemp(join(tmpdir(), "evolve-sched-run-"));
  await fs.writeFile(join(runDir, "answer.txt"), "ok\n", "utf8");
  const work = await writeCachedSummary(
    runs_root,
    "t1",
    k,
    cachedSel({ run_dir: runDir, label: "c1" }),
  );
  await mkHarness(join(work, "harnesses", "c1"));
  const p = join(work, "summary.json");
  const adapter = makeAdapter();
  const res = new schedule.TaskResult({ task_id: "t1", domain: "accounting", k });
  const r = await withLogs(() =>
    schedule._resume(p, "t1", k, adapter, runs_root, ["agg"], null, "", {}, res),
  );
  assert.equal(r.value, true);
  assert.equal(res.status, "skipped");
  assert.deepEqual(res.base, []);
  assert.equal((res.modes["agg"] as { ok: boolean }).ok, true);
  assert.equal((res.selections["agg"] as { chosen_label: string }).chosen_label, "c1");
  assert.deepEqual(res.errors, []);
});

// ---------- run_task 参数校验 ----------

test("run_task:k/modes/pool_policy 与 library 解析的校验文案", async () => {
  const adapter = makeAdapter();
  const prop = new NoopProposer();
  const base = { adapter, prop, runs_root: "/unused", modes: ["agg"] as string[] };
  await assert.rejects(
    () => schedule.run_task("t1", 0, base),
    (exc: unknown) => {
      assert.equal((exc as Error).message, "k must be positive, got 0");
      return true;
    },
  );
  await assert.rejects(
    () => schedule.run_task("t1", 1, { ...base, modes: [] }),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "modes must contain at least one distinct recursion mode",
      );
      return true;
    },
  );
  await assert.rejects(
    () => schedule.run_task("t1", 1, { ...base, modes: ["agg", "agg"] }),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "modes must contain at least one distinct recursion mode",
      );
      return true;
    },
  );
  await assert.rejects(
    () => schedule.run_task("t1", 1, { ...base, modes: ["bogus"] }),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "unknown modes ['bogus']; expected a subset of ('agg', 'seq')",
      );
      return true;
    },
  );
  await assert.rejects(
    () => schedule.run_task("t1", 1, { ...base, pool_policy: "all" }),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "unknown pool_policy 'all'; this release builds exactly one selection " +
          "pool, 'finals' (the k composed finals)",
      );
      return true;
    },
  );
  assert.throws(
    () => schedule._resolve_libraries({} as never, { agg: {} as never }, ["agg"]),
    (exc: unknown) => {
      assert.equal((exc as Error).message, "pass either library or libraries, not both");
      return true;
    },
  );
  assert.throws(
    () => schedule._resolve_libraries({} as never, null, ["agg", "seq"]),
    (exc: unknown) => {
      assert.equal(
        (exc as Error).message,
        "a shared mutable library would leak one mode into another; " +
          "pass libraries={'agg': ..., 'seq': ...} instead",
      );
      return true;
    },
  );
});

// ---------- 单会话失败不拖垮整轮 sweep ----------

test("run_domain:单任务抛异常记 exception 行,其余任务继续", async () => {
  const runs_root = await fs.mkdtemp(join(tmpdir(), "evolve-sched-dom-"));
  const library_root = await fs.mkdtemp(join(tmpdir(), "evolve-sched-lib-"));
  const k = 1;
  // t1/t3 用合法缓存短路为 skipped;t2 在 domain_of 抛出 → exception 行
  for (const tid of ["t1", "t3"]) {
    const runDir = await fs.mkdtemp(join(tmpdir(), "evolve-sched-run-"));
    await fs.writeFile(join(runDir, "answer.txt"), "ok\n", "utf8");
    const work = await writeCachedSummary(runs_root, tid, k, cachedSel({ run_dir: runDir }));
    await mkHarness(join(work, "harnesses", "c1"));
  }
  const adapter = makeAdapter({
    taskIds: ["t1", "t2", "t3"],
    domainOf: (tid) => {
      if (tid === "t2") throw new Error("boom-t2");
      return "accounting";
    },
  });
  const { value: out, logs } = await withLogs(() =>
    schedule.run_domain("accounting", ["t1", "t2", "t3"], k, {
      adapter,
      prop: new NoopProposer(),
      runs_root,
      library_root,
      modes: ["agg"],
    }),
  );
  assert.equal(out.done, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(
    out.tasks.map((t) => t.status),
    ["skipped", "exception", "skipped"],
  );
  assert.ok(out.tasks[1]?.error?.includes("boom-t2"), out.tasks[1]?.error);
  assert.deepEqual(out.tasks[0]?.library_entries_before, { agg: 0 });
  // 进度行:失败行带 `  :: ` 错误后缀,循环不中断
  assert.ok(logs.some((l) => l.includes("3/3") && l.includes("t3")), logs.join("\n"));
});

test("run_sweep:单域抛出收口为 {domain, error},聚合按 domain 序", async () => {
  const runs_root = await fs.mkdtemp(join(tmpdir(), "evolve-sched-swp-"));
  const library_root = await fs.mkdtemp(join(tmpdir(), "evolve-sched-lib-"));
  const k = 1;
  // d1/t1:resume 校验中 delivered() 埋毒 → is_tree 的 surface() 抛出 → resume 放弃,
  // run_task 主路径 surface() 再抛 → 任务级 exception 行(域级 run_domain 正常返回)。
  // d2:run_domain 入口 surface() 抛出 → 域级 {domain, error} 行。
  // 两行都收口为数据,聚合仍按 domain 序 —— 单会话失败不拖垮整轮。
  let poison = false;
  const runDir = await fs.mkdtemp(join(tmpdir(), "evolve-sched-run-"));
  await fs.writeFile(join(runDir, "answer.txt"), "ok\n", "utf8");
  const work = await writeCachedSummary(
    runs_root,
    "t1",
    k,
    cachedSel({ run_dir: runDir }),
  );
  await mkHarness(join(work, "harnesses", "c1"));
  const adapter = makeAdapter({
    taskIds: ["t1", "t2"],
    domainOf: (tid) => (tid === "t1" ? "d1" : "d2"),
    surface: () => {
      if (poison) throw new Error("surface poisoned");
      return OPENCODE_SURFACE;
    },
    delivered: async (run_dir) => {
      poison = true;
      return run_dir === runDir;
    },
  });
  const { value: sweep } = await withLogs(() =>
    schedule.run_sweep(k, {
      adapter,
      prop: new NoopProposer(),
      runs_root,
      library_root,
      modes: ["agg"],
      domain_parallel: 1,
    }),
  );
  assert.deepEqual(sweep.domain_order, ["d1", "d2"]);
  assert.equal(sweep.n_domains, 2);
  assert.equal(sweep.domains.length, 2);

  const d1 = sweep.domains[0] as schedule.DomainResult;
  assert.equal(d1.domain, "d1");
  assert.equal(d1.failed, 1);
  assert.equal(d1.tasks[0]?.status, "exception");
  assert.ok(d1.tasks[0]?.error?.includes("surface poisoned"), d1.tasks[0]?.error);

  const d2 = sweep.domains[1] as { domain: string; error: string };
  assert.equal(d2.domain, "d2");
  assert.ok(d2.error.includes("surface poisoned"), d2.error);
  assert.ok(!("tasks" in d2));
});

// ---------- golden E2E ----------

function assertKeyOrder(actual: unknown, golden: unknown, path: string): void {
  if (Array.isArray(golden)) {
    assert.ok(Array.isArray(actual), `${path}: expected array`);
    assert.equal((actual as unknown[]).length, golden.length, `${path}: length`);
    golden.forEach((g, i) =>
      assertKeyOrder((actual as unknown[])[i], g, `${path}[${i}]`),
    );
    return;
  }
  if (golden !== null && typeof golden === "object") {
    assert.ok(
      actual !== null && typeof actual === "object" && !Array.isArray(actual),
      `${path}: expected object`,
    );
    assert.deepEqual(
      Object.keys(actual as object),
      Object.keys(golden as object),
      `${path}: key order`,
    );
    for (const key of Object.keys(golden as object)) {
      assertKeyOrder(
        (actual as Record<string, unknown>)[key],
        (golden as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
  }
}

test("golden E2E:runDemo k=2 both——demo.json 与 summary.json×2 对照", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "evolve-golden-"));
  // resolve 临时根:摘要里的路径统一从 realpath 形态归一,兼防 /var 双形态
  const root = await fs.realpath(tmp);
  const report = await withLogs(() => runDemo(root, { k: 2, modes: schedule.MODES }));
  const demo = report.value;
  // demo 预算锚点(Python golden 运行的 28 次执行 / 32 次 editor 调用)
  assert.equal(demo.execution_count, 28);
  assert.equal(demo.editor_calls, 32);

  // demo.json:json.dumps(indent=2) + "\n";键序与内容逐项对照
  const demoRaw = await fs.readFile(join(root, "demo.json"), "utf8");
  assert.ok(demoRaw.endsWith("}\n"), "demo.json 保留尾换行");
  assert.ok(!demoRaw.endsWith("}\n\n"), "demo.json 恰一个尾换行");
  const goldenDemoRaw = await fs.readFile(join(GOLDEN_ROOT, "demo.json"), "utf8");
  const gotDemo = JSON.parse(demoRaw) as Record<string, unknown>;
  const wantDemo = JSON.parse(goldenDemoRaw) as Record<string, unknown>;
  assertKeyOrder(gotDemo, wantDemo, "demo.json");
  assert.deepEqual(gotDemo, wantDemo);

  // summary.json×2:json.dumps(indent=2) 无尾换行;<RUN_ROOT> 归一后全量对照
  for (const tid of ["ledger-1", "ledger-2"]) {
    const p = join(root, "runs", "demo-oc-agg2", tid, "summary.json");
    let raw = await fs.readFile(p, "utf8");
    assert.ok(!raw.endsWith("\n"), `summary.json(${tid}) 无尾换行(与 Python json.dumps 一致)`);
    raw = raw.split(root).join("<RUN_ROOT>");
    if (tmp !== root) raw = raw.split(tmp).join("<RUN_ROOT>");
    const goldenRaw = await fs.readFile(
      join(GOLDEN_ROOT, "runs", "demo-oc-agg2", tid, "summary.json"),
      "utf8",
    );
    const got = JSON.parse(raw) as unknown;
    const want = JSON.parse(goldenRaw) as unknown;
    assertKeyOrder(got, want, `summary.json(${tid})`);
    assert.deepEqual(got, want);
  }
});
