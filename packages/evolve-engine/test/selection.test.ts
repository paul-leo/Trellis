// 任务 5.2 验证:selection 移植——两段式物理隔离 + golden 对照 + 失败收口/trivial。
// tasks.md 显式验证点:
//   - 隔离结构测试:评分绊线在 prop.call 前强制;call 时刻 root 无 selection.json;
//     候选仅 <anon>.md;mission/候选内容无原 label、无 GRADER_VERDICT_MARKERS、
//     不标明哪臂为新(选择器只见匿名 id);id_map 反查;
//   - golden 对照全绿:四配置(seq2/agg2 × ledger-1/ledger-2)的 candidates/task.md/source
//     逐字节,selection.json 逐字段+键序(experience 在 reflect 阶段才填,此处断言空对象);
//     _distil 解析对照 golden experience 五键;assign_ids 种子稳定性四例。
// 通道执行一律用桩(FakeProposer 覆写 _execute),不 spawn 真实 CLI。
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GRADER_VERDICT_MARKERS } from "../src/context.js";
import { Proposer, ProposerError } from "../src/proposer.js";
import {
  _anon_id,
  _distil,
  _evidence_block,
  _fallback,
  _is_base,
  _write_candidates,
  assign_ids,
  order_graded_first,
  run_selection,
  Selection,
  selection_pool,
  trivial_selection,
  ValueError,
} from "../src/selection.js";
import {
  makeBenchPrompts,
  makeBenchSpec,
  makeChannelSpec,
  makeRunView,
} from "../src/spec.js";
import type { BenchmarkAdapter, BenchSpec, RunView } from "../src/spec.js";

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "golden",
  "demo-k2-both",
);

const CHANS = {
  proposer: makeChannelSpec({ kind: "claude_cli", model: "claude-x" }),
  selector: makeChannelSpec({ kind: "claude_cli", model: "claude-x" }),
};

function benchSpec(overrides: Partial<Parameters<typeof makeBenchSpec>[0]> = {}): BenchSpec {
  return makeBenchSpec({
    name: "demo",
    runs_root: "/r",
    install_mode: "workspace_agents_md",
    prompts: makeBenchPrompts({ work: "Sum every signed amount in ledger.csv." }),
    channels: CHANS,
    ...overrides,
  });
}

interface FakeAdapterOpts {
  spec?: BenchSpec;
  taskPrompt?: string;
  taskFiles?: string | null;
  trajectory?: string | ((run_dir: string) => string);
  deliverableText?: string | ((run_dir: string) => string);
  deliverableAssets?: string[] | ((run_dir: string) => string[]);
  deliverableAssetsNote?: (names: string[]) => string;
  deliverableAssetsLine?: (shown: string) => string;
  deliverableAssetsReferenceOnly?: boolean;
  stateDeliverable?: boolean;
}

function makeAdapter(opts: FakeAdapterOpts = {}): BenchmarkAdapter {
  const spec = opts.spec ?? benchSpec(opts.stateDeliverable ? { state_deliverable: true } : {});
  return {
    spec,
    substrate: {
      name: "opencode",
      surface: () => ({}),
    },
    tasks: async () => [],
    domain_of: () => "accounting",
    task_prompt: () => opts.taskPrompt ?? "Sum every signed amount in ledger.csv.",
    task_files: async () => opts.taskFiles ?? null,
    execute: async () => "",
    delivered: async () => true,
    trajectory: async (run_dir: string) =>
      typeof opts.trajectory === "function" ? opts.trajectory(run_dir) : (opts.trajectory ?? "TRAJ\n"),
    deliverable_files: async () => ({}),
    deliverable_text: async (run_dir: string) =>
      typeof opts.deliverableText === "function"
        ? opts.deliverableText(run_dir)
        : (opts.deliverableText ?? ""),
    ...(opts.deliverableAssets
      ? {
          deliverable_assets: async (run_dir: string) =>
            typeof opts.deliverableAssets === "function"
              ? opts.deliverableAssets(run_dir)
              : opts.deliverableAssets!,
        }
      : {}),
    ...(opts.deliverableAssetsNote
      ? { deliverable_assets_note: opts.deliverableAssetsNote }
      : {}),
    ...(opts.deliverableAssetsLine
      ? { deliverable_assets_line: opts.deliverableAssetsLine }
      : {}),
    ...(opts.deliverableAssetsReferenceOnly
      ? { deliverable_assets_reference_only: true }
      : {}),
    base_harness: async () => "",
    validate_tree: async () => {},
    score: async () => ({}),
  } as BenchmarkAdapter;
}

