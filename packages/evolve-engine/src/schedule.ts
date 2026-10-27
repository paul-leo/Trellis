// schedule.ts — harness2/core/schedule.py(851 行)的逐行移植。
// Namespacing, the seeded stream order, and the drivers: one task, one domain, a sweep.
//
// 逐条对照:
//   MODES / MODE_NAMES / _MODE_ALIASES → 同名导出;ROLLOUT_PARALLEL = recursion.PHASE_WIDTH
//   mode_token / validate_tag          → 文案逐字;re.fullmatch → /^(?:...)$/,
//                                        re.match → 前缀锚正则;{tag!r} → pyRepr
//   Namespace(frozen dataclass)       → 类 + toString()(= ns(...));glob 只此一处
//   stream_order                       → stream_order:seed=None 参考序;int 种子用
//                                        PyRandom(`${seed}:__domains__`) / `${seed}:${d}`
//                                        (CPython Random(str) 语义,见 pyrand.ts);
//                                        每次从 SORTED 出发,结果只依赖 (seed, domain, tasks)
//   TaskResult                         → 类;to_dict 键序与 Python 字面量一致
//                                        (base 实际是 [{label,run_id,run_dir}];Python 类型
//                                        注解 list[str] 是笔误,此处按真实形状标注)
//   _merged_status / _modes_of         → 同名;合并语义见 _write_summary
//   _write_summary                     → 进程内 per-path promise 互斥 + tmp+rename
//                                        (显式偏差:Python fcntl.flock 跨进程互斥 +
//                                        os.replace;TS 单进程 Promise 池不需要跨进程锁,
//                                        跨进程并发写同一 summary.json 不支持)。合并语义
//                                        保真:modes/selections 旧条目累积、当前覆盖;
//                                        errors 去重且丢弃陈旧条目(见函数内注释)。
//   _resume / _restore_libraries       → async;fingerprint/is_tree/read_tree 均 await;
//                                        adapter.artifacts_intact 为可选鸭子类型钩子
//   _roll_bases                        → async;execute_many 批量路径与单条路径的
//                                        exists 检查差异照抄 Python(_one 成功路径不做
//                                        exists 检查,批量路径做)——历史行为,不"修正"
//   _run_one_mode / run_task           → async;trivial_selection/run_selection/
//                                        reflect_adoption 在 TS 是 Promise,逐个 await;
//                                        traceback.format_exc()[-1500:] → e.stack 切片
//                                        (文本形态偏差:Python 多行 traceback vs V8 stack)
//   _run_one_mode 池构造               → **D11 显式偏差**(base 留池):
//                                        BenchSpec.keepBaseInPool 为真时经
//                                        poolWithBase 把 base rollouts 并入候选池
//                                        (harness2 在 selection_pool 构造处排除
//                                        base),k=1 时同走真选择;开关为假时与
//                                        Python 逐字节同构。其余逻辑不动。
//   ThreadPoolExecutor + as_completed  → mapPool(pool.ts);**聚合顺序显式化**:
//                                        Python as_completed 为完成序(未指定的顺序),
//                                        TS 按 domain 序(order)聚合 —— 结果顺序成为
//                                        规范不变量而不是竞速副产品
//   datetime.now(timezone.utc).isoformat() → toISOString()("Z" vs "+00:00" 的格式偏差)
//   f-string {MODES}/{unknown}/{missing}   → pyTupleRepr / pyListRepr
//   Proposer(project=, region=)        → TS Proposer 无 project/region(7.1 不移植
//                                        Vertex 凭据形态),_selector_for 省略并注释
//   ChannelSpec `==`                   → 结构相等(kind/model/effort/steps/timeout 五字段)

import * as fs from "node:fs/promises";
import * as fsp from "node:fs";
import { join, extname } from "node:path";

import * as library_store from "./library.js";
import type { Library } from "./library.js";
import { mapPool } from "./pool.js";
import { Proposer } from "./proposer.js";
import { pyListRepr, pyRepr, pyTupleRepr } from "./pyutil.js";
import { PyRandom } from "./pyrand.js";
import * as recursion from "./recursion.js";
import * as runmark from "./runmark.js";
import * as selection from "./selection.js";
import type { BenchmarkAdapter, ChannelSpec, RunView } from "./spec.js";
import { makeRunView } from "./spec.js";
import * as harness_tree from "./tree.js";
import type { Tree } from "./tree.js";

