// report.ts — harness2/core/report.py(165 行)的逐行移植。
// Judged selections → the figure each benchmark reports, plus pick provenance and
// warnings. Ungraded rows and tasks that never completed are excluded from the
// denominator rather than counted as failures.
//
// 逐条对照:
//   Summary(dataclass)   → 可变类(同字段序);name/line 方法保留
//   _kind                → _kind:agg 以 "agg" 前缀为 final;seq 的 final 集合是
//                          c1..c{k};base* 前缀恒为 base
//   summarise            → summarise:st.mean(算术平均)→ 均值;round(x,2)→pyRound
//   render               → render:排序 (k, mode);k=1 噪底注、chose_final ≤ 0.25n /
//                          kept_base ≥ 0.8n / fell_back / mixed-units 四类 WARNING
//
// 环境差异(已记录):
// - Python 的 (mode, k) 元组键字典(fell_back/usd)在 TS 用文档化字符串键:
//   summaryKey(mode, k) = `${mode}|${k}`(模式名不含 '|',与 ns 的路径 token 同字符
//   集;单射)。调用方(打分管线,阶段二)按此构造 map。
// - `f"{x:6.2f}"` / `f"{x:5.1f}"` → toFixed + padStart(浮点格式化与 Python
//   round-half-even 在 .005 边界可能有 1 ulp 级差异;golden 不覆盖 report 浮点打印,
//   单元测试用可精确表示的值)。
// - len(title) 码点 → [...title].length。

import type { Scored } from "./judge.js";
import { pyRound } from "./pyutil.js";
import { MODE_NAMES } from "./schedule.js";

/** (mode, k) 元组键的 TS 编码:模式名不含 '|',故单射。 */
export function summaryKey(mode: string, k: number): string {
  return `${mode}|${k}`;
}

export class Summary {
  mode: string;
  k: number;
  n: number;
  n_ungraded: number;
  score: number | null;
  all_pass: number | null;
  kept_base: number;
  chose_final: number;
  chose_candidate: number;
  fell_back: number;
  usd: number;
  metrics: readonly string[];

  constructor(mode: string, k: number) {
    this.mode = mode;
    this.k = k;
    this.n = 0;
    this.n_ungraded = 0;
    this.score = null;
    this.all_pass = null;
    this.kept_base = 0;
    this.chose_final = 0;
    this.chose_candidate = 0;
    this.fell_back = 0;
    this.usd = 0.0;
    this.metrics = [];
  }

  get name(): string {
    return `${MODE_NAMES[this.mode] ?? this.mode} k=${this.k}`;
  }

  /** LAB reports partial credit and all-criteria pass; the others report one score. */
  line(bench = ""): string {
    if (!this.n) {
      return `  ${this.name}: no graded task`;
    }
    const figures =
      bench === "lab"
        ? `partial ${(this.score as number).toFixed(2).padStart(6)}% | pass ${(this.all_pass as number).toFixed(1).padStart(5)}%`
        : `score ${(this.score as number).toFixed(2).padStart(6)}%`;
    const pick =
      ` | picked output: final ${this.chose_final} / candidate ${this.chose_candidate} / ` +
      `base ${this.kept_base}`;
    const fb = this.fell_back ? ` | fell back ${this.fell_back}` : "";
    const ug = this.n_ungraded ? ` | ungraded ${this.n_ungraded}` : "";
    return `  ${this.name}: n=${String(this.n).padStart(3)} | ${figures}${pick}${fb}${ug}`;
  }
}

/** Classify the selected output; each sequential checkpoint is a composed final. */
function _kind(r: Scored): string {
  const lbl = String(r.label ?? "");
  if (lbl.startsWith("base")) return "base";
  if (r.mode === "agg") return lbl.startsWith("agg") ? "final" : "candidate";
  if (r.mode === "seq") {
    const finals = new Set(Array.from({ length: Math.trunc(r.k) }, (_, i) => `c${i + 1}`));
    return finals.has(lbl) ? "final" : "candidate";
  }
  return "candidate";
}

export interface SummariseOpts {
  fell_back?: Readonly<Record<string, number>> | null;
  usd?: Readonly<Record<string, number>> | null;
}

