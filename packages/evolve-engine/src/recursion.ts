// recursion.ts — harness2/core/recursion.py(578 行)的逐行移植。
// Parallel and sequential task-level recursion:每种 mode 调度 4k rollouts 与
// 3k improvement stages(含共享 base 执行);无效提案重试一次后回退到当前 harness。
//
// 逐条对照:
//   Stage / ModeResult(dataclass)     → 可变类;to_dict 键序 = Python 字面量序
//   _accept_tree                       → _accept_tree:autotrigger 打印、diff_summary
//                                        判 kept、validate + validate_tree +
//                                        assert_tree_has_no_grader_verdicts;
//                                        Python except ValueError → TS catch Error
//                                        (tree.validate 与 context 断言在 TS 抛 Error;
//                                        文本取 e.message ≡ str(exc))。err 文本中的
//                                        `type(exc).__name__` → `constructor.name`。
//   _run_stage                         → _run_stage:STAGE_ATTEMPTS=2 轮;
//                                        ProposerError → 记账后 break(失败收口);
//                                        workspace 缺/空树/越界文件/校验失败四类
//                                        反馈文案逐字保留;接受后 notes 取
//                                        <notes>([\s\S]*?)</notes> 非贪婪捕获组 1。
//   _record_sessions                   → _record_sessions:池排空后按序记 ledger。
//   _roll                              → _roll(async):树非空先 write_tree 到
//                                        harnesses/<label>;execute 异常 → RunView
//                                        (run_dir=work_dir/missing)不抛出;ledger
//                                        按 record 决定是否补记。
//   _roll_many                         → _roll_many:mapPool(items, width)(保提交序);
//                                        池排空后按 items 顺序补 ledger.rollout
//                                        ("a concurrent run records the same sequence
//                                        of labels as a serial one")。n==1 不特判。
//   ThreadPoolExecutor(...).map        → mapPool(见 pool.ts:保序聚合)
//   run_parallel / run_sequential      → 同名异步函数;stage 结果顺序即提交序(specs 序),
//                                        与 Python list(pool.map(...)) 一致
//   run_mode                           → run_mode:ValueError 文案逐字;TS 抛 ValueError
//                                        (selection 的具名子类)保持 constructor.name。
//
// 环境差异(已记录):
// - Python 的 except ValueError / Exception 捕获面在 TS 是 Error;文本路径 `ValueError`
//   字样在 TS 呈现为 `Error`(constructor.name),属元数据级偏差,不影响 golden 对照
//   (golden 运行无错误文案)。
// - err[:400] 为 Python 码点切片;TS String.slice 按 UTF-16 单元 —— 错误文本均为
//   ASCII 时逐字节一致。
// - ledger 的 usd 记账与 Python 同(0 默认)。

import * as fs from "node:fs/promises";
import { join } from "node:path";

import { build, mission, assert_tree_has_no_grader_verdicts } from "./context.js";
import { Ledger } from "./ledger.js";
import { mapPool } from "./pool.js";
import * as prompts from "./prompts.js";
import { Proposer, ProposerError } from "./proposer.js";
import { pyRepr } from "./pyutil.js";
import type { BenchmarkAdapter, RunView } from "./spec.js";
import { resolve_prompts } from "./spec.js";
import * as harness_tree from "./tree.js";
import type { Diversity, Tree } from "./tree.js";
import { ValueError } from "./selection.js";

export const STAGE_ATTEMPTS = 2;
// harness2/config.py:177 / :176(模块常量,无环境覆盖)。
export const TRANSPORT_ATTEMPTS = 2;
export const PHASE_WIDTH = 2;

/** 池候选:(label, 候选 harness 目录, 该候选的 rollout)。 */
export type PoolItem = readonly [string, string, RunView | null];

export class Stage {
  label: string;
  dim: string;
  tree: Tree;
  kept_base: boolean;
  fell_back: boolean;
  error: string;
  usd: number;
  attempts: number;
  cached: boolean;
  notes: string;

  constructor(input: {
    label: string;
    dim: string;
    tree: Tree;
    kept_base?: boolean;
    fell_back?: boolean;
    error?: string;
    usd?: number;
    attempts?: number;
    cached?: boolean;
    notes?: string;
  }) {
    this.label = input.label;
    this.dim = input.dim;
    this.tree = input.tree;
    this.kept_base = input.kept_base ?? false;
    this.fell_back = input.fell_back ?? false;
    this.error = input.error ?? "";
    this.usd = input.usd ?? 0.0;
    this.attempts = input.attempts ?? 0;
    this.cached = input.cached ?? false;
    this.notes = input.notes ?? "";
  }

