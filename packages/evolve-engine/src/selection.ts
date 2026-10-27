// selection.ts — harness2/core/selection.py 的移植:两段式物理隔离的盲选 + 采纳后反思。
// 语言适配(Python → TS)已核对:
//   frozen dataclass → 类 + 显式字段序(Python __dict__ 保序,便于逐字对照)
//   re.search     → RegExp(/s 标志对应 re.S;`_CHOICE` 无 `.`,`/s` 惰性保留)
//   type(exc).__name__ → exc.constructor.name(具名 Error 子类);str(exc) → e.message
//   str(dict)/repr → pyRepr/pyListRepr(错误文案逐字符一致)
//   f"{n:,}"      → pyComma;len(str) → 代码点数(Python len 语义)
//   shutil.rmtree/mkdir/copytree/copy2 → fs.rm/mkdir/cp
//   Path.with_name(name+".experience") → join(dirname(root), basename(root)+".experience")
// JSON 落盘用 JSON.stringify(与 proposer meta.json 同一取舍):浮点文本 `usd`
// Python 写 `0.0`,JSON.stringify 写 `0`,解析后等值;golden 对照按逐字段+键序进行。
// 通道执行一律经 Proposer(测试用桩),绝不 spawn 真实 CLI。
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  assert_no_grader_verdicts,
  assert_no_leak_paths,
  assert_tree_has_no_grader_verdicts,
  build,
  copySource,
} from "./context.js";
import { experience as experiencePrompt, select as selectPrompt } from "./prompts.js";
import { Proposer, ProposerError, type Reply } from "./proposer.js";
import { pyComma, pyListRepr, pyRepr } from "./pyutil.js";
import { PyRandom } from "./pyrand.js";
import {
  resolve_prompts,
  type BenchPrompts,
  type BenchmarkAdapter,
  type RunView,
} from "./spec.js";

const _CHOICE = /```choice\s*\n?\s*([A-Za-z0-9_-]+)\s*\n?\s*```/s;
const _WHY = /<why>(.*?)<\/why>/s;
const _EXP = /<experience>(.*?)<\/experience>/s;
const _EDITS = /<edits>(.*?)<\/edits>/s;

/** Python ValueError —— 具名子类,errTag 的 constructor.name 对齐 type(exc).__name__;被失败收口捕获。 */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** Python str(exc):Error → message,其余 String()。 */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python f"{type(exc).__name__}: {exc}"(render failed 文案用)。 */
function errTag(exc: unknown): string {
  const name = exc instanceof Error ? exc.constructor.name : typeof exc;
  return `${name}: ${errStr(exc)}`;
}

/** Python len(str):Unicode 码点数(JS .length 是 UTF-16 码元)。 */
function pyLen(s: string): number {
  return Array.from(s).length;
}

/** Graded 项在前,各自相对顺序不变;不丢任何项。Python: sorted(items, key=0|1)。 */
export function order_graded_first<T>(
  items: readonly T[],
  graded: (x: T) => boolean,
): T[] {
  return [...items].sort((a, b) => (graded(a) ? 0 : 1) - (graded(b) ? 0 : 1));
}

/** Python dataclass Selection;字段序 = __dict__ 顺序 = selection.json 键序。 */
export class Selection {
  task_id: string;
  mode: string;
  k: number;
  chosen_id: string;
  chosen_label: string;
  chosen_run_id: string;
  chosen_is_base: boolean;
  why: string;
  id_map: Record<string, string>;
  dropped: string[];
  n_candidates: number;
  ok: boolean;
  fallback: boolean;
  error: string;
  usd: number;
  experience: Record<string, string>;
  trivial: boolean;
  evidence: string;

  constructor(task_id: string, mode: string, k: number, opts: { trivial?: boolean } = {}) {
    this.task_id = task_id;
    this.mode = mode;
    this.k = k;
    this.chosen_id = "";
    this.chosen_label = "";
    this.chosen_run_id = "";
    this.chosen_is_base = false;
    this.why = "";
    this.id_map = {};
    this.dropped = [];
    this.n_candidates = 0;
    this.ok = false;
    this.fallback = false;
    this.error = "";
    this.usd = 0.0;
    this.experience = {};
    this.trivial = opts.trivial ?? false;
    this.evidence = "deliverable";
  }