function run(label: string, run_id?: string, run_dir?: string): RunView {
  return makeRunView({
    label,
    run_id: run_id ?? `r/${label}`,
    run_dir: run_dir ?? `/runs/${label}`,
    ok: true,
    delivered: true,
  });
}

type ExecResult = [string, number, string];

class FakeProposer extends Proposer {
  exec_calls = 0;
  missions: string[] = [];
  behavior: (tmp: string, mission: string, system: string, wall: number) => Promise<ExecResult>;

  constructor(
    behavior: (tmp: string, mission: string, system: string, wall: number) => Promise<ExecResult>,
    opts: ConstructorParameters<typeof Proposer>[1] = {},
  ) {
    super(CHANS.selector, { attempts: 1, ...opts });
    this.behavior = behavior;
  }

  protected async _execute(
    tmp: string,
    mission: string,
    system: string,
    wall: number,
  ): Promise<ExecResult> {
    this.exec_calls += 1;
    this.missions.push(mission);
    return this.behavior(tmp, mission, system, wall);
  }
}

const choiceReply = (anon: string, why = "The signed total matches the source ledger."): string =>
  `<why>${why}</why>\n\n\`\`\`choice\n${anon}\n\`\`\``;

async function withWork<T>(fn: (work: string) => Promise<T>): Promise<T> {
  const work = await fs.mkdtemp(join(tmpdir(), "sel-work-"));
  try {
    return await fn(work);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

// ---- assign_ids:种子稳定性 ----

test("assign_ids: golden 四例 id_map 与 Python 逐键一致(含键序)", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["ledger-1|2|seq", { A: "c1", B: "c2" }],
    ["ledger-2|2|seq", { A: "c2", B: "c1" }],
    ["ledger-1|2|agg", { A: "agg1", B: "agg2" }],
    ["ledger-2|2|agg", { A: "agg2", B: "agg1" }],
  ];
  for (const [spec, want] of cases) {
    const [task_id, k, mode] = spec.split("|");
    const labels = mode === "agg" ? ["agg1", "agg2"] : ["c1", "c2"];
    const got = assign_ids(labels, { task_id, k: Number(k), mode });
    assert.deepEqual(got, want, spec);
    assert.deepEqual(Object.keys(got), Object.keys(want), `${spec} 键序`);
  }
});

test("_anon_id: A..Z 与 AA 跨界;_is_base 前缀判定;order_graded_first 稳定排序", () => {
  assert.deepEqual([0, 25, 26, 51, 52].map(_anon_id), ["A", "Z", "AA", "AZ", "BA"]);
  assert.equal(_is_base("base1"), true);
  assert.equal(_is_base("c1"), false);
  assert.deepEqual(
    order_graded_first(["c1", "base1", "agg2"], (x) => _is_base(x)),
    ["base1", "c1", "agg2"],
  );
});

// ---- golden:run_selection 四配置 ----

interface GoldenCase {
  mode: "seq" | "agg";
  task_id: string;
  runsDir: string; // golden executions/.../<task> 的父目录键
  labels: [string, string];
}

