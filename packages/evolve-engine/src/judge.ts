// judge.ts — harness2/core/judge.py(155 行)的逐行移植。
// 度量 selection 选中的那次运行,发生在选择之后。方法主链路不 import 本模块。
// 核心不变量:judge 失败 = None,永不是 0;None 不进分母。
//
// 逐条对照:
//   Scored dataclass → Scored 类(字段同序;n_passed/n_criteria 默认 null ↔ None;
//                      graded/frac 为 getter ↔ Python property)
//   _mode_of(sel)    → _modeOf:优先 "mode" 键,缺省读 legacy "arm",再缺省 ""
//   judge_one        → judgeOne:score 抛错 → error = "<类型名>: <消息>",n_* 保持 null;
//                      score 返回空 → error = "judge returned nothing";
//                      all_pass 缺省 = graded && n_passed === n_criteria
//   judge_selections → judgeSelections:选择未完成的条目直接记 error,不进评分;
//                      并发池上限 parallel(默认 8);单个评分异常只落该条目的 error
//   write(rows,path) → write:每行 = 字段序 + frac + graded,JSON indent=2,建父目录
//
// 显式有界偏差(已在头注释记录,不算静默):
//   1. as_completed 的"完成序"在 Python 本就未指定;TS 侧聚合为提交序(Promise 并发池),
//      与 tasks 6.1"聚合顺序显式化"一致。
//   2. 异常类型名:Python type(exc).__name__(如 "ValueError")在 JS 侧取
//      e.constructor.name(如 "TypeError"/"Error");只影响 error 文案,不影响 None 语义。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ScoreDict {  n_passed?: number | null;
  n_criteria?: number | null;
  all_pass?: boolean;
  [key: string]: unknown;
}

/** 评分入口的结构化最小声明;任务 4.1 落地 spec.BenchmarkAdapter 时与之对齐。 */
export interface JudgeAdapter {
  score(runDir: string, taskId: string): Promise<ScoreDict | null>;
}

export class Scored {
  readonly task_id: string;
  readonly mode: string;
  readonly k: number;
  readonly label: string;
  readonly run_id: string;
  readonly chosen_is_base: boolean;
  n_passed: number | null = null;
  n_criteria: number | null = null;
  all_pass = false;
  raw: Record<string, unknown> = {};
  error = "";

  constructor(input: {
    task_id: string;
    mode: string;
    k: number;
    label: string;
    run_id: string;
    chosen_is_base: boolean;
  }) {
    this.task_id = input.task_id;
    this.mode = input.mode;
    this.k = input.k;
    this.label = input.label;
    this.run_id = input.run_id;
    this.chosen_is_base = input.chosen_is_base;
  }

  /** judge 是否成功(不是这次运行表现好不好)。 */
  get graded(): boolean {
    return this.n_criteria !== null && this.n_criteria > 0;
  }

  get frac(): number | null {
    return this.graded ? (this.n_passed as number) / (this.n_criteria as number) : null;
  }
}

export interface SelectionRecord {
  task_id?: string;
  mode?: string;
  arm?: string;
  k?: number;
  ok?: boolean;
  chosen_label?: string;
  chosen_run_id?: string;
  chosen_run_dir?: string;
  chosen_is_base?: boolean;
  [key: string]: unknown;
}

function _modeOf(sel: SelectionRecord): string {
  if ("mode" in sel && sel.mode !== undefined) return String(sel.mode);
  return String(sel.arm ?? "");
}

function _errorText(exc: unknown): string {
  if (exc instanceof Error) return `${exc.constructor.name}: ${exc.message}`;
  return `Error: ${String(exc)}`;
}

export async function judgeOne(
  adapter: JudgeAdapter,
  task_id: string,
  mode: string,
  k: number,
  label: string,
  run_id: string,
  runDir: string,
  opts: { chosen_is_base?: boolean } = {},
): Promise<Scored> {
  const s = new Scored({
    task_id,
    mode,
    k,
    label,
    run_id,
    chosen_is_base: opts.chosen_is_base ?? false,
  });
  let got: ScoreDict | null;
  try {
    got = await adapter.score(runDir, task_id);
  } catch (exc) {
    s.error = _errorText(exc);
    return s;
  }
  if (!got) {
    s.error = "judge returned nothing";
    return s;
  }
  s.raw = { ...got };
  s.n_passed = got.n_passed ?? null;
  s.n_criteria = got.n_criteria ?? null;
  s.all_pass = Boolean(got.all_pass ?? (s.graded && s.n_passed === s.n_criteria));
  return s;
}

export async function judgeSelections(
  adapter: JudgeAdapter,
  selections: readonly SelectionRecord[],
  opts: { parallel?: number } = {},
): Promise<Scored[]> {
  const parallel = opts.parallel ?? 8;
  const out: Scored[] = [];
  const pending: Array<() => Promise<Scored>> = [];
  for (const sel of selections) {
    const rd = sel.chosen_run_dir;
    if (!sel.ok || !sel.chosen_label || !rd) {
      out.push(
        Object.assign(
          new Scored({
            task_id: sel.task_id ?? "",
            mode: _modeOf(sel),
            k: sel.k ?? 0,
            label: sel.chosen_label ?? "",
            run_id: sel.chosen_run_id ?? "",
            chosen_is_base: Boolean(sel.chosen_is_base),
          }),
          { error: "selection did not complete successfully" },
        ),
      );
      continue;
    }
    const k = sel.k ?? 0;
    const chosenLabel = sel.chosen_label;
    const chosenIsBase = Boolean(sel.chosen_is_base);
    pending.push(() =>
      judgeOne(
        adapter,
        sel.task_id ?? "",
        _modeOf(sel),
        k,
        chosenLabel,
        sel.chosen_run_id ?? "",
        rd,
        { chosen_is_base: chosenIsBase },
      ).catch((exc: unknown) =>
        Object.assign(
          new Scored({
            task_id: sel.task_id ?? "",
            mode: _modeOf(sel),
            k,
            label: sel.chosen_label ?? "",
            run_id: sel.chosen_run_id ?? "",
            chosen_is_base: chosenIsBase,
          }),
          { error: _errorText(exc) },
        ),
      ),
    );
  }
  // 提交序聚合(显式有界偏差 1);并发上限 parallel 的简单工人池。
  const results: Scored[] = new Array(pending.length) as Scored[];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < pending.length) {
      const i = next++;
      results[i] = await pending[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, worker));
  out.push(...results);
  return out;
}

export async function write(rows: readonly Scored[], path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const body = rows.map((r) => ({
    task_id: r.task_id,
    mode: r.mode,
    k: r.k,
    label: r.label,
    run_id: r.run_id,
    chosen_is_base: r.chosen_is_base,
    n_passed: r.n_passed,
    n_criteria: r.n_criteria,
    all_pass: r.all_pass,
    raw: r.raw,
    error: r.error,
    frac: r.frac,
    graded: r.graded,
  }));
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  return path;
}