  to_dict(): Record<string, unknown> {
    return {
      task_id: this.task_id,
      mode: this.mode,
      k: this.k,
      chosen_id: this.chosen_id,
      chosen_label: this.chosen_label,
      chosen_run_id: this.chosen_run_id,
      chosen_is_base: this.chosen_is_base,
      why: this.why,
      id_map: this.id_map,
      dropped: this.dropped,
      n_candidates: this.n_candidates,
      ok: this.ok,
      fallback: this.fallback,
      error: this.error,
      usd: this.usd,
      experience: this.experience,
      trivial: this.trivial,
      evidence: this.evidence,
    };
  }
}

/** anon id -> label:规范排序后种子洗牌,跨重跑稳定。 */
export function assign_ids(
  labels: readonly string[],
  opts: { task_id: string; k: number; mode: string },
): Record<string, string> {
  const seed = parseInt(
    createHash("sha1")
      .update(`${opts.task_id}|${opts.k}|${opts.mode}`)
      .digest("hex")
      .slice(0, 12),
    16,
  );
  const ordered = [...labels].sort();
  new PyRandom(seed).shuffle(ordered);
  const out: Record<string, string> = {};
  ordered.forEach((lbl, i) => {
    out[_anon_id(i)] = lbl;
  });
  return out;
}

/** A..Z, AA..AZ, BA... —— choice 解析器恒可接受。 */
export function _anon_id(index: number): string {
  let out = "";
  let n = Math.trunc(index) + 1;
  while (n) {
    const q = Math.floor((n - 1) / 26);
    const rem = (n - 1) % 26;
    n = q;
    out = String.fromCharCode("A".charCodeAt(0) + rem) + out;
  }
  return out;
}

export function _is_base(label: string): boolean {
  return label.startsWith("base");
}

/**
 * selection 池的唯一构造点:恰好 `mode` 的 k 个 finals。
 * `base` 收下即弃:池要排除的就是它,调用点传它是为了让排除发生在池构造处
 * (D11 keepBaseInPool 的补丁落点在 schedule 调用侧,不在这里)。
 */
export function selection_pool(
  mode: string,
  k: number,
  rollouts: Readonly<Record<string, RunView>>,
  _base: readonly RunView[],
): Record<string, RunView> {
  const labels =
    mode === "agg"
      ? Array.from({ length: Math.trunc(k) }, (_, i) => `agg${i + 1}`)
      : Array.from({ length: Math.trunc(k) }, (_, i) => `c${i + 1}`);
  const out: Record<string, RunView> = {};
  for (const lbl of labels) {
    if (lbl in rollouts) out[lbl] = rollouts[lbl];
  }
  return out;
}

/** 匿名化之前先丢非答案,每条丢弃与原因记入 `dropped`。 */
export async function _render_pool(
  candidates: Readonly<Record<string, RunView>>,
  adapter: BenchmarkAdapter,
  sel: Selection,
): Promise<[Record<string, RunView>, Record<string, string>]> {
  const pool: Record<string, RunView> = {};
  const artifacts: Record<string, string> = {};
  for (const [lbl, rv] of Object.entries(candidates)) {
    if (!(rv.ok && rv.delivered)) {
      sel.dropped.push(lbl);
      continue;
    }
    let rendered: string;
    try {
      rendered = (await adapter.deliverable_text(rv.run_dir)) || "";
    } catch (exc) {
      sel.dropped.push(`${lbl} (render failed: ${errTag(exc)})`.slice(0, 200));
      continue;
    }
    if (!rendered.trim()) {
      sel.dropped.push(lbl);
      continue;
    }
    pool[lbl] = rv;
    artifacts[lbl] = rendered;
  }
  if (
    Object.keys(pool).length === 0 &&
    Object.keys(candidates).length > 0 &&
    adapter.spec.state_deliverable
  ) {
    for (const [lbl, rv] of Object.entries(candidates)) {
      if (!rv.ok) continue;
      let body: string;
      try {
        body = await adapter.trajectory(rv.run_dir, {
          obs_trunc: adapter.spec.obs_trunc,
        });
      } catch (exc) {
        sel.dropped.push(`${lbl} (trajectory failed: ${errTag(exc)})`.slice(0, 200));
        continue;
      }
      if (!body.trim() || body.startsWith("(no trajectory")) continue;
      pool[lbl] = rv;
      artifacts[lbl] =
        "(this task produced no file deliverable; the candidate is " +
        "shown as its own session transcript)\n\n" +
        body;
    }
    if (Object.keys(pool).length > 0) {
      sel.evidence = "trajectory";
      sel.dropped = sel.dropped.filter((d) => !Object.hasOwn(pool, d));
    }
  }
  return [pool, artifacts];
}