test("golden: run_selection 四配置 —— candidates/task.md/source 逐字节,selection.json 逐字段+键序", async () => {
  const cases: GoldenCase[] = [
    { mode: "seq", task_id: "ledger-1", runsDir: "demo-oc-seq2", labels: ["c1", "c2"] },
    { mode: "seq", task_id: "ledger-2", runsDir: "demo-oc-seq2", labels: ["c1", "c2"] },
    { mode: "agg", task_id: "ledger-1", runsDir: "demo-oc-agg2", labels: ["agg1", "agg2"] },
    { mode: "agg", task_id: "ledger-2", runsDir: "demo-oc-agg2", labels: ["agg1", "agg2"] },
  ];
  const taskText = await fs.readFile(
    join(GOLDEN, "runs", "demo-oc-seq2", "ledger-1", "selection", "seq2", "task.md"),
    "utf8",
  );
  for (const c of cases) {
    const goldenSel = join(GOLDEN, "runs", c.runsDir, c.task_id, "selection", `${c.mode}2`);
    const candidates: Record<string, RunView> = {};
    for (const lbl of c.labels) {
      candidates[lbl] = run(
        lbl,
        `${c.runsDir}/${c.task_id}/${lbl}`,
        join(GOLDEN, "executions", c.runsDir, c.task_id, lbl),
      );
    }
    await withWork(async (work) => {
      const adapter = makeAdapter({
        taskPrompt: taskText,
        taskFiles: join(GOLDEN, "sources", c.task_id),
        deliverableText: async (run_dir) => fs.readFile(join(run_dir, "answer.txt"), "utf8"),
      });
      const prop = new FakeProposer(async () => [choiceReply("A"), 0, ""]);
      const sel = await run_selection(c.task_id, 2, c.mode, candidates, {
        adapter,
        prop,
        work_dir: work,
      });
      const root = join(work, "selection", `${c.mode}2`);

      // candidates/*.md 与 task.md/source 逐字节
      for (const anon of ["A", "B"]) {
        const got = await fs.readFile(join(root, "candidates", `${anon}.md`));
        const want = await fs.readFile(join(goldenSel, "candidates", `${anon}.md`));
        assert.deepEqual(got, want, `${c.task_id}/${c.mode}2 candidates/${anon}.md`);
      }
      assert.deepEqual(
        await fs.readFile(join(root, "task.md")),
        await fs.readFile(join(goldenSel, "task.md")),
        `${c.task_id}/${c.mode}2 task.md`,
      );
      assert.deepEqual(
        await fs.readFile(join(root, "source", "ledger.csv")),
        await fs.readFile(join(goldenSel, "source", "ledger.csv")),
        `${c.task_id}/${c.mode}2 source/ledger.csv`,
      );

      // selection.json:键序 + 逐字段;experience 在 reflect 阶段才填;chosen_run_dir 为绝对路径
      const rec = JSON.parse(await fs.readFile(join(root, "selection.json"), "utf8"));
      const want = JSON.parse(await fs.readFile(join(goldenSel, "selection.json"), "utf8"));
      assert.deepEqual(Object.keys(rec), Object.keys(want), `${c.task_id}/${c.mode}2 键序`);
      for (const key of Object.keys(want)) {
        if (key === "experience" || key === "chosen_run_dir") continue;
        assert.deepEqual(rec[key], want[key], `${c.task_id}/${c.mode}2 ${key}`);
      }
      assert.deepEqual(rec.experience, {}, "experience 由 reflect_adoption 填,run_selection 后为空");
      const chosen = candidates[want.chosen_label];
      assert.equal(rec.chosen_run_dir, chosen.run_dir);
      assert.equal(sel.chosen_id, want.chosen_id);
      assert.equal(sel.chosen_label, want.chosen_label);
      assert.equal(sel.usd, 0);
    });
  }
});

// ---- golden:_distil 解析 ----

const GOLDEN_EXPERIENCE = {
  cue: "When a ledger includes credits and debits",
  lesson: "Include both signs when summing in scripts/summarize.py.",
  evidence:
    "The scripts/summarize.py row -- removing the positive-only filter changed the probe total to include the credits omitted by the base trajectory.",
  confidence: "high for this observed arithmetic contrast",
  edits:
    "component: scripts/summarize.py\n" +
    "candidates: inv1\n" +
    "change: dropped the positive-only filter from the amount sum\n" +
    "observed: the probe total included the credits the base run omitted\n" +
    "verdict: helped",
};

