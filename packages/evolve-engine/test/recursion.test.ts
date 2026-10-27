// 任务 6.1 验证:recursion 移植——失败回滚、kept_base、ledger 恒等式、_run_stage 重试。
// tasks.md 显式验证点(recursion 部分):
//   - 胜者写回 base / 失败回滚:提案被拒或通道死亡时 Stage.fell_back=true 且
//     tree 回落到 fallback 的拷贝;
//   - kept_base:接受的树与 fallback 无 diff 时标记 true;
//   - ledger assert_identity:模式跑完后 R/expected_R、P/expected_P 恒等式成立
//     (run_parallel/run_sequential 收尾调用 assert_identity,不抛即证);
//   - _run_stage 重试一次:首次提案校验失败 → 带拒收反馈重试,attempts 记 2。
// 通道执行一律用桩(覆写 call),不 spawn 真实 CLI。
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as context from "../src/context.js";
import { BudgetError, Ledger, expected_rollouts, expected_sessions } from "../src/ledger.js";
import { Proposer, ProposerError, Reply } from "../src/proposer.js";
import * as recursion from "../src/recursion.js";
import {
  makeBenchPrompts,
  makeBenchSpec,
  makeChannelSpec,
  makeRunView,
} from "../src/spec.js";
import type { BenchmarkAdapter, BenchSpec, RunView } from "../src/spec.js";
import * as harness_tree from "../src/tree.js";
import type { Tree } from "../src/tree.js";
import { OPENCODE_SURFACE } from "./fixtures/open-code-surface.js";

const CHANS = {
  proposer: makeChannelSpec({ kind: "claude_cli", model: "claude-x" }),
  selector: makeChannelSpec({ kind: "claude_cli", model: "claude-x" }),
};

function benchSpec(): BenchSpec {
  return makeBenchSpec({
    name: "demo",
    runs_root: "/r",
    install_mode: "workspace_agents_md",
    prompts: makeBenchPrompts({ work: "Sum every signed amounts in a ledger." }),
    channels: CHANS,
  });
}

function makeAdapter(): BenchmarkAdapter {
  return {
    spec: benchSpec(),
    substrate: { name: "oc", surface: () => OPENCODE_SURFACE },
    tasks: async () => ["t1"],
    domain_of: () => "accounting",
    task_prompt: () => "Sum every signed amount in ledger.csv.",
    task_files: async () => null,
    execute: async (_tid, _hdir, run_id) => {
      const dir = join(await fs.mkdtemp(join(tmpdir(), "evolve-recursion-exec-")), run_id.replaceAll("/", "_"));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, "answer.txt"), `ok:${run_id}\n`, "utf8");
      await fs.writeFile(
        join(dir, "trajectory.md"),
        `[ACTION] run\n[OBSERVATION]\nok:${run_id}\n`,
        "utf8",
      );
      return dir;
    },
    delivered: async (run_dir) => {
      try {
        return (await fs.stat(join(run_dir, "answer.txt"))).isFile();
      } catch {
        return false;
      }
    },
    trajectory: async (run_dir) => fs.readFile(join(run_dir, "trajectory.md"), "utf8"),
    deliverable_files: async (run_dir) => ({
      "answer.txt": await fs.readFile(join(run_dir, "answer.txt"), "utf8"),
    }),
    deliverable_text: async (run_dir) => fs.readFile(join(run_dir, "answer.txt"), "utf8"),
    base_harness: async () => join(tmpdir(), "evolve-recursion-base"),
    validate_tree: async (tree) => {
      if (!("scripts/summarize.py" in tree)) {
        throw new Error("The local executor requires scripts/summarize.py");
      }
    },
    score: async () => null,
  };
}

const BASE_TREE: Tree = {
  "systemprompt.md": "Reconcile the ledger using python scripts/summarize.py.\n",
  "guardrails.md": "",
  "LongTermMEMORY.md": "",
  "tool_descriptions/tool_guidance.md": "",
  "scripts/summarize.py": "print('total')\n",
};