const _DEFAULT_ASSETS_NOTE =
  "     Rendered evidence for this candidate is in `{anon}/`: {names}. " +
  "OPEN THESE -- they show what the artifact actually does when run, " +
  "which its source alone does not tell you.\n";
const _DEFAULT_ASSETS_LINE =
  "    context/candidates/<id>/     RENDERED EVIDENCE for that candidate " +
  "({shown}) -- what the\n" +
  "                                artifact actually DOES when run. Source " +
  "alone does not show this.\n";

function _assets_note(adapter: BenchmarkAdapter, anon: string, names: readonly string[]): string {
  const fn = (adapter as { deliverable_assets_note?: unknown }).deliverable_assets_note;
  if (typeof fn === "function") {
    const v = (fn as (n: string[]) => unknown).call(adapter, [...names]);
    // Python str(fn(...) or ""):falsy 返回 → 空串;replace 全量替换。
    return String(v || "").replaceAll("{anon}", anon);
  }
  return _DEFAULT_ASSETS_NOTE.replaceAll("{anon}", anon).replaceAll(
    "{names}",
    [...names].join(", "),
  );
}

function _assets_line(adapter: BenchmarkAdapter, shown: string): string {
  const fn = (adapter as { deliverable_assets_line?: unknown }).deliverable_assets_line;
  if (typeof fn === "function") {
    const v = (fn as (s: string) => unknown).call(adapter, shown);
    return String(v || "");
  }
  return _DEFAULT_ASSETS_LINE.replaceAll("{shown}", shown);
}

/**
 * 每候选写一份匿名、未裁剪的文件;返回拷入的 asset 名。
 * asset 文件由 adapter 明示、只拷明示名单:run 目录里的路径也会携带评分器输出。
 */
export async function _write_candidates(
  sel: Selection,
  artifacts: Readonly<Record<string, string>>,
  pool: Readonly<Record<string, RunView>>,
  cand_dir: string,
  adapter: BenchmarkAdapter,
): Promise<Set<string>> {
  const asset_fn = (adapter as { deliverable_assets?: unknown }).deliverable_assets;
  const asset_names = new Set<string>();
  for (const [anon, lbl] of Object.entries(sel.id_map)) {
    const text = artifacts[lbl];
    const assets: string[] = [];
    if (typeof asset_fn === "function") {
      const list =
        (await (asset_fn as (d: string) => Promise<string[]>).call(
          adapter,
          pool[lbl].run_dir,
        )) || [];
      for (const a of list) {
        try {
          const st = await fs.stat(a);
          if (st.isFile()) assets.push(a);
        } catch {
          // Path(a).is_file() 的 Python 语义:不存在/不可达 → 滤掉。
        }
      }
    }
    let note = "";
    if (assets.length > 0) {
      const adir = join(cand_dir, anon);
      await fs.mkdir(adir, { recursive: true });
      const names: string[] = [];
      for (const a of assets) {
        await fs.cp(a, join(adir, basename(a)), { force: true });
        names.push(basename(a));
      }
      note = _assets_note(adapter, anon, names);
      for (const n of names) asset_names.add(n);
    }
    // Python: f"{len(text):,} chars, {text.count(chr(10)) + 1:,} lines"(split("\n") 长度恒等 count+1)。
    const header =
      `<!-- candidate ${anon}: ${pyComma(pyLen(text))} chars, ` +
      `${pyComma(text.split("\n").length)} lines. ` +
      `COMPLETE -- nothing trimmed. Navigate with grep/offsets; evaluating a ` +
      `candidate means opening the part that determines whether it works.\n` +
      `${note}-->\n`;
    await fs.writeFile(join(cand_dir, `${anon}.md`), header + text, "utf8");
  }
  return asset_names;
}