const GOLDEN_EXP_REPLY =
  "<edits>\n" +
  "component: scripts/summarize.py\n" +
  "candidates: inv1\n" +
  "change: dropped the positive-only filter from the amount sum\n" +
  "observed: the probe total included the credits the base run omitted\n" +
  "verdict: helped\n" +
  "</edits>\n" +
  "<experience>\n" +
  "cue: When a ledger includes credits and debits\n" +
  "lesson: Include both signs when summing in scripts/summarize.py.\n" +
  "evidence: The scripts/summarize.py row -- removing the positive-only filter changed the probe total to include the credits omitted by the base trajectory.\n" +
  "confidence: high for this observed arithmetic contrast\n" +
  "</experience>";

test("golden: _distil 解析 <edits>/<experience> → experience 五键与 golden 一致", async () => {
  await withWork(async (work) => {
    const root = join(work, "reflection", "seq2");
    await fs.mkdir(root, { recursive: true });
    const sel = new Selection("ledger-1", "seq", 2);
    sel.chosen_label = "c1";
    sel.why = "The signed total matches the source ledger.";
    const prop = new FakeProposer(async () => [GOLDEN_EXP_REPLY, 0, ""]);
    const out = await _distil("ledger-1", sel, {}, {
      adapter: makeAdapter(),
      prop,
      root,
    });
    assert.deepEqual(out, GOLDEN_EXPERIENCE);
    assert.deepEqual(Object.keys(out), Object.keys(GOLDEN_EXPERIENCE), "experience 键序");
    // edits.md 同步落盘(带尾换行);experience 副本不含 selection.json
    assert.equal(
      await fs.readFile(join(root, "edits.md"), "utf8"),
      GOLDEN_EXPERIENCE.edits + "\n",
    );
    assert.deepEqual(sel.usd, 0);
  });
});

test("_distil: cue/lesson/evidence 任一缺失 → 空对象;无 <experience> 块 → 空对象", async () => {
  await withWork(async (work) => {
    const root = join(work, "reflection", "seq2");
    await fs.mkdir(root, { recursive: true });
    const sel = new Selection("ledger-1", "seq", 2);
    sel.chosen_label = "c1";
    const prop1 = new FakeProposer(async () => [
      "<experience>\ncue: only cue\nlesson: only lesson\n</experience>",
      0,
      "",
    ]);
    assert.deepEqual(
      await _distil("ledger-1", sel, {}, { adapter: makeAdapter(), prop: prop1, root }),
      {},
    );
    const prop2 = new FakeProposer(async () => ["plain reply, no tags", 0, ""]);
    assert.deepEqual(
      await _distil("ledger-1", sel, {}, { adapter: makeAdapter(), prop: prop2, root }),
      {},
    );
  });
});

// ---- 隔离结构测试 ----

test("隔离: 评分绊线在 prop.call 前强制 —— deliverable 含 marker 时抛错且选择器零调用", async () => {
  await withWork(async (work) => {
    const adapter = makeAdapter({
      deliverableText: "Total: 1\n\ndeterministic_eval_summary",
    });
    const prop = new FakeProposer(async () => [choiceReply("A"), 0, ""]);
    await assert.rejects(
      run_selection("t", 2, "seq", { c1: run("c1"), c2: run("c2") }, { adapter, prop, work_dir: work }),
      /grader verdict would enter model context/,
    );
    assert.equal(prop.exec_calls, 0, "绊线先于选择器,通道执行不得发生");
  });
});