/**
 * 脚本化 Proposer:在 workspace(context/harness)上做确定性动作,可观察 mission。
 * label 由 recursion 传成 `${label}.a${attempt}`;attempt 从后缀解析。
 * 不走通道、不走缓存。
 */
class ScriptedProposer extends Proposer {
  readonly seen: { label: string; mission: string }[] = [];
  constructor(
    private readonly apply: (workspace: string, label: string) => Promise<void>,
    private readonly text = "<notes>scripted</notes>",
  ) {
    super(makeChannelSpec({ kind: "claude_cli", model: "claude-x" }));
  }

  override async call(
    mission: string,
    context_dir: string | null,
    label: string,
    _opts: Record<string, unknown> = {},
  ): Promise<Reply> {
    this.seen.push({ label, mission });
    const workspace = join(context_dir as string, "harness");
    await fs.mkdir(join(workspace, "scripts"), { recursive: true });
    await this.apply(workspace, label);
    const reply = new Reply(label, this.text, true, 0, 0, 1, false, "", "", null, workspace);
    this._calls.push(reply);
    return reply;
  }
}

/** 通道死亡的 Proposer:每 call 都抛 ProposerError(成本入账形态)。 */
class DeadProposer extends Proposer {
  constructor() {
    super(makeChannelSpec({ kind: "claude_cli", model: "claude-x" }));
  }
  override async call(
    _mission: string,
    _context_dir: string | null,
    label: string,
  ): Promise<Reply> {
    throw new ProposerError(`channel dead at ${label}`, 2, 0.5);
  }
}

async function writeBase(baseDir: string): Promise<Tree> {
  await fs.rm(baseDir, { recursive: true, force: true });
  await harness_tree.write_tree(OPENCODE_SURFACE, BASE_TREE, baseDir, { stubs: true });
  return harness_tree.read_tree(OPENCODE_SURFACE, baseDir);
}

/** 真实 run 目录(带 trajectory.md/answer.txt),供 context.build 渲染证据。 */
async function mkRun(root: string, label: string): Promise<RunView> {
  const dir = join(root, "runs", label);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "answer.txt"), `ok:${label}\n`, "utf8");
  await fs.writeFile(join(dir, "trajectory.md"), `[ACTION] run\n[OBSERVATION]\nok:${label}\n`, "utf8");
  return makeRunView({
    label,
    run_id: `rid/${label}`,
    run_dir: dir,
    ok: true,
    delivered: true,
  });
}

async function mkRuns(root: string, labels: readonly string[]): Promise<RunView[]> {
  const out: RunView[] = [];
  for (const label of labels) out.push(await mkRun(root, label));
  return out;
}

test("_run_stage:接受的编辑 kept_base=false,notes 从 <notes> 提取", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  const base_dir = await harness_tree.write_tree(
    OPENCODE_SURFACE,
    base_tree,
    join(root, "harnesses", "base"),
  );
  const prop = new ScriptedProposer(async (workspace) => {
    const p = join(workspace, "scripts", "summarize.py");
    await fs.writeFile(p, (await fs.readFile(p, "utf8")) + "# edited\n", "utf8");
  });
  const stage = await recursion._run_stage({
    label: "inv1",
    dim: "INV",
    job: "do the work",
    fallback: base_tree,
    adapter,
    prop,
    ctx_dir: join(root, "context"),
    task_id: "t1",
    rollouts: await mkRuns(root, ["base1"]),
    harness_dir: base_dir,
    library_dir: null,
  });
  assert.equal(stage.fell_back, false);
  assert.equal(stage.kept_base, false);
  assert.equal(stage.notes, "scripted");
  assert.ok((stage.tree["scripts/summarize.py"] as string).includes("# edited"));
  assert.equal(stage.attempts, 1);
});

test("_run_stage:树与 fallback 无 diff → kept_base=true", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  const base_dir = await harness_tree.write_tree(
    OPENCODE_SURFACE,
    base_tree,
    join(root, "harnesses", "base"),
  );
  const prop = new ScriptedProposer(async () => {
    /* 不改任何文件 */
  });
  const stage = await recursion._run_stage({
    label: "inv1",
    dim: "INV",
    job: "do the work",
    fallback: base_tree,
    adapter,
    prop,
    ctx_dir: join(root, "context"),
    task_id: "t1",
    rollouts: await mkRuns(root, ["base1"]),
    harness_dir: base_dir,
    library_dir: null,
  });
  assert.equal(stage.fell_back, false);
  assert.equal(stage.kept_base, true);
});