/** 资产措辞:选择器 prompt 里的行 + 证据清单里的一行。 */
export function _evidence_block(
  asset_names: ReadonlySet<string>,
  adapter: BenchmarkAdapter,
  reference_only: boolean,
): [string, string] {
  if (asset_names.size === 0) return ["", ""];
  const shown = [...asset_names].sort().slice(0, 4).join(", ");
  const a_evid =
    "context/candidates/<id>/        " +
    (reference_only ? "raw originals per candidate" : "rendered evidence per candidate") +
    `: ${shown}\n`;
  return [_assets_line(adapter, shown), a_evid];
}

/** 选择器失败后的中立替身:有交付的 base,否则第一个 final。 */
export function _fallback(
  sel: Selection,
  pool: Readonly<Record<string, RunView>>,
  pool_kind: string,
  exc: unknown,
): boolean {
  const base = Object.keys(pool)
    .filter(_is_base)
    .sort();
  if (base.length > 0) {
    sel.chosen_label = base[0];
  } else if (pool_kind === "finals") {
    sel.chosen_label = Object.keys(pool).sort()[0];
  } else {
    sel.error =
      errStr(exc).slice(0, 350) +
      "; no delivered base artifact was available for a neutral fallback";
    return false;
  }
  sel.chosen_id =
    Object.entries(sel.id_map).find(([, label]) => label === sel.chosen_label)?.[0] ?? "";
  sel.fallback = true;
  sel.error = errStr(exc).slice(0, 400);
  return true;
}

/** 写 selection.json;磁盘失败记在档案上而不是往外抛。 */
export async function _persist(sel: Selection, root: string, run_dir: string): Promise<void> {
  try {
    const rec = sel.to_dict();
    rec.chosen_run_dir = run_dir;
    await fs.writeFile(join(root, "selection.json"), JSON.stringify(rec, null, 2), "utf8");
  } catch (exc) {
    sel.ok = false;
    sel.error = (sel.error + ` | could not persist selection: ${errStr(exc)}`).slice(0, 400);
  }
}

/**
 * 选一个产出。选择器失败回退 base 且永不抛;adapter 的 bug 才抛 —— 它是 bug,不是选择结果。
 * `pool_kind="finals"` 只改选择器看到的措辞与失败回退;缺省与 mixed 池逐字节同行为。
 */