test("隔离: call 时刻 root 无 selection.json;候选仅 <anon>.md;mission/候选无原 label、无 verdict 字样", async () => {
  await withWork(async (work) => {
    const adapter = makeAdapter({ deliverableText: "Total: 85.15\n" });
    let callTimeListing: string[] = [];
    let missionText = "";
    const prop = new FakeProposer(async (_t, mission) => {
      missionText = mission;
      callTimeListing = await fs.readdir(join(work, "selection", "seq2"));
      return [choiceReply("A"), 0, ""];
    });
    const sel = await run_selection(
      "ledger-1",
      2,
      "seq",
      { c1: run("c1"), c2: run("c2"), inv1: run("inv1"), dom1: run("dom1") },
      { adapter, prop, work_dir: work },
    );
    // call 时刻:上下文齐备,selection.json 尚未落盘(两段式:先写证据后调选择器)
    assert.ok(callTimeListing.includes("candidates"));
    assert.ok(callTimeListing.includes("task.md"));
    assert.ok(!callTimeListing.includes("selection.json"), "call 时刻不得已有 selection.json");
    // 调用后才持久化
    const after = await fs.readdir(join(work, "selection", "seq2"));
    assert.ok(after.includes("selection.json"));

    // 候选文件名仅匿名 id;内容与 mission 不得携带原 label 或评分字样
    const candNames = (await fs.readdir(join(work, "selection", "seq2", "candidates"))).sort();
    assert.deepEqual(candNames, ["A.md", "B.md", "C.md", "D.md"]);
    for (const name of candNames) {
      const body = await fs.readFile(join(work, "selection", "seq2", "candidates", name), "utf8");
      for (const marker of GRADER_VERDICT_MARKERS) {
        assert.ok(!body.includes(marker), `${name} 含评分 marker ${marker}`);
      }
      for (const lbl of ["c1", "c2", "inv1", "dom1"]) {
        assert.ok(!body.includes(lbl), `${name} 含原 label ${lbl}`);
      }
      assert.match(body, /^<!-- candidate [A-D]: /, `${name} 头部标注匿名 id`);
    }
    // mission:只以匿名 id 引用候选(不标明哪臂为新/旧),无 verdict 字样
    assert.ok(missionText.includes("Choose exactly one of: A, B, C, D."), "mission 给出匿名 id 全集");
    for (const marker of GRADER_VERDICT_MARKERS) {
      assert.ok(!missionText.includes(marker), `mission 含评分 marker ${marker}`);
    }
    for (const lbl of ["c1", "c2", "inv1", "dom1"]) {
      assert.ok(!missionText.includes(lbl), `mission 含原 label ${lbl}`);
    }
    // id_map 反查:choice=A ⇒ chosen_label 为 id_map.A,不落到原 label 语义之外
    assert.equal(sel.chosen_id, "A");
    assert.equal(sel.chosen_label, sel.id_map.A);
    assert.ok(["c1", "c2", "inv1", "dom1"].includes(sel.chosen_label));
  });
});

test("隔离: 候选 render 失败记入 dropped 且截断到 200 字符,池中不含失败项", async () => {
  await withWork(async (work) => {
    const adapter = makeAdapter({
      deliverableText: async (run_dir) => {
        if (run_dir.endsWith("c2")) throw new Error("boom");
        return "Total: 1\n";
      },
    });
    const prop = new FakeProposer(async () => [choiceReply("A"), 0, ""]);
    const sel = await run_selection("t", 2, "seq", { c1: run("c1"), c2: run("c2") }, {
      adapter,
      prop,
      work_dir: work,
    });
    assert.equal(sel.n_candidates, 1);
    assert.equal(sel.dropped.length, 1);
    assert.match(sel.dropped[0], /^c2 \(render failed: Error: boom\)$/);
    assert.ok(sel.dropped[0].length <= 200);
    assert.equal(sel.chosen_label, "c1");
  });
});

// ---- 失败收口 ----