test("_run_stage:通道死亡(ProposerError)→ fell_back 回滚到 fallback 拷贝", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  const stage = await recursion._run_stage({
    label: "inv1",
    dim: "INV",
    job: "do the work",
    fallback: base_tree,
    adapter,
    prop: new DeadProposer(),
    ctx_dir: join(root, "context"),
    task_id: "t1",
    rollouts: await mkRuns(root, ["base1"]),
    harness_dir: null,
    library_dir: null,
  });
  assert.equal(stage.fell_back, true);
  assert.deepEqual(stage.tree, base_tree);
  assert.ok(stage.error.includes("channel dead at inv1.a1"), stage.error);
  // ProposerError(attempts=2, cost=0.5) 的成本入账
  assert.equal(stage.attempts, 2);
  assert.equal(stage.usd, 0.5);
});

test("_run_stage:校验失败 → 带拒收反馈重试一次,attempts 记 2", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  const base_dir = await harness_tree.write_tree(
    OPENCODE_SURFACE,
    base_tree,
    join(root, "harnesses", "base"),
  );
  const prop = new ScriptedProposer(async (workspace, label) => {
    const p = join(workspace, "scripts", "summarize.py");
    if (label.endsWith(".a1")) {
      // 删掉必须文件 → adapter.validate_tree 抛错 → 重试
      await fs.rm(p, { force: true });
    } else {
      await fs.writeFile(p, "print('fixed')\n", "utf8");
    }
  });
  const stage = await recursion._run_stage({
    label: "dom1",
    dim: "DOM",
    job: "do the work",
    fallback: base_tree,
    adapter,
    prop,
    ctx_dir: join(root, "context"),
    task_id: "t1",
    rollouts: await mkRuns(root, ["base1"]),
    harness_dir: base_dir,
    library_dir: null,
  });
  assert.equal(stage.fell_back, false);
  assert.equal(stage.attempts, 2);
  assert.equal(prop.seen.length, 2);
  assert.ok(
    prop.seen[1]?.mission.includes("YOUR PREVIOUS ATTEMPT WAS REJECTED"),
    prop.seen[1]?.mission.slice(0, 200),
  );
  assert.equal(stage.error, "");
  assert.equal(stage.tree["scripts/summarize.py"], "print('fixed')\n");
});

test("run_parallel:finals=agg1..aggk,ledger 恒等式成立,rollouts 覆盖全部标签", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  const prop = new ScriptedProposer(async (workspace) => {
    const p = join(workspace, "scripts", "summarize.py");
    await fs.writeFile(p, (await fs.readFile(p, "utf8")) + "# edited\n", "utf8");
  });
  const base = await mkRuns(root, ["base1", "base2"]);
  const result = await recursion.run_parallel("t1", 2, base, {
    adapter,
    prop,
    work_dir: join(root, "work"),
    run_id_of: (lbl) => `rid/${lbl}`,
    base_tree,
  });
  assert.deepEqual(result.finals, ["agg1", "agg2"]);
  assert.equal(result.ok, true);
  const labels = Object.keys(result.rollouts).sort();
  assert.deepEqual(labels, ["agg1", "agg2", "base1", "base2", "dom1", "dom2", "inv1", "inv2"]);
  const led = result.ledger as Ledger;
  assert.equal(led.R, expected_rollouts(2));
  assert.equal(led.P, expected_sessions(2));
  // k=2:base 2 + 4 提案 rollout + 2 agg rollout
  assert.equal(led.R, 8);
  // 提案 4 会话 + 聚合 2 会话
  assert.equal(led.P, 6);
  led.assert_identity();
  assert.equal(result.similarity?.n, 2);
});