/** One Summary per (mode, k). Ungraded rows are counted, then excluded. */
export function summarise(rows: readonly Scored[], opts: SummariseOpts = {}): Summary[] {
  const fell_back = opts.fell_back ?? null;
  const usd = opts.usd ?? null;
  const keySet = new Map<string, readonly [string, number]>();
  for (const r of rows) {
    keySet.set(summaryKey(r.mode, r.k), [r.mode, r.k]);
  }
  const keys = [...keySet.values()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1],
  );
  const out: Summary[] = [];
  for (const [mode, k] of keys) {
    const group = rows.filter((r) => r.mode === mode && r.k === k);
    const good = group.filter((r) => r.graded);
    const unitSet = new Set<string>();
    for (const r of good) {
      const raw = r.raw;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const m = String((raw as Record<string, unknown>).metric ?? "");
        if (m) unitSet.add(m);
      }
    }
    const units = [...unitSet].sort();
    const s = new Summary(mode, k);
    s.n = good.length;
    s.n_ungraded = group.length - good.length;
    s.kept_base = good.filter((r) => r.chosen_is_base).length;
    s.chose_final = good.filter((r) => _kind(r) === "final").length;
    s.chose_candidate = good.filter((r) => _kind(r) === "candidate").length;
    s.fell_back = fell_back?.[summaryKey(mode, k)] ?? 0;
    s.usd = pyRound(usd?.[summaryKey(mode, k)] ?? 0.0, 2);
    s.metrics = units;
    if (good.length > 0) {
      const mean = good.reduce((a, r) => a + (r.frac as number), 0) / good.length;
      s.score = pyRound(100 * mean, 2);
      s.all_pass = pyRound((100 * good.filter((r) => r.all_pass).length) / good.length, 2);
    }
    out.push(s);
  }
  return out;
}

/** The printable summary block. */
export function render(
  summaries: readonly Summary[],
  opts: { title?: string; bench?: string } = {},
): string {
  const title = opts.title ?? "";
  const bench = opts.bench ?? "";
  const lines: string[] = [];
  if (title) {
    lines.push(title, "=".repeat(Math.max(40, [...title].length)));
  }
  for (const s of [...summaries].sort((a, b) => (a.k - b.k || (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0)))) {
    lines.push(s.line(bench));
  }

  const at1: Record<string, Summary> = {};
  for (const s of summaries) {
    if (s.k === 1 && s.score !== null) at1[s.mode] = s;
  }
  if (Object.keys(at1).length === 2) {
    const gap = Math.abs(
      ((at1["agg"] as Summary).score as number) - ((at1["seq"] as Summary).score as number),
    );
    lines.push(
      "",
      "  NOTE  at k=1 the parallel and sequential modes are the same procedure " +
        "(one INVARIANT draw, one DOMAIN draw, one composition).",
      `        The ${gap.toFixed(2)} pt between them is therefore a NOISE FLOOR, not a ` +
        "result -- an effect at k>=2 has to clear it.",
    );
  }

  for (const s of summaries) {
    if (s.n && s.chose_final <= 0.25 * s.n) {
      lines.push(
        "",
        `  WARNING  ${s.name}: the mode's own final was chosen on only ` +
          `${s.chose_final}/${s.n} tasks. These records include outputs outside ` +
          `the published pool of ${s.k} composed finals.`,
      );
    }
  }
  for (const s of summaries.filter((s) => s.n && s.kept_base >= 0.8 * s.n)) {
    lines.push(
      "",
      `  WARNING  ${s.name}: selection chose a reference output on ` +
        `${s.kept_base}/${s.n} tasks, outside the published pool of composed outputs.`,
    );
  }
  for (const s of summaries.filter((s) => s.fell_back)) {
    lines.push(
      "",
      `  WARNING  ${s.name}: ${s.fell_back} stage(s) fell back to the ` +
        "inherited harness. Inspect the stage errors when interpreting these results.",
    );
  }
  for (const s of summaries) {
    if (s.metrics.length > 1) {
      lines.push(
        "",
        `  WARNING  ${s.name}: graded rows carry MIXED scoring units ` +
          `(${s.metrics.join(", ")}). The score averages weighted points with ` +
          "unweighted criteria counts (about 20 pt apart on JobBench); re-judge " +
          "the fallback rows before comparing this line with any published " +
          "number.",
      );
    }
  }
  return lines.join("\n");
}