  to_dict(): Record<string, unknown> {
    return {
      label: this.label,
      dim: this.dim,
      fell_back: this.fell_back,
      kept_base: this.kept_base,
      attempts: this.attempts,
      usd: this.usd,
      cached: this.cached,
      notes: this.notes,
      error: (this.error || "").slice(0, 400),
    };
  }
}

export class ModeResult {
  mode: string;
  task_id: string;
  k: number;
  stages: Stage[] = [];
  trees: Record<string, Tree> = {};
  rollouts: Record<string, RunView> = {};
  finals: string[] = [];
  ledger: Ledger | null = null;
  similarity: Diversity | null = null;
  errors: string[] = [];

  constructor(mode: string, task_id: string, k: number, opts: { ledger?: Ledger | null } = {}) {
    this.mode = mode;
    this.task_id = task_id;
    this.k = k;
    this.ledger = opts.ledger ?? null;
  }

  get ok(): boolean {
    return this.finals.length > 0 && this.errors.length === 0;
  }

  get fell_back(): string[] {
    return this.stages.filter((s) => s.fell_back).map((s) => s.label);
  }

  to_dict(): Record<string, unknown> {
    return {
      mode: this.mode,
      task_id: this.task_id,
      k: this.k,
      finals: this.finals,
      ok: this.ok,
      fell_back: this.fell_back,
      kept_base: this.stages.filter((s) => s.kept_base).map((s) => s.label),
      stages: this.stages.map((s) => s.to_dict()),
      similarity: this.similarity,
      ledger: this.ledger ? this.ledger.to_dict() : null,
      errors: this.errors,
    };
  }
}

function errName(exc: unknown): string {
  return exc instanceof Error ? exc.constructor.name : typeof exc;
}

function errText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Repair then validate a proposed tree:(kept_base, "") if accepted, else the error. */
async function _accept_tree(
  surface: harness_tree.SurfaceSpec,
  adapter: BenchmarkAdapter,
  newTree: Tree,
  fallback: Tree,
  label: string,
): Promise<{ kept: boolean; err: string }> {
  const triggered = harness_tree.autotrigger(surface, newTree);
  if (triggered.length > 0) {
    console.log(`  [${label}] auto-triggered skill(s): ${triggered.join(", ")}`);
  }
  const changed = harness_tree.diff_summary(surface, fallback, newTree);
  const kept = !(changed.added.length || changed.removed.length || changed.modified.length);
  try {
    await harness_tree.validate(surface, newTree, {
      allow_subagents: adapter.spec.allow_subagents,
      reserved_scripts: new Set([...harness_tree.RESERVED_SCRIPTS, ...adapter.spec.reserved_scripts]),
    });
    await adapter.validate_tree(newTree);
    assert_tree_has_no_grader_verdicts(newTree);
  } catch (exc) {
    return { kept, err: errText(exc) };
  }
  return { kept, err: "" };
}

export interface RunStageOpts {
  label: string;
  dim: string;
  job: string;
  fallback: Tree;
  adapter: BenchmarkAdapter;
  prop: Proposer;
  ctx_dir: string;
  task_id: string;
  rollouts: readonly RunView[];
  harness_dir: string | null;
  library_dir: string | null;
  pool?: readonly PoolItem[];
  decisions?: Readonly<Record<string, string>> | null;
}