export async function run_selection(
  task_id: string,
  k: number,
  mode: string,
  candidates: Readonly<Record<string, RunView>>,
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    work_dir: string;
    pool_kind?: string;
  },
): Promise<Selection> {
  const { adapter, prop, work_dir } = opts;
  const pool_kind = opts.pool_kind ?? "mixed";
  const sel = new Selection(task_id, mode, k);
  const bp = resolve_prompts(adapter, task_id);

  const [pool, artifacts] = await _render_pool(candidates, adapter, sel);
  sel.n_candidates = Object.keys(pool).length;
  if (Object.keys(pool).length === 0) {
    sel.error = "no candidate produced an artifact";
    return sel;
  }

  sel.id_map = assign_ids(Object.keys(pool), { task_id, k, mode });

  const root = join(work_dir, "selection", `${mode}${k}`);

  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(join(root, "task.md"), adapter.task_prompt(task_id), "utf8");
  await copySource(adapter, task_id, root);

  const cand_dir = join(root, "candidates");
  await fs.mkdir(cand_dir, { recursive: true });
  const asset_names = await _write_candidates(sel, artifacts, pool, cand_dir, adapter);

  const ids = Object.keys(sel.id_map).sort().join(", ");
  const reference_only = Boolean(
    (adapter as { deliverable_assets_reference_only?: unknown })
      .deliverable_assets_reference_only,
  );
  const [a_line, a_evid] = _evidence_block(asset_names, adapter, reference_only);
  const mission = [
    selectPrompt(bp, Object.keys(pool).length, pool_kind, a_line),
    "# YOUR EVIDENCE\n\nIt is on disk. Read it -- do not answer from this message alone.\n\n" +
      "context/task.md                 the instructions\n" +
      "context/source/                 task source materials, when supplied\n" +
      `context/candidates/<id>.md      one file per candidate: ${ids}\n` +
      a_evid +
      ("\nOpen every candidate before choosing" +
        (asset_names.size > 0 && !reference_only
          ? ", INCLUDING the rendered evidence in its directory"
          : "") +
        `. Choose exactly one of: ${ids}.`),
  ].join("\n\n");

  // 两段式物理隔离的强制点:选择器开盲前评分材料绊线必须先过。
  assert_no_grader_verdicts(root);

  try {
    const reply: Reply = await prop.call(mission, root, `select.${mode}${k}`);
    sel.usd += reply.cost_usd;
    const m = _CHOICE.exec(reply.text);
    if (!m) {
      throw new ValueError("no ```choice block in the reply");
    }
    const anon = m[1].trim();
    if (!(anon in sel.id_map)) {
      throw new ValueError(`chose ${pyRepr(anon)}, which is not one of ${ids}`);
    }
    const w = _WHY.exec(reply.text);
    sel.why = (w ? w[1].trim() : "").slice(0, 2000);
    sel.chosen_id = anon;
    sel.chosen_label = sel.id_map[anon];
    sel.ok = true;
  } catch (exc) {
    if (!(exc instanceof ProposerError || exc instanceof ValueError)) throw exc;
    if (exc instanceof ProposerError) {
      sel.usd += exc.cost_usd;
    }
    if (!_fallback(sel, pool, pool_kind, exc)) {
      return sel;
    }
  }

  sel.chosen_run_id = pool[sel.chosen_label].run_id;
  sel.chosen_is_base = _is_base(sel.chosen_label);

  await _persist(
    sel,
    root,
    Object.hasOwn(pool, sel.chosen_label) ? pool[sel.chosen_label].run_dir : "",
  );

  return sel;
}

/**
 * k=1 单 final 免选择器直接交付。
 * 非答案丢弃规则同 run_selection;selection.json 走同一 schema 同一路径,judge 侧只找一处。
 */