test("fallback: 选择器失败回退 base;finals 池回退 sorted 第一;mixed 无 base 记错不抛", async () => {
  await withWork(async (work) => {
    // 空回复+错误串:call() 记 spent_usd 后失败收口抛 ProposerError(cost 随错误入账)。
    const dead = async (): Promise<ExecResult> => ["", 0.25, "channel dead"];
    // 1) mixed 池含 base:回退 base1
    {
      const prop = new FakeProposer(dead);
      const sel = await run_selection("t", 2, "seq", {
        base1: run("base1"),
        c1: run("c1"),
      }, { adapter: makeAdapter({ deliverableText: "X\n" }), prop, work_dir: work });
      assert.equal(sel.ok, false, "回退不冒充选择成功");
      assert.equal(sel.fallback, true);
      assert.equal(sel.chosen_label, "base1");
      assert.equal(sel.chosen_is_base, true);
      assert.equal(sel.id_map[sel.chosen_id], "base1");
      assert.ok(sel.error.includes("channel dead"));
      assert.equal(sel.usd, 0.25, "失败会话成本随 ProposerError 入账");
    }
    // 2) finals 池(无 base):回退 sorted 第一
    {
      const prop = new FakeProposer(dead);
      const sel = await run_selection("t", 1, "seq", {
        fin2: run("fin2"),
        fin1: run("fin1"),
      }, {
        adapter: makeAdapter({ deliverableText: "X\n" }),
        prop,
        work_dir: work,
        pool_kind: "finals",
      });
      assert.equal(sel.fallback, true);
      assert.equal(sel.chosen_label, "fin1");
      assert.equal(sel.chosen_is_base, false);
    }
    // 3) mixed 池无 base:错误收口,不抛
    {
      const prop = new FakeProposer(dead);
      const sel = await run_selection("t", 2, "seq", {
        c1: run("c1"),
        c2: run("c2"),
      }, { adapter: makeAdapter({ deliverableText: "X\n" }), prop, work_dir: work });
      assert.equal(sel.ok, false);
      assert.equal(sel.fallback, false);
      assert.ok(sel.error.endsWith("; no delivered base artifact was available for a neutral fallback"));
    }
  });
});

test("fallback: no ```choice / 未知 choice 的 ValueError 文案与 Python 一致", async () => {
  await withWork(async (work) => {
    // 无 choice 块
    const p1 = new FakeProposer(async () => ["just prose", 0, ""]);
    const s1 = await run_selection("t", 2, "seq", { base1: run("base1"), c1: run("c1") }, {
      adapter: makeAdapter({ deliverableText: "X\n" }),
      prop: p1,
      work_dir: work,
    });
    assert.equal(s1.fallback, true);
    assert.ok(s1.error.includes("no ```choice block in the reply"));
    // 未知 id(choice 解析成功但不在 id_map)
    const p2 = new FakeProposer(async () => [choiceReply("Z"), 0, ""]);
    const s2 = await run_selection("t", 2, "seq", { base1: run("base1"), c1: run("c1") }, {
      adapter: makeAdapter({ deliverableText: "X\n" }),
      prop: p2,
      work_dir: work,
    });
    assert.equal(s2.fallback, true);
    assert.ok(s2.error.includes(`chose 'Z', which is not one of`), s2.error);
    assert.ok(s2.error.includes("A, B"), s2.error);
  });
});

test("run_selection: 全候选非答案 → 空池提前返回,不调选择器", async () => {
  await withWork(async (work) => {
    const prop = new FakeProposer(async () => [choiceReply("A"), 0, ""]);
    const sel = await run_selection("t", 2, "seq", {
      c1: makeRunView({ label: "c1", run_id: "r/c1", run_dir: "/r/c1", ok: false, delivered: true }),
      c2: makeRunView({ label: "c2", run_id: "r/c2", run_dir: "/r/c2", ok: true, delivered: false }),
    }, { adapter: makeAdapter({ deliverableText: "X\n" }), prop, work_dir: work });
    assert.equal(sel.ok, false);
    assert.equal(sel.n_candidates, 0);
    assert.equal(sel.error, "no candidate produced an artifact");
    assert.deepEqual(sel.dropped, ["c1", "c2"]);
    assert.equal(prop.exec_calls, 0);
  });
});