/** Build evidence, propose an edit, and retry an invalid proposal once. */
export async function _run_stage(opts: RunStageOpts): Promise<Stage> {
  const {
    label,
    dim,
    job,
    fallback,
    adapter,
    prop,
    ctx_dir,
    task_id,
    rollouts,
    harness_dir,
    library_dir,
  } = opts;
  const pool = opts.pool ?? [];
  const decisions = opts.decisions ?? null;
  const surface = adapter.substrate.surface();

  let tree: Awaited<ReturnType<typeof build>>;
  let missionText: string;
  try {
    tree = await build(join(ctx_dir, label), adapter, task_id, rollouts, {
      harness_dir,
      library_dir,
      pool,
      decisions,
    });
    missionText = mission(tree, { job });
  } catch (exc) {
    return new Stage({
      label,
      dim,
      tree: { ...fallback },
      fell_back: true,
      error: `could not build evidence: ${errName(exc)}: ${errText(exc)}`.slice(0, 400),
      attempts: 0,
    });
  }

  let err = "";
  let spent_usd = 0.0;
  let spent_calls = 0;
  let all_cached = true;
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    let reply;
    try {
      reply = await prop.call(
        missionText +
          (err
            ? `\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${err}\n\n` +
              "Fix it in `context/harness/` and reply again."
            : ""),
        tree.root,
        `${label}.a${attempt}`,
        { harvest: "context/harness", max_attempts: TRANSPORT_ATTEMPTS },
      );
    } catch (exc) {
      if (exc instanceof ProposerError) {
        err = errText(exc);
        spent_calls += exc.attempts || TRANSPORT_ATTEMPTS;
        spent_usd += exc.cost_usd;
        all_cached = false;
        break;
      }
      throw exc;
    }
    spent_usd += reply.cost_usd;
    spent_calls += reply.cached ? 0 : Math.max(1, reply.attempts);
    all_cached = all_cached && reply.cached;

    if (reply.workspace === null || reply.workspace === undefined) {
      err =
        "the harness directory did not come back from the session; edit the files " +
        "in `context/harness/` in place";
      continue;
    }
    const rejected: string[] = [];
    const newTree = await harness_tree.read_tree(surface, reply.workspace, { rejected });
    if (Object.keys(newTree).length === 0) {
      err = "`context/harness/` came back empty -- edit the files, do not delete them all";
      continue;
    }
    if (rejected.length > 0) {
      err =
        "these files are off the editable surface and were not applied: " +
        [...rejected].sort().slice(0, 6).join(", ") +
        ". Component names must be lowercase letters, digits, `_` or `-` " +
        `(e.g. \`${surface.skill_dir}/doc_review/SKILL.md\`, ` +
        "`scripts/check_totals.py`).";
      continue;
    }

    const { kept, err: acceptErr } = await _accept_tree(surface, adapter, newTree, fallback, label);
    err = acceptErr;
    if (err) {
      await harness_tree.write_tree(surface, newTree, join(tree.root, "harness"));
      continue;
    }
    const notesMatch = /<notes>([\s\S]*?)<\/notes>/.exec(reply.text);
    return new Stage({
      label,
      dim,
      tree: newTree,
      kept_base: kept,
      usd: spent_usd,
      attempts: spent_calls,
      cached: all_cached,
      notes: notesMatch ? (notesMatch[1] as string).trim() : reply.text.trim(),
    });
  }

  return new Stage({
    label,
    dim,
    tree: { ...fallback },
    fell_back: true,
    error: err.slice(0, 400),
    usd: spent_usd,
    attempts: spent_calls,
    cached: all_cached,
  });
}

/** Record stages in stable order after their concurrent phase finishes. */
function _record_sessions(ledger: Ledger, stages: readonly Stage[]): void {
  for (const stage of stages) {
    ledger.session(stage.label, stage.usd, { cached: stage.cached, attempts: stage.attempts });
  }
}