export async function trivial_selection(
  task_id: string,
  k: number,
  mode: string,
  candidates: Readonly<Record<string, RunView>>,
  opts: { adapter: BenchmarkAdapter; work_dir: string },
): Promise<Selection> {
  const { adapter, work_dir } = opts;
  if (Object.keys(candidates).length > 1) {
    throw new ValueError(
      `trivial_selection expects at most one candidate (the k=1 final), ` +
        `got ${pyListRepr(Object.keys(candidates).sort())}`,
    );
  }
  const sel = new Selection(task_id, mode, k, { trivial: true });
  const [pool] = await _render_pool(candidates, adapter, sel);
  sel.n_candidates = Object.keys(pool).length;
  if (Object.keys(pool).length === 0) {
    sel.error = "no candidate produced an artifact (finals-only pool has no base fallback)";
    return sel;
  }

  const label = Object.keys(pool)[0];
  sel.ok = true;
  sel.chosen_id = "A";
  sel.chosen_label = label;
  sel.id_map = { A: label };
  sel.chosen_run_id = pool[label].run_id;
  sel.chosen_is_base = _is_base(label);
  sel.why = "trivial pool: single final at k=1; delivered without a selector session";

  const root = join(work_dir, "selection", `${mode}${k}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await _persist(sel, root, pool[label].run_dir);
  return sel;
}

/** 采纳后从 harness 编辑、决策、轨迹与交付中学习。 */
export async function reflect_adoption(
  task_id: string,
  sel: Selection,
  candidates: Readonly<Record<string, RunView>>,
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    work_dir: string;
    decisions?: Readonly<Record<string, string>> | null;
  },
): Promise<Record<string, string>> {
  const { adapter, prop, work_dir } = opts;
  const decisions = opts.decisions ?? null;
  const chosen = Object.hasOwn(candidates, sel.chosen_label)
    ? candidates[sel.chosen_label]
    : undefined;
  if (!sel.ok || chosen === undefined) {
    return {};
  }
  const root = join(work_dir, "reflection", `${sel.mode}${sel.k}`);
  const harnesses = join(work_dir, "harnesses");
  const evidence = await build(root, adapter, task_id, [...Object.values(candidates)], {
    harness_dir: join(harnesses, sel.chosen_label),
    pool: Object.entries(candidates)
      .filter(([label]) => !_is_base(label))
      .map(([label, rollout]) => [label, join(harnesses, label), rollout] as const),
    decisions,
  });
  await fs.cp(await adapter.base_harness(), join(root, "base_harness"), { recursive: true });
  await fs.writeFile(
    join(root, "adoption.json"),
    JSON.stringify(
      {
        chosen_label: sel.chosen_label,
        candidate_ids: sel.id_map,
        reason: sel.why,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  assert_no_leak_paths(root, adapter.spec.leak_globs);
  assert_no_grader_verdicts(root);
  const experience = await _distil(task_id, sel, candidates, {
    adapter,
    prop,
    root,
    layout: evidence.layout,
  });
  sel.experience = experience;
  await _persist(sel, join(work_dir, "selection", `${sel.mode}${sel.k}`), chosen.run_dir);
  return experience;
}

/** 从完整的任务内改进记录中提取有支撑的教训。 */
export async function _distil(
  task_id: string,
  sel: Selection,
  _pool: Readonly<Record<string, RunView>>,
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    root: string;
    bp?: BenchPrompts | null;
    layout?: string;
  },
): Promise<Record<string, string>> {
  const { adapter, prop, root } = opts;
  const layout = opts.layout ?? "";
  const mission = [
    experiencePrompt(opts.bp ?? resolve_prompts(adapter, task_id)),
    "# WHAT HAPPENED\n\n" +
      `Harness ${sel.chosen_label} was adopted. The selection reasoning was:\n\n${sel.why}\n\n` +
      "context/adoption.json maps any anonymous IDs in that reasoning to rollout labels. " +
      "Compare context/harness/ with context/base_harness/ and the candidates in " +
      "context/pool/. Read the decisions and execution contrasts before writing.\n\n" +
      layout,
  ].join("\n\n");
  const exp_root = join(dirname(root), `${basename(root)}.experience`);
  await fs.rm(exp_root, { recursive: true, force: true });
  await fs.cp(root, exp_root, {
    recursive: true,
    filter: (src) => basename(src) !== "selection.json",
  });
  assert_no_grader_verdicts(exp_root);
  let reply: Reply;
  try {
    reply = await prop.call(mission, exp_root, `experience.${sel.mode}${sel.k}`);
  } catch (exc) {
    if (!(exc instanceof ProposerError)) throw exc;
    sel.usd += exc.cost_usd;
    return {};
  }
  sel.usd += reply.cost_usd;
  const edits = _EDITS.exec(reply.text);
  if (edits) {
    await fs.writeFile(join(root, "edits.md"), edits[1].trim() + "\n", "utf8");
  }
  const m = _EXP.exec(reply.text);
  if (!m) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of m[1].trim().split("\n")) {
    const idx = line.indexOf(":");
    if (idx >= 0) {
      const key = line.slice(0, idx).trim().toLowerCase();
      if (key === "cue" || key === "lesson" || key === "evidence" || key === "confidence") {
        out[key] = line.slice(idx + 1).trim();
      }
    }
  }
  if (!out.cue || !out.lesson || !out.evidence) {
    return {};
  }
  if (edits) {
    out.edits = edits[1].trim();
  }
  assert_tree_has_no_grader_verdicts({ "EXPERIENCE.md": JSON.stringify(out) });
  return out;
}