export const MODES = ["agg", "seq"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_NAMES: Record<string, string> = { agg: "parallel", seq: "sequential" };
const _MODE_ALIASES: Record<string, Mode> = {
  agg: "agg",
  seq: "seq",
  parallel: "agg",
  sequential: "seq",
};

export const ROLLOUT_PARALLEL = recursion.PHASE_WIDTH;

/** The on-disk token for a mode name: parallel/agg -> "agg", sequential/seq -> "seq". */
export function mode_token(name: string | null | undefined): Mode {
  const low = String(name ?? "").trim().toLowerCase();
  if (!(low in _MODE_ALIASES)) {
    throw new selection.ValueError(
      `unknown mode ${pyRepr(name)}; expected parallel | sequential (or the on-disk tokens ${pyTupleRepr(MODES)})`,
    );
  }
  return _MODE_ALIASES[low] as Mode;
}

/** Check a tag's shape: it becomes a path segment and must not spell a seed segment. */
export function validate_tag(tag: string): void {
  if (!tag) return;
  if (!/^(?:[A-Za-z0-9_.][A-Za-z0-9_.\-]*)$/.test(tag)) {
    throw new selection.ValueError(
      `tag ${pyRepr(tag)} must be [A-Za-z0-9_.-] with no leading '-' and ` +
        "no '/': it becomes a path segment and a run-id segment",
    );
  }
  if (/^s\d+(-|$)/.test(tag)) {
    throw new selection.ValueError(
      `tag ${pyRepr(tag)} spells a seed segment; pass --seed instead so ` +
        "seeded and tagged namespaces can never collide",
    );
  }
}

/** The per-mode records of a summary / sweep record. The legacy key is still read. */
export function _modes_of(record: Record<string, unknown>): Record<string, unknown> {
  if ("modes" in record) {
    return { ...((record["modes"] as Record<string, unknown>) ?? {}) };
  }
  return { ...((record["arms"] as Record<string, unknown>) ?? {}) };
}

/** Every name for one (benchmark, substrate, mode, k, seed, tag) setting. */
export class Namespace {
  readonly benchmark: string;
  readonly substrate: string;
  readonly mode: string;
  readonly k: number;
  readonly seed: number | null;
  readonly tag: string;

  constructor(
    benchmark: string,
    substrate: string,
    mode: string,
    k: number,
    seed: number | null = null,
    tag = "",
  ) {
    this.benchmark = benchmark;
    this.substrate = substrate;
    this.mode = mode;
    this.k = k;
    this.seed = seed;
    this.tag = tag;
  }

  toString(): string {
    return ns(this.benchmark, this.substrate, this.mode, this.k, { seed: this.seed, tag: this.tag });
  }

  run_id(task_id: string, label: string): string {
    return `${this}/${task_id}/${label}`;
  }

  task_dir(root: string, task_id: string): string {
    return join(root, String(this), task_id.replaceAll("/", "__"));
  }

  /** The only glob over namespaces; both patterns match seeded, tagged and bare forms. */
  static glob(
    benchmark: string,
    substrate: string,
    k: number,
    opts: { mode?: string } = {},
  ): readonly [string, string] {
    const mode = opts.mode ?? "*";
    const base = `${benchmark}-${substrate}-${mode}${Math.trunc(k)}`;
    return [base, `${base}-*`] as const;
  }
}

export function ns(
  benchmark: string,
  substrate: string,
  mode: string,
  k: number,
  opts: { seed?: number | null; tag?: string } = {},
): string {
  const seed = opts.seed ?? null;
  const tag = opts.tag ?? "";
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new selection.ValueError(
      `unknown mode ${pyRepr(mode)}; the method has exactly two: ${pyTupleRepr(MODES)}`,
    );
  }
  if (!substrate) {
    throw new selection.ValueError(
      "namespace needs a substrate name ('oc' | 'cx'); an empty one would " +
        "let the two substrates' caches collide on every label",
    );
  }
  validate_tag(tag);
  let out = `${benchmark}-${substrate}-${mode}${Math.trunc(k)}`;
  if (seed !== null) out += `-s${Math.trunc(seed)}`;
  if (tag) out += `-${tag}`;
  return out;
}

/**
 * The full (domain, task_id) stream, the one constructor of continual-learning order.
 * seed=None is the reference order: `reference_domain_order`, tasks sorted. An int seed
 * shuffles under PyRandom(`${seed}:__domains__`) and PyRandom(`${seed}:${domain}`).
 *
 * Each shuffle starts from the SORTED order, so the result depends ONLY on (seed, domain,
 * task set) — never on dict iteration order or which other domains are present.
 */
export function stream_order(
  tasks_by_domain: Readonly<Record<string, readonly string[]>>,
  seed: number | null,
  reference_domain_order: readonly string[],
): (readonly [string, string])[] {
  const domains = Object.keys(tasks_by_domain).sort();
  let ordered_domains: string[];
  if (seed === null) {
    const refSet = new Set(reference_domain_order);
    const missing = domains.filter((d) => !refSet.has(d));
    if (missing.length > 0) {
      throw new selection.ValueError(
        `reference_domain_order does not cover domain(s) ${pyListRepr(missing)}; the frozen ` +
          "order list is stale — regenerate it rather than letting an unlisted domain " +
          "land in an arbitrary position",
      );
    }
    ordered_domains = reference_domain_order.filter((d) => d in tasks_by_domain);
  } else {
    ordered_domains = [...domains];
    new PyRandom(`${seed}:__domains__`).shuffle(ordered_domains);
  }
  const out: (readonly [string, string])[] = [];
  for (const d of ordered_domains) {
    const tasks = [...(tasks_by_domain[d] ?? [])].sort();
    if (seed !== null) new PyRandom(`${seed}:${d}`).shuffle(tasks);
    for (const t of tasks) out.push([d, t] as const);
  }
  return out;
}