test("run_sequential:finals=c1..ck,kept_base 于无编辑的后续轮,ledger 恒等式成立", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  // 只在 summarize.py 尚无 "# edited" 时编辑;之后的提案都是 no-op → kept_base
  const prop = new ScriptedProposer(async (workspace) => {
    const p = join(workspace, "scripts", "summarize.py");
    const body = await fs.readFile(p, "utf8");
    if (!body.includes("# edited")) {
      await fs.writeFile(p, body + "# edited\n", "utf8");
    }
  });
  const base = await mkRuns(root, ["base1", "base2"]);
  const result = await recursion.run_sequential("t1", 2, base, {
    adapter,
    prop,
    work_dir: join(root, "work"),
    run_id_of: (lbl) => `rid/${lbl}`,
    base_tree,
  });
  assert.deepEqual(result.finals, ["c1", "c2"]);
  assert.equal(result.ok, true);
  // 第 1 轮:inv1/dom1/c1 相对 base 有编辑(kept_base=false);第 2 轮 fallback 是
  // current_harness(已带编辑)→ no-op 即 kept_base=true。
  const kept = result.stages.filter((s) => s.kept_base).map((s) => s.label);
  assert.deepEqual(kept.sort(), ["c2", "dom2", "inv2"]);
  const led = result.ledger as Ledger;
  assert.equal(led.R, expected_rollouts(2));
  assert.equal(led.P, expected_sessions(2));
  led.assert_identity();
});

test("run_mode:未知 mode 抛 ValueError(文案与 Python 对齐)", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  const base = await mkRuns(root, ["base1"]);
  await assert.rejects(
    () =>
      recursion.run_mode("bogus", "t1", 1, base, {
        adapter,
        prop: new ScriptedProposer(async () => undefined),
        work_dir: join(root, "work"),
        run_id_of: (lbl) => `rid/${lbl}`,
        base_tree,
      }),
    (exc: unknown) => {
      assert.ok(exc instanceof Error);
      assert.equal(exc.constructor.name, "ValueError");
      assert.ok(exc.message.includes("unknown mode 'bogus'"));
      assert.ok(exc.message.includes("'agg' (parallel) and 'seq' (sequential)"));
      return true;
    },
  );
});

test("Ledger.assert_identity:预算被破坏时抛 BudgetError", async () => {
  const led = new Ledger("agg", "t1", 1);
  led.rollout("base1");
  // R=1 但 want 4(k=1),P=0 但 want 3
  assert.throws(
    () => led.assert_identity(),
    (exc: unknown) => {
      assert.ok(exc instanceof BudgetError);
      assert.ok(exc.message.includes("R=1 (want 4)"));
      assert.ok(exc.message.includes("P=0 (want 3)"));
      return true;
    },
  );
});

test("context.build 全部轨迹渲染失败:_run_stage 的 build 失败 → fell_back 且 error 前缀 could not build evidence", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "evolve-rec-"));
  const base_tree = await writeBase(join(root, "base"));
  const adapter = makeAdapter();
  const prop = new ScriptedProposer(async () => undefined);
  // rollouts 指向不存在的 run_dir → 全部轨迹渲染失败 → build 抛错
  const bad = makeRunView({
    label: "base1",
    run_id: "rid/base1",
    run_dir: join(root, "nope"),
    ok: true,
    delivered: true,
  });
  const stage = await recursion._run_stage({
    label: "inv1",
    dim: "INV",
    job: "do the work",
    fallback: base_tree,
    adapter,
    prop,
    ctx_dir: join(root, "context"),
    task_id: "t1",
    rollouts: [bad],
    harness_dir: null,
    library_dir: null,
  });
  assert.equal(stage.fell_back, true);
  assert.ok(stage.error.startsWith("could not build evidence:"), stage.error);
  assert.deepEqual(stage.tree, base_tree);
});

// context 的 grader 绊线经 _accept_tree 会被拒;此处仅确认模块接线存在。
test("模块接线:context.assert_tree_has_no_grader_verdicts 可用", () => {
  assert.equal(typeof context.assert_tree_has_no_grader_verdicts, "function");
});
