// keepBaseInPool — D11 base 留池偏差(tasks 13.2)。
//
// 场景映射(tasks 13.2 验证锚文):
//   - 含 base 的比较:poolWithBase 把 base rollouts 并入候选池,run_selection
//     在含 base 的池上完成匿名比较;
//   - 选中 base ⟹ 不采纳:选择器选中 base 臂时 chosen_is_base 表达不采纳;
//   - 选择器失败回退 base(_fallback)与留池语义不冲突:留池后 base 仍在
//     池中,_fallback 照样按 _is_base 标签中立回退。
// 另覆盖:数据开关缺省 false(harness2 原样)、trivial_selection 单候选
// 契约未动(留池下 k=1 不走 trivial 的原因)。

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Proposer, ProposerError } from "../src/proposer.js";
import {
  assign_ids,
  run_selection,
  trivial_selection,
  ValueError,
} from "../src/selection.js";
import { poolWithBase } from "../src/schedule.js";
import {
  makeBenchPrompts,
  makeBenchSpec,
  makeChannelSpec,
  makeRunView,
} from "../src/spec.js";
import type { BenchmarkAdapter, BenchSpec, RunView } from "../src/spec.js";

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

function makeAdapter(opts: { spec?: BenchSpec } = {}): BenchmarkAdapter {
  return {
    spec: opts.spec ?? benchSpec(),
    substrate: { name: "opencode", surface: () => ({}) },
    tasks: async () => [],
    domain_of: () => "accounting",
    task_prompt: () => "Sum every signed amount in ledger.csv.",
    task_files: async () => null,
    execute: async () => "",
    delivered: async () => true,
    trajectory: async () => "TRAJ\n",
    deliverable_files: async () => ({}),
    deliverable_text: async (run_dir: string) => `body for ${run_dir}\n`,
    base_harness: async () => "",
    validate_tree: async () => {},
    score: async () => ({}),
  } as BenchmarkAdapter;
}

function run(label: string): RunView {
  return makeRunView({
    label,
    run_id: `r/${label}`,
    run_dir: `/runs/${label}`,
    ok: true,
    delivered: true,
  });
}

type ExecResult = [string, number, string];

class FakeProposer extends Proposer {
  behavior: () => Promise<ExecResult>;
  constructor(behavior: () => Promise<ExecResult>) {
    super(CHANS.selector, { attempts: 1 });
    this.behavior = behavior;
  }
  protected async _execute(): Promise<ExecResult> {
    return this.behavior();
  }
}

const choiceReply = (anon: string): string =>
  `<why>looks right</why>\n\n\`\`\`choice\n${anon}\n\`\`\``;

async function withWork<T>(fn: (work: string) => Promise<T>): Promise<T> {
  const work = await fs.mkdtemp(join(tmpdir(), "keep-base-"));
  try {
    return await fn(work);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** 留池后的池形态(finals + base,与 schedule._run_one_mode 的并入一致)。 */
function pooled(): Record<string, RunView> {
  return poolWithBase({ c1: run("c1"), c2: run("c2") }, [run("base1")]);
}

test("keepBaseInPool 数据开关:缺省 false(harness2 原样),可显式打开", () => {
  assert.equal(benchSpec().keepBaseInPool, false);
  assert.equal(benchSpec({ keepBaseInPool: true }).keepBaseInPool, true);
});

test("含 base 的池构造:base rollouts 并入候选池,finals 保留", () => {
  const pool = pooled();
  assert.deepEqual(Object.keys(pool).sort(), ["base1", "c1", "c2"]);
  assert.equal(pool["base1"]!.run_id, "r/base1");
  assert.equal(pool["c1"]!.run_id, "r/c1");
  // 原 finals 池未被改写(纯函数,补丁只扩返回值)。
  const finals = { c1: run("c1") };
  const merged = poolWithBase(finals, [run("base1")]);
  assert.deepEqual(Object.keys(finals), ["c1"]);
  assert.deepEqual(Object.keys(merged).sort(), ["base1", "c1"]);
});

test("含 base 的比较 + 选中 base ⟹ 不采纳(chosen_is_base 表达)", async () => {
  await withWork(async (work) => {
    const pool = pooled();
    // 匿名标识由 assign_ids 派生(与 run_selection 同函数同参数);算出
    // base 臂的匿名 id,让选择器"选中 base"。
    const idMap = assign_ids(Object.keys(pool), { task_id: "t-1", k: 2, mode: "seq" });
    const baseAnon = Object.entries(idMap).find(([, label]) => label === "base1")?.[0];
    assert.ok(baseAnon !== undefined, "base 臂须获得匿名标识(在比较池中)");

    const prop = new FakeProposer(async () => [choiceReply(baseAnon), 0, ""]);
    const sel = await run_selection("t-1", 2, "seq", pool, {
      adapter: makeAdapter(),
      prop,
      work_dir: work,
      pool_kind: "finals",
    });
    assert.equal(sel.ok, true);
    assert.equal(sel.n_candidates, 3, "base 保留在比较池中(n_candidates 含 base)");
    assert.equal(sel.chosen_label, "base1");
    // 选中 base ⟹ 不采纳:引擎侧表达为 chosen_is_base,上层据此收口。
    assert.equal(sel.chosen_is_base, true);
  });
});

test("选择器失败回退 base(_fallback)与留池语义不冲突", async () => {
  await withWork(async (work) => {
    const pool = pooled();
    const prop = new FakeProposer(async () => {
      throw new ProposerError("selector exploded");
    });
    const sel = await run_selection("t-2", 2, "seq", pool, {
      adapter: makeAdapter(),
      prop,
      work_dir: work,
      pool_kind: "finals",
    });
    // 留池后 base 仍在池中:_fallback 按 _is_base 标签中立回退 base,
    // fallback 标志置位(fallback 不算采纳候选)。
    assert.equal(sel.fallback, true);
    assert.equal(sel.chosen_label, "base1");
    assert.equal(sel.chosen_is_base, true);
    assert.match(sel.error, /selector exploded/);
  });
});

test("选择器失败且池中无 base:原 finals 回退行为不变(留池不干扰)", async () => {
  await withWork(async (work) => {
    const prop = new FakeProposer(async () => {
      throw new ProposerError("selector exploded");
    });
    const sel = await run_selection("t-3", 2, "seq", { c1: run("c1"), c2: run("c2") }, {
      adapter: makeAdapter(),
      prop,
      work_dir: work,
      pool_kind: "finals",
    });
    assert.equal(sel.fallback, true);
    assert.equal(sel.chosen_is_base, false);
    assert.ok(["c1", "c2"].includes(sel.chosen_label ?? ""), "回退仍在 finals 内");
  });
});

test("trivial_selection 单候选契约未动:多候选(含留池 base)仍拒绝", async () => {
  await withWork(async (work) => {
    await assert.rejects(
      trivial_selection("t-4", 1, "seq", pooled(), {
        adapter: makeAdapter(),
        work_dir: work,
      }),
      (err: unknown) => err instanceof ValueError,
    );
  });
});