test("trajectory fallback: state_deliverable 且交付全空时用轨迹,evidence=trajectory,dropped 过滤裸 label", async () => {
  await withWork(async (work) => {
    const adapter = makeAdapter({
      stateDeliverable: true,
      deliverableText: async () => "",
      trajectory: "[ACTION] run\n[OBSERVATION] done\n",
    });
    const prop = new FakeProposer(async () => [choiceReply("A"), 0, ""]);
    const sel = await run_selection("t", 2, "seq", {
      c1: run("c1"),
      c2: makeRunView({ label: "c2", run_id: "r/c2", run_dir: "/r/c2", ok: false, delivered: true }),
    }, { adapter, prop, work_dir: work });
    assert.equal(sel.evidence, "trajectory");
    assert.equal(sel.n_candidates, 1);
    assert.deepEqual(sel.dropped, ["c2"], "c1 经轨迹入池,裸 label 从 dropped 移除");
    const body = await fs.readFile(join(work, "selection", "seq2", "candidates", "A.md"), "utf8");
    assert.ok(body.includes("(this task produced no file deliverable"));
    assert.ok(body.includes("[OBSERVATION] done"));
  });
});

// ---- trivial_selection ----

test("trivial_selection: k=1 单 final 直接交付,selection.json 同 schema;>1 抛 ValueError;空池报错", async () => {
  await withWork(async (work) => {
    const adapter = makeAdapter({ deliverableText: "Total: 85.15\n" });
    // 单候选
    const sel = await trivial_selection("ledger-1", 1, "seq", {
      c1: run("c1", "demo/ledger-1/c1", "/exec/c1"),
    }, { adapter, work_dir: work });
    assert.equal(sel.ok, true);
    assert.equal(sel.trivial, true);
    assert.equal(sel.chosen_id, "A");
    assert.equal(sel.chosen_label, "c1");
    assert.deepEqual(sel.id_map, { A: "c1" });
    assert.equal(sel.chosen_run_id, "demo/ledger-1/c1");
    assert.equal(
      sel.why,
      "trivial pool: single final at k=1; delivered without a selector session",
    );
    const rec = JSON.parse(
      await fs.readFile(join(work, "selection", "seq1", "selection.json"), "utf8"),
    );
    assert.equal(rec.trivial, true);
    assert.equal(rec.chosen_run_dir, "/exec/c1");
    // 多候选
    await assert.rejects(
      trivial_selection("t", 1, "seq", { a: run("a"), b: run("b") }, { adapter, work_dir: work }),
      (e: unknown) => {
        assert.ok(e instanceof ValueError, `应为 ValueError,实为 ${String(e)}`);
        assert.equal(
          e.message,
          "trivial_selection expects at most one candidate (the k=1 final), got ['a', 'b']",
        );
        return true;
      },
    );
    // 空池
    const empty = await trivial_selection("t", 1, "seq", {
      c1: makeRunView({ label: "c1", run_id: "r/c1", run_dir: "/r/c1", ok: false, delivered: true }),
    }, { adapter, work_dir: work });
    assert.equal(empty.ok, false);
    assert.equal(
      empty.error,
      "no candidate produced an artifact (finals-only pool has no base fallback)",
    );
  });
});

// ---- selection_pool / assets / evidence block ----

test("selection_pool: seq 取 c1..ck、agg 取 agg1..aggk;base 收下即弃", () => {
  const rollouts: Record<string, RunView> = {
    base1: run("base1"),
    c1: run("c1"),
    c2: run("c2"),
    agg1: run("agg1"),
    agg2: run("agg2"),
  };
  const seq = selection_pool("seq", 2, rollouts, [rollouts.base1]);
  assert.deepEqual(Object.keys(seq), ["c1", "c2"]);
  const agg = selection_pool("agg", 2, rollouts, [rollouts.base1]);
  assert.deepEqual(Object.keys(agg), ["agg1", "agg2"]);
  const sparse = selection_pool("seq", 3, { c2: run("c2"), c3: run("c3") }, []);
  assert.deepEqual(Object.keys(sparse), ["c2", "c3"], "缺项跳过不补位");
});