/** Materialise a harness and roll it once. A dead rollout is recorded, never raised. */
async function _roll(
  adapter: BenchmarkAdapter,
  ledger: Ledger,
  task_id: string,
  label: string,
  tree: Tree | null,
  run_id_of: (label: string) => string,
  work_dir: string,
  opts: { record?: boolean } = {},
): Promise<RunView> {
  const record = opts.record ?? true;
  let hdir: string | null = null;
  if (tree !== null) {
    hdir = await harness_tree.write_tree(
      adapter.substrate.surface(),
      tree,
      join(work_dir, "harnesses", label),
    );
  }
  const run_id = run_id_of(label);
  let rv: RunView;
  try {
    const rd = await adapter.execute(task_id, hdir, run_id);
    const exists = await pathExists(rd);
    rv = {
      label,
      run_id,
      run_dir: rd,
      ok: exists,
      delivered: exists && (await adapter.delivered(rd)),
      cost_usd: 0.0,
      wall_s: 0.0,
      error: exists ? "" : "adapter returned a missing run directory",
    };
  } catch (exc) {
    rv = {
      label,
      run_id,
      run_dir: join(work_dir, "missing"),
      ok: false,
      delivered: false,
      cost_usd: 0.0,
      wall_s: 0.0,
      error: `${errName(exc)}: ${errText(exc)}`,
    };
  }
  if (record) {
    ledger.rollout(label);
  }
  return rv;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Roll independent harnesses concurrently, then record them in the caller's order.
 * The ledger is written after the pool drains, so a concurrent run records the same
 * sequence of labels as a serial one.
 */
async function _roll_many(
  adapter: BenchmarkAdapter,
  ledger: Ledger,
  task_id: string,
  items: readonly (readonly [string, Tree])[],
  run_id_of: (label: string) => string,
  work_dir: string,
  opts: { width: number },
): Promise<Record<string, RunView>> {
  const out: Record<string, RunView> = {};
  if (items.length === 0) return out;
  const n = Math.max(1, Math.min(items.length, Math.trunc(opts.width)));
  if (n === 1) {
    for (const [label, tree] of items) {
      out[label] = await _roll(adapter, ledger, task_id, label, tree, run_id_of, work_dir, {
        record: true,
      });
    }
    return out;
  }
  const got = await mapPool(items, n, (it) =>
    _roll(adapter, ledger, task_id, it[0], it[1], run_id_of, work_dir, { record: false }),
  );
  for (let i = 0; i < items.length; i++) {
    const [label] = items[i] as readonly [string, Tree];
    ledger.rollout(label);
    out[label] = got[i] as RunView;
  }
  return out;
}

export interface RunModeOpts {
  adapter: BenchmarkAdapter;
  prop: Proposer;
  work_dir: string;
  run_id_of: (label: string) => string;
  base_tree: Tree;
  library_dir?: string | null;
  propose_workers?: number;
  rollout_workers?: number;
}

/** WIDTH: 2k iid candidates from shared evidence, then k INDEPENDENT compositions. */
export async function run_parallel(
  task_id: string,
  k: number,
  base: readonly RunView[],
  opts: RunModeOpts,
): Promise<ModeResult> {
  const {
    adapter,
    prop,
    work_dir,
    run_id_of,
    base_tree,
    library_dir = null,
    propose_workers = PHASE_WIDTH,
    rollout_workers = PHASE_WIDTH,
  } = opts;
  const surface = adapter.substrate.surface();
  const ledger = new Ledger("agg", task_id, k);
  for (const r of base) {
    ledger.rollout(r.label);
  }
  const result = new ModeResult("agg", task_id, k, { ledger });
  for (const r of base) {
    result.rollouts[r.label] = r;
  }
  const ctx_dir = join(work_dir, "context");
  const benchmark_prompts = resolve_prompts(adapter, task_id);
  const base_dir = await harness_tree.write_tree(surface, base_tree, join(work_dir, "harnesses", "base"));

  const specs: (readonly [string, string, number])[] = [];
  for (let i = 1; i <= k; i++) {
    for (const d of ["INV", "DOM"]) {
      specs.push([`${d.toLowerCase()}${i}`, d, i]);
    }
  }
  const stages = await mapPool(specs, Math.min(specs.length, propose_workers), (s) =>
    _run_stage({
      label: s[0],
      dim: s[1],
      job: prompts.propose(benchmark_prompts, s[1], surface, { k, index: s[2] }),
      fallback: base_tree,
      adapter,
      prop,
      ctx_dir,
      task_id,
      rollouts: base,
      harness_dir: base_dir,
      library_dir,
    }),
  );
  _record_sessions(ledger, stages);
  for (const stage of stages) {
    result.stages.push(stage);
    result.trees[stage.label] = stage.tree;
  }
  Object.assign(
    result.rollouts,
    await _roll_many(
      adapter,
      ledger,
      task_id,
      stages.map((stage) => [stage.label, stage.tree] as const),
      run_id_of,
      work_dir,
      { width: rollout_workers },
    ),
  );

  const pool_ev: PoolItem[] = stages.map((stage) => [
    stage.label,
    join(work_dir, "harnesses", stage.label),
    result.rollouts[stage.label] ?? null,
  ]);
  const agg_specs = Array.from({ length: k }, (_, i) => `agg${i + 1}`);
  const aggs = await mapPool(agg_specs, Math.min(agg_specs.length, propose_workers), (lbl) =>
    _run_stage({
      label: lbl,
      dim: "AGG",
      job: prompts.aggregate(benchmark_prompts, surface, { k, index: Number(lbl.slice(3)) }),
      fallback: base_tree,
      adapter,
      prop,
      ctx_dir,
      task_id,
      rollouts: base,
      harness_dir: base_dir,
      library_dir,
      pool: pool_ev,
      decisions: Object.fromEntries(
        stages.map((stage) => [stage.label, stage.notes || stage.error]),
      ),
    }),
  );
  _record_sessions(ledger, aggs);
  for (const stage of aggs) {
    result.stages.push(stage);
    result.trees[stage.label] = stage.tree;
    result.finals.push(stage.label);
  }
  Object.assign(
    result.rollouts,
    await _roll_many(
      adapter,
      ledger,
      task_id,
      aggs.map((stage) => [stage.label, stage.tree] as const),
      run_id_of,
      work_dir,
      { width: rollout_workers },
    ),
  );

  result.similarity = harness_tree.diversity(
    Object.fromEntries(aggs.map((s) => [s.label, s.tree])),
  );
  ledger.assert_identity();
  return result;
}

/** DEPTH: k nested passes over the same shared base evidence. */
export async function run_sequential(
  task_id: string,
  k: number,
  base: readonly RunView[],
  opts: RunModeOpts,
): Promise<ModeResult> {
  const {
    adapter,
    prop,
    work_dir,
    run_id_of,
    base_tree,
    library_dir = null,
    propose_workers = 2,
    rollout_workers = PHASE_WIDTH,
  } = opts;
  const surface = adapter.substrate.surface();
  const ledger = new Ledger("seq", task_id, k);
  for (const r of base) {
    ledger.rollout(r.label);
  }
  const result = new ModeResult("seq", task_id, k, { ledger });
  for (const r of base) {
    result.rollouts[r.label] = r;
  }
  const ctx_dir = join(work_dir, "context");
  const benchmark_prompts = resolve_prompts(adapter, task_id);

  let current_harness: Tree = { ...base_tree };
  let history: PoolItem[] = [];
  for (let t = 1; t <= k; t++) {
    const current_label = t > 1 ? `c${t - 1}` : "base";
    const current_dir = await harness_tree.write_tree(
      surface,
      current_harness,
      join(work_dir, "harnesses", current_label),
    );
    const specs: (readonly [string, string])[] = [
      [`inv${t}`, "INV"],
      [`dom${t}`, "DOM"],
    ];
    const stages = await mapPool(specs, Math.min(2, propose_workers), (s) =>
      _run_stage({
        label: s[0],
        dim: s[1],
        job: prompts.propose(benchmark_prompts, s[1], surface, {
          k,
          index: t,
          round_t: k > 1 ? t : null,
        }),
        fallback: current_harness,
        adapter,
        prop,
        ctx_dir,
        task_id,
        rollouts: base,
        harness_dir: current_dir,
        library_dir,
        pool: [...history],
        decisions: Object.fromEntries(
          result.stages.map((stage) => [stage.label, stage.notes || stage.error]),
        ),
      }),
    );
    _record_sessions(ledger, stages);
    for (const stage of stages) {
      result.stages.push(stage);
      result.trees[stage.label] = stage.tree;
    }
    Object.assign(
      result.rollouts,
      await _roll_many(
        adapter,
        ledger,
        task_id,
        stages.map((stage) => [stage.label, stage.tree] as const),
        run_id_of,
        work_dir,
        { width: rollout_workers },
      ),
    );

    const round_pool: PoolItem[] = [
      ...history,
      ...stages.map(
        (stage) =>
          [stage.label, join(work_dir, "harnesses", stage.label), result.rollouts[stage.label] ?? null] as const,
      ),
    ];
    const ck = `c${t}`;

    const comp_job =
      k === 1
        ? prompts.aggregate(benchmark_prompts, surface, { k: 1, index: 1 })
        : prompts.compose_round(benchmark_prompts, surface, { t, k });
    const comp = await _run_stage({
      label: ck,
      dim: "COMPOSE",
      job: comp_job,
      fallback: current_harness,
      adapter,
      prop,
      ctx_dir,
      task_id,
      rollouts: base,
      harness_dir: current_dir,
      library_dir,
      pool: round_pool,
      decisions: Object.fromEntries(
        result.stages.map((stage) => [stage.label, stage.notes || stage.error]),
      ),
    });
    _record_sessions(ledger, [comp]);
    result.stages.push(comp);
    result.trees[ck] = comp.tree;
    result.rollouts[ck] = await _roll(adapter, ledger, task_id, ck, comp.tree, run_id_of, work_dir);

    history = [...round_pool, [ck, join(work_dir, "harnesses", ck), result.rollouts[ck] ?? null] as const];
    current_harness = comp.tree;
  }

  result.finals = Array.from({ length: k }, (_, i) => `c${i + 1}`);
  ledger.assert_identity();
  return result;
}

export interface RunParallelArgs {
  adapter: BenchmarkAdapter;
  prop: Proposer;
  work_dir: string;
  run_id_of: (label: string) => string;
  base_tree: Tree;
  library_dir?: string | null;
  propose_workers?: number;
  rollout_workers?: number;
}

/** Dispatch on the on-disk mode token: "agg" (parallel) or "seq" (sequential). */
export async function run_mode(
  mode: string,
  task_id: string,
  k: number,
  base: readonly RunView[],
  opts: RunParallelArgs,
): Promise<ModeResult> {
  if (mode === "agg") return run_parallel(task_id, k, base, opts);
  if (mode === "seq") return run_sequential(task_id, k, base, opts);
  throw new ValueError(
    `unknown mode ${pyRepr(mode)}; the method has exactly two: ` +
      "'agg' (parallel) and 'seq' (sequential)",
  );
}