/** Descending task count, then name. */
export function _default_reference_domain_order(
  by_domain: Readonly<Record<string, readonly string[]>>,
): string[] {
  return Object.keys(by_domain).sort((a, b) => {
    const la = (by_domain[a] ?? []).length;
    const lb = (by_domain[b] ?? []).length;
    return lb - la || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** The adapter's frozen domain order when it has one, else the count-then-name default. */
export function _reference_domain_order(
  adapter: BenchmarkAdapter,
  by_domain: Readonly<Record<string, readonly string[]>>,
): string[] {
  const fn = (adapter as { reference_domain_order?: () => string[] }).reference_domain_order;
  if (typeof fn === "function") {
    return [...fn.call(adapter)].map((d) => String(d));
  }
  return _default_reference_domain_order(by_domain);
}

function channelSpecEq(a: ChannelSpec | undefined, b: ChannelSpec | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.steps === b.steps &&
    a.timeout === b.timeout
  );
}

/** Honor the selector channel while preserving fake/custom proposers when specs match. */
export function _selector_for(
  adapter: BenchmarkAdapter,
  prop: Proposer,
  selector_prop: Proposer | null,
): Proposer {
  if (selector_prop !== null) return selector_prop;
  const spec = adapter.spec.channels["selector"] as ChannelSpec | undefined;
  if (!spec) {
    throw new Error(`BenchSpec.channels must define 'selector'`);
  }
  if (channelSpecEq(prop.spec, spec)) return prop;
  const audit = prop.audit_dir ? join(prop.audit_dir, "selector") : null;
  // Python 原版还传 project=prop.project, region=prop.region(Vertex 适配)。
  // TS Proposer 不携带这两个字段(7.1 明确不移植 Vertex env),故省略。
  return new Proposer(spec, {
    audit_dir: audit ?? undefined,
    attempts: prop.attempts,
  });
}

export function _tree_is_base(surface: harness_tree.SurfaceSpec, base_tree: Tree, tree: Tree): boolean {
  const chg = harness_tree.diff_summary(surface, base_tree, tree);
  return !(chg.added.length || chg.removed.length || chg.modified.length);
}

/** Replay a skipped task into its libraries from the saved chosen harness. */
export async function _restore_libraries(
  task_id: string,
  k: number,
  adapter: BenchmarkAdapter,
  runs_root: string,
  modes: readonly string[],
  seed: number | null,
  tag: string,
  libraries: Readonly<Record<string, Library>>,
  selections: Record<string, Record<string, unknown>>,
): Promise<void> {
  const surface = adapter.substrate.surface();
  for (const mode of modes) {
    const lib = libraries[mode];
    const sel = selections[mode] ?? {};
    const label = String(sel["chosen_label"] ?? "");
    if (
      !lib ||
      !label ||
      !sel["ok"] ||
      !library_store.has_experience(sel["experience"])
    ) {
      continue;
    }
    const n = new Namespace(adapter.spec.name, adapter.substrate.name, mode, k, seed, tag);
    const tree = await harness_tree.read_tree(
      surface,
      join(n.task_dir(runs_root, task_id), "harnesses", label),
    );
    if (Object.keys(tree).length === 0) continue;
    await lib.add(task_id, tree, {
      why: String(sel["why"] ?? ""),
      label,
      run_id: String(sel["chosen_run_id"] ?? ""),
      experience: (sel["experience"] as Record<string, string>) ?? {},
    });
  }
}

/** 一个任务的 summary 记录。base 的真实形状是 [{label,run_id,run_dir}]。 */
export class TaskResult {
  task_id: string;
  domain: string;
  k: number;
  seed: number | null;
  status: string;
  modes: Record<string, unknown>;
  selections: Record<string, Record<string, unknown>>;
  base: Record<string, string>[];
  errors: string[];

  constructor(input: {
    task_id: string;
    domain: string;
    k: number;
    seed?: number | null;
  }) {
    this.task_id = input.task_id;
    this.domain = input.domain;
    this.k = input.k;
    this.seed = input.seed ?? null;
    this.status = "running";
    this.modes = {};
    this.selections = {};
    this.base = [];
    this.errors = [];
  }

  to_dict(): Record<string, unknown> {
    return {
      task_id: this.task_id,
      domain: this.domain,
      k: this.k,
      seed: this.seed,
      status: this.status,
      base: this.base,
      modes: this.modes,
      selections: this.selections,
      errors: this.errors,
    };
  }
}

/** ok iff every mode record on the merged summary succeeded and no error is recorded. */
export function _merged_status(merged: Record<string, unknown>): string {
  const modes = (merged["modes"] as Record<string, unknown>) ?? {};
  const selections = (merged["selections"] as Record<string, Record<string, unknown>>) ?? {};
  const modeEntries = Object.entries(modes);
  const ok =
    modeEntries.length > 0 &&
    !(merged["errors"] as unknown[] | undefined)?.length &&
    modeEntries.every(([mode, value]) => {
      const v = (value ?? {}) as Record<string, unknown>;
      const s = selections[mode] ?? {};
      return Boolean(v["ok"] && s["ok"] && s["chosen_label"]);
    });
  return ok ? "ok" : "partial";
}

async function _load_old(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** with_suffix(".lock") / with_suffix(".json.tmp") 的 Path 对应物:换最后一个扩展名。 */
function with_suffix(p: string, suffix: string): string {
  const ext = extname(p);
  return p.slice(0, p.length - ext.length) + suffix;
}

// 进程内 per-path 互斥:同路径的 _write_summary 串行化(替代 Python flock)。
// Python 的 lock 文件在 open(lock, "w") 后保留在盘上(golden 目录里可见 summary.lock);
// TS 同样只建/截断不删除。
const _summary_locks = new Map<string, Promise<void>>();

async function with_summary_lock(summary_path: string, fn: () => Promise<void>): Promise<void> {
  const prev = _summary_locks.get(summary_path) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  _summary_locks.set(summary_path, tail);
  await run;
}

/**
 * Merge `res` into the summary under the per-path lock, atomically, deriving the merged status.
 * Modes may be written by separate processes in the Python original, so records accumulate per
 * mode; in TS the accumulation keeps the same merge semantics for multi-call writes.
 */
export async function _write_summary(summary_path: string, res: TaskResult): Promise<void> {
  const lock = with_suffix(summary_path, ".lock");
  await with_summary_lock(summary_path, async () => {
    // Python open(lock, "w") 建/截断 lock 文件且从不删除 —— 保留同样可见产物。
    await fs.writeFile(lock, "");
    const merged: Record<string, unknown> = res.to_dict();
    if (fsp.existsSync(summary_path)) {
      const old = await _load_old(summary_path);
      for (const key of ["modes", "selections"] as const) {
        const prev: Record<string, unknown> =
          key === "modes"
            ? _modes_of(old)
            : { ...((old[key] as Record<string, unknown>) ?? {}) };
        Object.assign(prev, (merged[key] as Record<string, unknown>) ?? {});
        merged[key] = prev;
      }

      const errs: unknown[] = [...((merged["errors"] as unknown[]) ?? [])];
      // Python 用 json.dumps(e, sort_keys=True, default=str) 去重;错误全是 string,
      // 该编码单射,直接用 JSON.stringify(e) 做键等价。
      const seen = new Set(errs.map((e) => JSON.stringify(e)));
      for (const e of (old["errors"] as unknown[]) ?? []) {
        if (e === "no base rollout produced anything" && (res.status === "ok" || res.status === "partial")) {
          continue;
        }
        const s = String(e);
        const colon = s.indexOf(":");
        const mode = colon === -1 ? s : s.slice(0, colon);
        const m = (res.modes[mode] ?? {}) as Record<string, unknown>;
        const sel = res.selections[mode] ?? {};
        if (m["ok"] && sel["ok"] && sel["chosen_label"]) {
          continue;
        }
        if (!seen.has(JSON.stringify(e))) {
          errs.push(e);
        }
      }
      merged["errors"] = errs;
      if (merged["status"] === "ok" || merged["status"] === "partial") {
        merged["status"] = _merged_status(merged);
      }
    }
    const tmp = with_suffix(summary_path, ".json.tmp");
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2));
    await fs.rename(tmp, summary_path);
  });
}

export function _resolve_libraries(
  library: Library | null,
  libraries: Record<string, Library> | null,
  modes: readonly string[],
): Record<string, Library> {
  const mode_libs: Record<string, Library> = { ...(libraries ?? {}) };
  if (library === null) return mode_libs;
  if (Object.keys(mode_libs).length > 0) {
    throw new selection.ValueError("pass either library or libraries, not both");
  }
  if (modes.length !== 1) {
    throw new selection.ValueError(
      "a shared mutable library would leak one mode into another; " +
        "pass libraries={'agg': ..., 'seq': ...} instead",
    );
  }
  mode_libs[modes[0] as string] = library;
  return mode_libs;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fill `res` from a cached summary covering every requested mode; True if it did.
 */
export async function _resume(
  summary_path: string,
  task_id: string,
  k: number,
  adapter: BenchmarkAdapter,
  runs_root: string,
  modes: readonly string[],
  seed: number | null,
  tag: string,
  mode_libs: Record<string, Library>,
  res: TaskResult,
): Promise<boolean> {
  let got: Record<string, unknown>;
  try {
    got = JSON.parse(await fs.readFile(summary_path, "utf8")) as Record<string, unknown>;
  } catch (exc) {
    console.log(
      `  [${task_id}] unreadable summary.json (${errName(exc)}: ${errText(exc)}); re-running`,
    );
    return false;
  }
  if (got["status"] !== "ok") return false;
  const cached_modes = _modes_of(got);
  const cached_sels = (got["selections"] as Record<string, Record<string, unknown>>) ?? {};
  const missing = modes
    .filter((m) => {
      const cm = (cached_modes[m] ?? {}) as Record<string, unknown>;
      const cs = cached_sels[m] ?? {};
      return !(cm["ok"] && cs["ok"] && cs["chosen_label"]);
    })
    .sort();
  if (missing.length > 0) {
    console.log(
      `  [${task_id}] cached summary covers ${pyListRepr([...Object.keys(cached_modes)].sort())}, re-running for ${pyListRepr(missing)}`,
    );
    return false;
  }
  for (const mode of modes) {
    const sel = cached_sels[mode] as Record<string, unknown>;
    const namespace = new Namespace(adapter.spec.name, adapter.substrate.name, mode, k, seed, tag);
    const harness_dir = join(
      namespace.task_dir(runs_root, task_id),
      "harnesses",
      String(sel["chosen_label"]),
    );
    const run_dir = String(sel["chosen_run_dir"] ?? "");
    try {
      if (!sel["chosen_run_dir"] || !(await isDir(run_dir))) {
        throw new selection.ValueError("adopted run directory is missing");
      }
      let artifact: string;
      if (sel["evidence"] === "trajectory" && adapter.spec.state_deliverable) {
        artifact = await adapter.trajectory(run_dir, { obs_trunc: adapter.spec.obs_trunc });
      } else {
        artifact = (await adapter.delivered(run_dir)) ? await adapter.deliverable_text(run_dir) : "";
      }
      if (!artifact.trim() || artifact.startsWith("(no trajectory")) {
        throw new selection.ValueError("adopted output is missing");
      }
      const artifacts_intact = (adapter as { artifacts_intact?: (rd: string) => Promise<boolean> | boolean })
        .artifacts_intact;
      if (typeof artifacts_intact === "function") {
        const intact = await artifacts_intact.call(adapter, run_dir);
        if (!intact) throw new selection.ValueError("adopted execution artifacts have changed");
      }
      if (!(await harness_tree.is_tree(adapter.substrate.surface(), harness_dir))) {
        throw new selection.ValueError("adopted harness is missing");
      }
      const fingerprint = sel["harness_fingerprint"];
      if (fingerprint && (await runmark.fingerprint(harness_dir)) !== fingerprint) {
        throw new selection.ValueError("adopted harness has changed");
      }
    } catch (exc) {
      console.log(`  [${task_id}] cannot resume ${mode}: ${errText(exc)}; re-running`);
      return false;
    }
  }
  res.status = "skipped";
  res.base = ((got["base"] as Record<string, string>[]) ?? []).slice();
  res.modes = cached_modes;
  res.selections = cached_sels;
  res.errors = ((got["errors"] as string[]) ?? []).slice();
  await _restore_libraries(
    task_id,
    k,
    adapter,
    runs_root,
    modes,
    seed,
    tag,
    mode_libs,
    res.selections,
  );
  return true;
}

function errName(exc: unknown): string {
  return exc instanceof Error ? exc.constructor.name : typeof exc;
}

function errText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function _dead(label: string, rid: string, dead_dir: string, error: string): RunView {
  return makeRunView({ label, run_id: rid, run_dir: dead_dir, ok: false, delivered: false, error });
}

/** Roll the pending (label, run_id) reference executions, natively batched when possible. */
export async function _roll_bases(
  task_id: string,
  adapter: BenchmarkAdapter,
  pending: readonly (readonly [string, string])[],
  dead_dir: string,
): Promise<Record<string, RunView>> {
  if (pending.length === 0) return {};
  const rolled: Record<string, RunView> = {};
  const execute_many = (adapter as { execute_many?: unknown }).execute_many;
  if (pending.length > 1 && typeof execute_many === "function") {
    try {
      const dirs = [...(await execute_many.call(adapter, task_id, null, pending.map(([, rid]) => rid)))];
      for (let i = 0; i < pending.length; i++) {
        const [label, rid] = pending[i] as readonly [string, string];
        if (i >= dirs.length) {
          rolled[label] = _dead(label, rid, dead_dir, "batch adapter returned too few run directories");
          continue;
        }
        const rd = String(dirs[i]);
        // Python: rd.exists()(不是 is_dir)—— 批量路径的 exists 检查照抄。
        const exists = await pathExists(rd);
        rolled[label] = makeRunView({
          label,
          run_id: rid,
          run_dir: rd,
          ok: exists,
          delivered: exists && (await adapter.delivered(rd)),
          error: exists ? "" : "adapter returned a missing run directory",
        });
      }
    } catch (exc) {
      for (const [label, rid] of pending) {
        rolled[label] = _dead(label, rid, dead_dir, `${errName(exc)}: ${errText(exc)}`);
      }
    }
    return rolled;
  }

  const _one = async (label_rid: readonly [string, string]): Promise<RunView> => {
    const [label, rid] = label_rid;
    try {
      const rd = await adapter.execute(task_id, null, rid);
      return makeRunView({ label, run_id: rid, run_dir: rd, ok: true, delivered: await adapter.delivered(rd) });
    } catch (exc) {
      return _dead(label, rid, dead_dir, `${errName(exc)}: ${errText(exc)}`);
    }
  };

  if (pending.length === 1) {
    const rv = await _one(pending[0] as readonly [string, string]);
    return { [rv.label]: rv };
  }
  const width = Math.max(1, Math.min(pending.length, ROLLOUT_PARALLEL));
  const got = await mapPool(pending, width, _one);
  const out: Record<string, RunView> = {};
  for (const rv of got) out[rv.label] = rv;
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface RunOneModeOpts {
  adapter: BenchmarkAdapter;
  prop: Proposer;
  selector: Proposer;
  n: Namespace;
  runs_root: string;
  mode_lib: Library | null;
  base_tree: Tree;
  surface: harness_tree.SurfaceSpec;
  pool_policy: string;
  res: TaskResult;
}

/**
 * D11 base 留池偏差的池构造补丁(keepBaseInPool 数据开关的唯一生效点):
 * `selection_pool` 构造 finals 池时排除 base(harness2 "base is what the
 * pool excludes"),本函数在调用侧把 base rollouts 并回。base label 形如
 * base1..basek,selection 侧 `_is_base` 据此识别(选中 base ⟹ 不采纳由
 * `chosen_is_base` 表达;选择器失败的 `_fallback` 以同标签回退 base)。
 * 默认路径不调用——开关为假时池与 harness2 逐字节同构,引擎其余逻辑不动。
 */
export function poolWithBase(
  pool: Readonly<Record<string, RunView>>,
  base: readonly RunView[],
): Record<string, RunView> {
  const out: Record<string, RunView> = { ...pool };
  for (const b of base) out[b.label] = b;
  return out;
}

/** Run one recursion mode over the shared bases, select a final, and record it on `res`. */
export async function _run_one_mode(
  mode: string,
  task_id: string,
  k: number,
  base: readonly RunView[],
  opts: RunOneModeOpts,
): Promise<void> {
  const { adapter, prop, selector, n, runs_root, mode_lib, base_tree, surface, pool_policy, res } = opts;
  const work_dir = n.task_dir(runs_root, task_id);
  const lib_dir = mode_lib ? await mode_lib.context_dir() : null;
  const r = await recursion.run_mode(mode, task_id, k, base, {
    adapter,
    prop,
    work_dir,
    run_id_of: (lbl: string) => n.run_id(task_id, lbl),
    base_tree,
    library_dir: lib_dir,
  });
  res.modes[mode] = r.to_dict();
  // D11 keepBaseInPool:池构造处并回 base(见 poolWithBase)。留池下 k=1
  // 也走真选择——trivial_selection 的"至多一个候选"契约与留池不兼容,
  // 且我们不能退化:选择器必须有机会选中 base(选中 ⟹ 不采纳)。
  const keepBaseInPool = adapter.spec.keepBaseInPool === true;
  const finals = selection.selection_pool(mode, k, r.rollouts, base);
  const candidates = keepBaseInPool ? poolWithBase(finals, base) : finals;
  let sel: selection.Selection;
  if (pool_policy === "finals" && k === 1 && !keepBaseInPool) {
    sel = await selection.trivial_selection(task_id, k, mode, candidates, { adapter, work_dir });
  } else {
    sel = await selection.run_selection(task_id, k, mode, candidates, {
      adapter,
      prop: selector,
      work_dir,
      pool_kind: "finals",
    });
  }
  if (mode_lib && sel.ok) {
    await selection.reflect_adoption(task_id, sel, r.rollouts, {
      adapter,
      prop: selector,
      work_dir,
      decisions: Object.fromEntries(
        r.stages.map((stage) => [stage.label, stage.notes || stage.error]),
      ),
    });
  }
  const d = sel.to_dict() as Record<string, unknown>;
  const chosen = sel.chosen_label ? candidates[sel.chosen_label] : undefined;
  d["chosen_run_dir"] = chosen ? chosen.run_dir : "";
  const chosen_tree = r.trees[sel.chosen_label] ?? base_tree;
  const chosen_tree_is_base = _tree_is_base(surface, base_tree, chosen_tree);
  d["chosen_tree_is_base"] = chosen_tree_is_base;
  if (sel.chosen_label) {
    d["harness_fingerprint"] = await runmark.fingerprint(join(work_dir, "harnesses", sel.chosen_label));
  }
  res.selections[mode] = d;
  if (!sel.ok) {
    res.errors.push(`${mode}: selection failed: ${sel.error}`);
  }
  if (sel.ok && chosen && !chosen.delivered) {
    res.errors.push(`${mode}: selected run ${chosen.run_id} produced no deliverable`);
  }
  if (mode_lib && sel.ok && library_store.has_experience(sel.experience)) {
    await mode_lib.add(task_id, chosen_tree, {
      why: sel.why,
      label: sel.chosen_label,
      run_id: sel.chosen_run_id,
      experience: sel.experience,
    });
  }
}

export interface RunTaskOpts {
  adapter: BenchmarkAdapter;
  prop: Proposer;
  runs_root: string;
  modes?: readonly string[];
  seed?: number | null;
  tag?: string;
  library?: Library | null;
  libraries?: Record<string, Library> | null;
  selector_prop?: Proposer | null;
  pool_policy?: string;
}

/**
 * k shared reference executions -> every mode -> blind selection per mode -> summary.json.
 *
 * `seed` enters every namespace and the summary metadata; ordering tasks by it is the
 * caller's job. `pool_policy` is "finals" — exactly the k finals per mode, the published
 * convention and the only pool this release builds.
 */
export async function run_task(
  task_id: string,
  k: number,
  opts: RunTaskOpts,
): Promise<TaskResult> {
  const {
    adapter,
    prop,
    runs_root,
    modes = MODES,
    seed = null,
    tag = "",
    library = null,
    libraries = null,
    selector_prop = null,
    pool_policy = "finals",
  } = opts;
  if (Math.trunc(k) < 1) {
    throw new selection.ValueError(`k must be positive, got ${pyRepr(k)}`);
  }
  if (modes.length === 0 || new Set(modes).size !== modes.length) {
    throw new selection.ValueError("modes must contain at least one distinct recursion mode");
  }
  const unknown = [...new Set(modes)].filter((m) => !(MODES as readonly string[]).includes(m)).sort();
  if (unknown.length > 0) {
    throw new selection.ValueError(
      `unknown modes ${pyListRepr(unknown)}; expected a subset of ${pyTupleRepr(MODES)}`,
    );
  }
  if (pool_policy !== "finals") {
    throw new selection.ValueError(
      `unknown pool_policy ${pyRepr(pool_policy)}; this release builds exactly ` +
        "one selection pool, 'finals' (the k composed finals)",
    );
  }
  const mode_libs = _resolve_libraries(library, libraries, modes);
  const selector = _selector_for(adapter, prop, selector_prop);
  const bench = adapter.spec.name;
  const sub = adapter.substrate.name;

  const domain = adapter.domain_of(task_id);
  const res = new TaskResult({ task_id, domain, k, seed });
  const base_ns = new Namespace(bench, sub, "agg", k, seed, tag);
  const work = base_ns.task_dir(runs_root, task_id);
  await fs.mkdir(work, { recursive: true });
  const summary_path = join(work, "summary.json");

  if (fsp.existsSync(summary_path) && (await _resume(summary_path, task_id, k, adapter, runs_root, modes, seed, tag, mode_libs, res))) {
    return res;
  }

  const surface = adapter.substrate.surface();
  const base_tree = await harness_tree.read_tree(surface, await adapter.base_harness());

  const labels = Array.from({ length: k }, (_, i) => `base${i + 1}`);
  const run_ids = labels.map((label) => base_ns.run_id(task_id, label));

  const dead_dir = join(work, "missing");

  const pending = labels.map((label, i) => [label, run_ids[i] as string] as const);
  const rolled = await _roll_bases(task_id, adapter, pending, dead_dir);
  const base: RunView[] = labels.map((label) => rolled[label] as RunView);

  res.base = base.map((b) => ({ label: b.label, run_id: b.run_id, run_dir: String(b.run_dir) }));
  if (!base.some((b) => b.ok)) {
    res.status = "base-failed";
    res.errors.push("no base rollout produced anything");
    await _write_summary(summary_path, res);
    return res;
  }

  for (const mode of modes) {
    const n = new Namespace(bench, sub, mode, k, seed, tag);
    try {
      await _run_one_mode(mode, task_id, k, base, {
        adapter,
        prop,
        selector,
        n,
        runs_root,
        mode_lib: mode_libs[mode] ?? null,
        base_tree,
        surface,
        pool_policy,
        res,
      });
    } catch (exc) {
      const stack = exc instanceof Error ? (exc.stack ?? exc.message) : String(exc);
      res.modes[mode] = {
        ok: false,
        error: `${errName(exc)}: ${errText(exc)}`,
        traceback: stack.slice(-1500),
      };
      res.errors.push(`${mode}: ${errName(exc)}: ${errText(exc)}`);
    }
    res.status = "partial";
    await _write_summary(summary_path, res);
  }

  res.status = _merged_status(res.to_dict());
  await _write_summary(summary_path, res);
  return res;
}

export interface RunDomainOpts {
  adapter: BenchmarkAdapter;
  prop: Proposer;
  runs_root: string;
  library_root: string;
  modes?: readonly string[];
  seed?: number | null;
  tag?: string;
  selector_prop?: Proposer | null;
  pool_policy?: string;
}

export interface DomainRow {
  task: string;
  status: string;
  library_entries_before?: Record<string, number>;
  error?: string;
}

export interface DomainResult {
  domain: string;
  n_tasks: number;
  seed: number | null;
  done: number;
  failed: number;
  tasks: DomainRow[];
}

/** Every task in one domain, in `stream_order()` order, threading the library forward. */
export async function run_domain(
  domain: string,
  task_ids: readonly string[],
  k: number,
  opts: RunDomainOpts,
): Promise<DomainResult> {
  const {
    adapter,
    prop,
    runs_root,
    library_root,
    modes = MODES,
    seed = null,
    tag = "",
    selector_prop = null,
    pool_policy = "finals",
  } = opts;
  const surface = adapter.substrate.surface();
  const libs: Record<string, Library> = {};
  for (const mode of modes) {
    libs[mode] = new library_store.Library(join(library_root, mode), domain, surface);
  }
  const out: DomainResult = {
    domain,
    n_tasks: task_ids.length,
    seed,
    done: 0,
    failed: 0,
    tasks: [],
  };
  for (let i = 0; i < task_ids.length; i++) {
    const tid = task_ids[i] as string;
    let row: DomainRow;
    try {
      for (const lib of Object.values(libs)) {
        await lib.retain([...task_ids].slice(0, i));
      }
      const before: Record<string, number> = {};
      for (const [mode, lib] of Object.entries(libs)) {
        before[mode] = (await lib.entries()).length;
      }
      const r = await run_task(tid, k, {
        adapter,
        prop,
        runs_root,
        modes,
        seed,
        tag,
        libraries: libs,
        selector_prop,
        pool_policy,
      });
      if (r.status === "ok" || r.status === "skipped") {
        out.done += 1;
        row = { task: tid, status: r.status, library_entries_before: before };
      } else {
        out.failed += 1;
        row = {
          task: tid,
          status: r.status,
          error: r.errors.length ? r.errors.join("; ") : r.status,
          library_entries_before: before,
        };
      }
    } catch (exc) {
      out.failed += 1;
      row = { task: tid, status: "exception", error: `${errName(exc)}: ${errText(exc)}` };
    }
    out.tasks.push(row);
    const err = row.error ? `  :: ${row.error}` : "";
    console.log(`  [${domain}] ${i + 1}/${task_ids.length} ${row.status.padEnd(12)} ${tid}${err}`);
  }
  return out;
}

export interface TaskStreamOpts {
  split?: string;
  seed?: number | null;
  only_domains?: readonly string[];
  only_tasks?: readonly string[];
  max_tasks?: number | null;
}

/** Resolve the ordered task stream for execution, previews, and resume identity. */
export async function task_stream(
  adapter: BenchmarkAdapter,
  opts: TaskStreamOpts = {},
): Promise<Record<string, string[]>> {
  const {
    split = "all",
    seed = null,
    only_domains = [],
    only_tasks = [],
    max_tasks = null,
  } = opts;
  const by_domain: Record<string, string[]> = {};
  for (const t of await adapter.tasks(split)) {
    const d = adapter.domain_of(t);
    (by_domain[d] ??= []).push(t);
  }
  let domainMap: Record<string, string[]> = by_domain;
  if (only_domains.length > 0) {
    const keep = new Set(only_domains);
    const missing = [...keep].filter((d) => !(d in by_domain)).sort();
    if (missing.length > 0) {
      throw new selection.ValueError(
        `only_domains names unknown domain(s) ${pyListRepr(missing)}; split ` +
          `${pyRepr(split)} has ${pyListRepr(Object.keys(by_domain).sort())}`,
      );
    }
    domainMap = Object.fromEntries(
      Object.entries(by_domain).filter(([d]) => keep.has(d)),
    );
  }
  if (only_tasks.length > 0) {
    const wanted = new Set(only_tasks);
    const all = new Set(Object.values(domainMap).flat());
    const missing_t = [...wanted].filter((t) => !all.has(t)).sort();
    if (missing_t.length > 0) {
      throw new selection.ValueError(
        `only_tasks names unknown task id(s) ${pyListRepr(missing_t)} for split ` +
          `${pyRepr(split)}` +
          (only_domains.length ? ` / domains ${pyListRepr(Object.keys(domainMap).sort())}` : ""),
      );
    }
  }
  if (max_tasks !== null && Math.trunc(max_tasks) < 1) {
    throw new selection.ValueError(`max_tasks must be positive, got ${pyRepr(max_tasks)}`);
  }

  const stream = stream_order(domainMap, seed, _reference_domain_order(adapter, domainMap));
  const ordered_tasks: Record<string, string[]> = {};
  const wantedSet = new Set(only_tasks);
  for (const [d, t] of stream) {
    if (only_tasks.length > 0 && !wantedSet.has(t)) continue;
    if (max_tasks !== null && (ordered_tasks[d] ?? []).length >= Math.trunc(max_tasks)) continue;
    (ordered_tasks[d] ??= []).push(t);
  }
  return ordered_tasks;
}

export interface RunSweepOpts {
  adapter: BenchmarkAdapter;
  prop: Proposer;
  runs_root: string;
  library_root: string;
  split?: string;
  modes?: readonly string[];
  seed?: number | null;
  tag?: string;
  domain_parallel?: number;
  only_domains?: readonly string[];
  selector_prop?: Proposer | null;
  pool_policy?: string;
  max_tasks?: number | null;
  only_tasks?: readonly string[];
}

export interface SweepResult {
  benchmark: string;
  substrate: string;
  k: number;
  modes: string[];
  seed: number | null;
  tag: string;
  domain_order: string[];
  max_tasks: number | null;
  only_tasks: string[];
  started_at: string;
  finished_at: string;
  n_domains: number;
  domains: (DomainResult | { domain: string; error: string })[];
}

/**
 * Run domains concurrently, preserving task order after stream filters are applied.
 *
 * 聚合顺序显式化:Python 用 as_completed(完成序,竞速副产品);TS 按 domain 序
 * (order)聚合。结果顺序成为规范不变量 —— 同一输入的 sweep 报告行序可复现。
 * 单域抛出的意外异常按行收口({domain, error}),不拖垮同轮其它域。
 */
export async function run_sweep(
  k: number,
  opts: RunSweepOpts,
): Promise<SweepResult> {
  const {
    adapter,
    prop,
    runs_root,
    library_root,
    split = "all",
    modes = MODES,
    seed = null,
    tag = "",
    domain_parallel = 1,
    only_domains = [],
    selector_prop = null,
    pool_policy = "finals",
    max_tasks = null,
    only_tasks = [],
  } = opts;
  const ordered_tasks = await task_stream(adapter, {
    split,
    seed,
    only_domains,
    only_tasks,
    max_tasks,
  });
  const order = Object.keys(ordered_tasks);

  // datetime.now(timezone.utc).isoformat() 的 "+00:00" 在 TS 呈现为 toISOString() 的
  // 尾缀 "Z" —— 时刻等值,字符串形态是记录在案的格式偏差。
  const started = new Date().toISOString();
  const selector = _selector_for(adapter, prop, selector_prop);
  const rows = await mapPool(order, Math.max(1, Math.trunc(domain_parallel)), async (d) => {
    try {
      return await run_domain(d, ordered_tasks[d] as string[], k, {
        adapter,
        prop,
        runs_root,
        library_root,
        modes,
        seed,
        tag,
        selector_prop: selector,
        pool_policy,
      });
    } catch (exc) {
      return { domain: d, error: `${errName(exc)}: ${errText(exc)}` };
    }
  });
  return {
    benchmark: adapter.spec.name,
    substrate: adapter.substrate.name,
    k,
    modes: [...modes],
    seed,
    tag,
    domain_order: order,
    max_tasks,
    only_tasks: [...only_tasks],
    started_at: started,
    finished_at: new Date().toISOString(),
    n_domains: order.length,
    domains: rows,
  };
}