test("assets: 只拷明示且存在的文件;默认 note 替换 {anon}/{names};钩子覆盖;reference_only 措辞", async () => {
  await withWork(async (work) => {
    const assetsDir = join(work, "src-assets");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(join(assetsDir, "shot.png"), "PNG", "utf8");
    const adapter = makeAdapter({
      deliverableText: "Total: 1\n",
      deliverableAssets: [join(assetsDir, "shot.png"), join(assetsDir, "missing.bin")],
    });
    const sel = new Selection("t", "seq", 1);
    sel.id_map = { A: "c1" };
    const cand_dir = join(work, "candidates");
    await fs.mkdir(cand_dir, { recursive: true });
    await _write_candidates(sel, { c1: "Body\n" }, { c1: run("c1") }, cand_dir, adapter);
    // 只拷存在的明示文件,落进 A/
    assert.deepEqual(await fs.readdir(join(cand_dir, "A")), ["shot.png"]);
    const body = await fs.readFile(join(cand_dir, "A.md"), "utf8");
    assert.ok(body.includes("is in `A/`: shot.png"), body);
    assert.ok(body.includes("OPEN THESE"));

    // 钩子:{anon} 全量替换;自定义 line
    const custom = makeAdapter({
      deliverableText: "T\n",
      deliverableAssets: [join(assetsDir, "shot.png")],
      deliverableAssetsNote: (names) => `see {anon}/ -> ${names.join("|")} / {anon}`,
      deliverableAssetsLine: (shown) => `LINE ${shown}`,
    });
    const sel2 = new Selection("t", "seq", 1);
    sel2.id_map = { A: "c1" };
    const cand2 = join(work, "candidates2");
    await fs.mkdir(cand2, { recursive: true });
    await _write_candidates(sel2, { c1: "B\n" }, { c1: run("c1") }, cand2, custom);
    const body2 = await fs.readFile(join(cand2, "A.md"), "utf8");
    assert.ok(body2.includes("see A/ -> shot.png / A"), body2);

    const [aLine, aEvid] = _evidence_block(new Set(["shot.png"]), custom, false);
    assert.equal(aLine, "LINE shot.png");
    assert.equal(
      aEvid,
      "context/candidates/<id>/        rendered evidence per candidate: shot.png\n",
    );
    const [, aEvidRef] = _evidence_block(new Set(["shot.png"]), custom, true);
    assert.equal(
      aEvidRef,
      "context/candidates/<id>/        raw originals per candidate: shot.png\n",
    );
    const [emptyLine, emptyEvid] = _evidence_block(new Set(), custom, false);
    assert.equal(emptyLine, "");
    assert.equal(emptyEvid, "");
  });
});

test("_fallback: Selection.to_dict 字段序固定,chosen_run_dir 由 _persist 补在末位", () => {
  const sel = new Selection("t", "seq", 2);
  assert.deepEqual(Object.keys(sel.to_dict()), [
    "task_id",
    "mode",
    "k",
    "chosen_id",
    "chosen_label",
    "chosen_run_id",
    "chosen_is_base",
    "why",
    "id_map",
    "dropped",
    "n_candidates",
    "ok",
    "fallback",
    "error",
    "usd",
    "experience",
    "trivial",
    "evidence",
  ]);
  // _fallback 单元:仅 base 命中时 chosen_id 反查 id_map
  const s2 = new Selection("t", "seq", 2);
  s2.id_map = { A: "c1", B: "base1" };
  assert.equal(_fallback(s2, { base1: run("base1"), c1: run("c1") }, "mixed", new Error("x")), true);
  assert.equal(s2.chosen_label, "base1");
  assert.equal(s2.chosen_id, "B");
  assert.equal(s2.fallback, true);
});

test("ProposerError 失败路径:prop 抛错经失败收口进入 fallback,不外抛", async () => {
  await withWork(async (work) => {
    // behavior 抛非 ProposerError → call 包成 ProposerError(attempts:1 不重试)
    const prop = new FakeProposer(async () => {
      throw new Error("nope");
    });
    const sel = await run_selection("t", 2, "seq", { base1: run("base1"), c1: run("c1") }, {
      adapter: makeAdapter({ deliverableText: "X\n" }),
      prop,
      work_dir: work,
    });
    assert.equal(sel.fallback, true);
    assert.equal(sel.chosen_label, "base1");
    assert.ok(sel.error.includes("nope"));
  });
});
