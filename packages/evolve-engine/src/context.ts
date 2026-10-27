// context.ts — harness2/core/context.py 的 TypeScript 移植(逐段对应)。
// 证据树是 proposer 能读到的唯一证据入口;证据以文件形式供给,mission 只是短指针,
// 因此没有任何东西为了塞进 prompt 而被截断。
//
//   context/task.md                  任务原文
//   context/rollouts/<label>.md      完整轨迹 —— 不按 prompt 预算截断
//   context/deliverables/<label>.md  产出物(judge 自己的抽取器导出)
//   context/harness/<rel>            正在被编辑的 c1..c8 树
//   context/library/INDEX.md         同域更早任务 + 完整 harness
//   context/pool/<label>/            候选 harness + 其 rollout(仅 aggregate/select)
//   MISSION.md                       拿它们做什么
//
// 移植说明:
// - Python 函数为同步 I/O;TS 侧 adapter 轨迹/产出物读取是 async,相应 await。
// - getattr(adapter, "x", None) + callable → typeof 检查 + 可选方法。
// - type(exc).__name__ → e.constructor.name(与 judge.ts 同一有界偏差)。
// - fnmatch.fnmatch → fnmatchCase(Python 在 POSIX 上即大小写敏感;
//   os.path.normcase 在 POSIX 为恒等)。
// - difflib.unified_diff → ./difflib.js(逐字节对齐)。

import * as fs from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import { splitKeepEnds, unifiedDiff } from "./difflib.js";
import { pyListRepr, pyRepr, pyComma } from "./pyutil.js";
import * as harness_tree from "./tree.js";
import type { BenchmarkAdapter, RunView } from "./spec.js";

/** Python fnmatch.translate 的大小写敏感形态(* 跨目录,? 任意单字符,[seq]/[!seq])。 */
function fnmatchCase(name: string, pat: string): boolean {
  let rx = "";
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === "*") {
      rx += ".*";
    } else if (c === "?") {
      rx += ".";
    } else if (c === "[") {
      let j = i + 1;
      let cls = "";
      if (pat[j] === "!") {
        cls = "^";
        j++;
      }
      // Python fnmatch:[] 里的 ']' 作为首字符(含 ! 之后)时是字面量。
      if (pat[j] === "]") {
        cls += "\\]";
        j++;
      }
      while (j < pat.length && pat[j] !== "]") {
        const ch = pat[j];
        if (ch === "\\") {
          // fnmatch.translate 对反斜杠按字面转义。
          cls += "\\\\";
        } else if (ch === "-") {
          cls += "-";
        } else if (/[.^$?*+()[\]{}|\\]/.test(ch)) {
          cls += `\\${ch}`;
        } else {
          cls += ch;
        }
        j++;
      }
      if (j >= pat.length) {
        // 未闭合的 '[' 在 Python fnmatch 中按字面量处理。
        rx += "\\[";
      } else {
        rx += `[${cls}]`;
        i = j;
      }
    } else if (/[.^$?*+()[\]{}|\\]/.test(c)) {
      rx += `\\${c}`;
    } else {
      rx += c;
    }
    i++;
  }
  return new RegExp(`^(?:${rx})$`).test(name);
}

/** Python str.lstrip("./"):剥去头部所有 '.' 与 '/' 字符。 */
function lstripDots(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === "." || s[i] === "/")) i++;
  return s.slice(i);
}

function errText(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e));
  return `${err.constructor.name}: ${err.message}`;
}

/** Python {n:,} 的千分位(转调 pyutil)。 */
const withCommas = pyComma;

/** 递归列出相对 posix 路径(仅文件),按 sorted(rglob) 的字典序。 */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const p = join(dir, name);
      let st;
      try {
        st = await fs.stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) await rec(p);
      else out.push(relative(root, p).split(sep).join("/"));
    }
  }
  await rec(root);
  return out.sort();
}

export class ContextTree {
  root: string;
  task_id: string;
  rollouts: string[];
  deliverables: string[];
  harness_files: number;
  library: boolean;
  pool: string[];
  failed: string[];

  deliverables_mode: string;
  source_files: number;
  decisions: number;

  constructor(init: {
    root: string;
    task_id: string;
    rollouts: string[];
    deliverables: string[];
    harness_files: number;
    library: boolean;
    pool: string[];
    failed?: string[];
    deliverables_mode?: string;
    source_files?: number;
    decisions?: number;
  }) {
    this.root = init.root;
    this.task_id = init.task_id;
    this.rollouts = init.rollouts;
    this.deliverables = init.deliverables;
    this.harness_files = init.harness_files;
    this.library = init.library;
    this.pool = init.pool;
    this.failed = init.failed ?? [];
    this.deliverables_mode = init.deliverables_mode ?? "contents";
    this.source_files = init.source_files ?? 0;
    this.decisions = init.decisions ?? 0;
  }

  /** 进 mission 的证据布局清单;只提实际存在的部分。 */
  get layout(): string {
    const lines = ["context/task.md                  the task as the agent received it"];
    if (this.source_files) {
      lines.push("context/source/                 task source materials");
    }
    if (this.decisions) {
      lines.push("context/decisions/              earlier edits and composition decisions");
    }
    if (this.rollouts.length > 0) {
      const names = this.rollouts.slice(0, 6).map((r) => `${r}.md`).join(", ");
      const more = this.rollouts.length > 6 ? ` (+${this.rollouts.length - 6} more)` : "";
      lines.push(`context/rollouts/               FULL trajectories: ${names}${more}`);
    }
    if (this.deliverables.length > 0) {
      if (this.deliverables_mode === "names") {
        lines.push(
          "context/deliverables/<label>/    INDEX.md lists WHICH files each " +
            "rollout produced -- names only.",
        );
        lines.push(
          "                                 File contents are deliberately " +
            "not provided on this benchmark; work from the trajectories and " +
            "the file set itself.",
        );
      } else {
        lines.push(
          "context/deliverables/<label>/    the files each rollout produced, " +
            "one per artifact (browse INDEX.md for the set)",
        );
      }
    }
    if (this.harness_files) {
      lines.push(
        `context/harness/                the harness you are editing ` +
          `(${this.harness_files} files)`,
      );
    }
    if (this.pool.length > 0) {
      lines.push(
        `context/pool/                   ${this.pool.length} candidates, each ` +
          `with its harness and its rollout`,
      );
    }
    if (this.library) {
      lines.push(
        "context/library/                earlier tasks in this " +
          "area -- browse INDEX.md first, then open what looks relevant",
      );
    }
    return lines.join("\n");
  }
}

export interface BuildOptions {
  harness_dir?: string | null;
  library_dir?: string | null;
  pool?: readonly (readonly [string, string, RunView | null])[];
  decisions?: Readonly<Record<string, string>> | null;
  obs_trunc?: number | null;
}

/**
 * 写出证据树;返回实际落进去的内容,mission 只描述这些。
 * `obs_trunc` 按观测粒度截断,整条轨迹仍全文写入。
 */
export async function build(
  dest: string,
  adapter: BenchmarkAdapter,
  task_id: string,
  rollouts: readonly RunView[] = [],
  opts: BuildOptions = {},
): Promise<ContextTree> {
  const decisions = opts.decisions ?? null;
  if (await exists(dest)) {
    await fs.rm(dest, { recursive: true, force: true });
  }
  await fs.mkdir(dest, { recursive: true });
  const trunc = opts.obs_trunc != null ? opts.obs_trunc : adapter.spec.obs_trunc;

  await fs.writeFile(join(dest, "task.md"), adapter.task_prompt(task_id), "utf8");
  const source_files = await copySource(adapter, task_id, dest);
  for (const [label, notes] of Object.entries(decisions ?? {})) {
    const path = join(dest, "decisions", `${label}.md`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, notes || "No decision notes returned.", "utf8");
  }

  const got_r: string[] = [];
  const got_d: string[] = [];
  const failed_r: string[] = [];
  if (rollouts.length > 0) {
    await fs.mkdir(join(dest, "rollouts"), { recursive: true });
    await fs.mkdir(join(dest, "deliverables"), { recursive: true });
  }
  const names_only = adapter.spec.proposer_deliverables === "names";
  for (const r of rollouts) {
    const failure = await writeRollout(dest, r, adapter, trunc, names_only);
    if (failure) {
      failed_r.push(failure);
    } else {
      got_r.push(r.label);
    }
    got_d.push(r.label);
  }

  let n_h = 0;
  if (opts.harness_dir && (await isDir(opts.harness_dir))) {
    assert_no_leak_paths(opts.harness_dir, adapter.spec.leak_globs);
    n_h = await copyTreeFiltered(opts.harness_dir, join(dest, "harness"));
  }

  const got_p = await writePool(dest, opts.pool ?? [], adapter, trunc, names_only);

  let lib = false;
  if (opts.library_dir && (await isDir(opts.library_dir)) && (await hasAnyEntry(opts.library_dir))) {
    assert_no_leak_paths(opts.library_dir, adapter.spec.leak_globs);
    await fs.cp(opts.library_dir, join(dest, "library"), { recursive: true, force: true });
    lib = true;
  }

  assert_no_leak_paths(dest, adapter.spec.leak_globs);
  assert_no_grader_verdicts(dest);

  if (rollouts.length > 0 && got_r.length === 0) {
    throw new Error(
      "no trajectory could be rendered for ANY rollout -- the proposer would be adapting " +
        "on nothing: " +
        failed_r.slice(0, 4).join("; "),
    );
  }
  return new ContextTree({
    root: dest,
    task_id,
    rollouts: got_r,
    deliverables: got_d,
    harness_files: n_h,
    library: lib,
    pool: got_p,
    failed: failed_r,
    deliverables_mode: names_only ? "names" : "contents",
    source_files,
    decisions: Object.keys(decisions ?? {}).length,
  });
}

/** 拷贝任务源材料到 `root/source`,跳过答案键路径。 */
export async function copySource(
  adapter: BenchmarkAdapter,
  task_id: string,
  root: string,
): Promise<number> {
  const fn = (adapter as { task_files?: unknown }).task_files;
  if (typeof fn !== "function") return 0;
  const src = await (fn as (id: string) => Promise<string | null>).call(adapter, task_id);
  if (!src || !(await isDir(src))) return 0;
  const dst = join(root, "source");
  let src_n = 0;
  for (const rel of await walkFiles(src)) {
    if (rel.split("/").includes("__pycache__")) continue;
    if (
      adapter.spec.leak_globs.some((g) => {
        const pat = lstripDots(g);
        return fnmatchCase(rel, pat) || fnmatchCase(rel, `*/${pat}`);
      })
    ) {
      continue;
    }
    const t = join(dst, rel);
    await fs.mkdir(dirname(t), { recursive: true });
    await fs.cp(join(src, rel), t, { force: true });
    src_n++;
  }
  if (src_n > 0) {
    assert_no_leak_paths(dst, adapter.spec.leak_globs);
  }
  return src_n;
}

async function writeRollout(
  dest: string,
  r: RunView,
  adapter: BenchmarkAdapter,
  trunc: number,
  names_only: boolean,
): Promise<string> {
  let failure = "";
  try {
    await fs.writeFile(
      join(dest, "rollouts", `${r.label}.md`),
      await adapter.trajectory(r.run_dir, { obs_trunc: trunc }),
      "utf8",
    );
  } catch (e) {
    await fs.writeFile(
      join(dest, "rollouts", `${r.label}.md`),
      `(trajectory unavailable: ${errText(e)})`,
      "utf8",
    );
    failure = `${r.label}: ${errText(e)}`;
  }

  let per_file: Record<string, string> = {};
  if (names_only) {
    await writeListing(join(dest, "deliverables", r.label), r.label, await listing(adapter, r.run_dir));
  } else {
    const filesFn = (adapter as { deliverable_files?: unknown }).deliverable_files;
    if (typeof filesFn === "function") {
      per_file = {
        ...((await (filesFn as (d: string) => Promise<Record<string, string>>).call(
          adapter,
          r.run_dir,
        )) ?? {}),
      };
    }
  }
  if (Object.keys(per_file).length === 0) {
    if (!names_only) {
      let text: string;
      try {
        text = (await adapter.deliverable_text(r.run_dir)) || "(no deliverable produced)";
      } catch (e) {
        text = `(deliverable unavailable: ${errText(e)})`;
      }
      await fs.writeFile(join(dest, "deliverables", `${r.label}.md`), text, "utf8");
    }
    return failure;
  }

  const d = join(dest, "deliverables", r.label);
  await fs.mkdir(d, { recursive: true });
  for (const img of (await images(adapter, r.run_dir)).slice(0, 8)) {
    try {
      const t = join(d, "images", basename(img));
      await fs.mkdir(dirname(t), { recursive: true });
      await fs.cp(img, t, { force: true });
    } catch {
      // OSError: 图像拷不进去不阻断证据构建。
    }
  }
  for (const [name, body] of Object.entries(per_file)) {
    const safe = String(name).replaceAll("/", "__") || "unnamed";
    const suffix = safe.endsWith(".txt") ? "" : ".txt";
    await fs.writeFile(join(d, `${safe}${suffix}`), String(body), "utf8");
  }
  const rawFn = (adapter as { deliverable_assets?: unknown }).deliverable_assets;
  const raw_names: string[] = [];
  const rawList: string[] =
    typeof rawFn === "function"
      ? await (rawFn as (d: string) => Promise<string[]>).call(adapter, r.run_dir)
      : [];
  for (const src of rawList) {
    const t = join(d, "raw", basename(src));
    await fs.mkdir(dirname(t), { recursive: true });
    await fs.cp(src, t, { force: true });
    raw_names.push(basename(src));
  }
  const raw_note = raw_names.length
    ? "\n\n`raw/` holds the binary originals of the artifacts above (same names). " +
      "The rendered\n`.txt` view is CANONICAL -- it reads each artifact the way the " +
      "grader does (a formula\nwith no cached value renders as the empty cell the " +
      "grader sees, even though the raw\nworkbook computes it on open). Open a raw " +
      "file only for detail the rendering flattened,\nnever to overrule it.\n"
    : "";
  const items = Object.entries(per_file)
    .map(([n, b]) => `- \`${n}\`  (${withCommas(String(b).length)} chars extracted)`)
    .join("\n");
  await fs.writeFile(
    join(d, "INDEX.md"),
    `# ${r.label} produced ${Object.keys(per_file).length} file(s)\n\n` +
      items +
      "\n\nEach `.txt` is the artifact converted to text by the SAME reader the " +
      "work\nis assessed through, so reason about correctness from these -- an " +
      "artifact\nthat does not survive that conversion is treated as unreadable " +
      "however good\nit looks. `images/` holds any images from the same set, which " +
      "are also part\nof how the work is read.\n" +
      raw_note,
    "utf8",
  );
  return failure;
}

async function writePool(
  dest: string,
  pool: readonly (readonly [string, string, RunView | null])[],
  adapter: BenchmarkAdapter,
  trunc: number,
  names_only: boolean,
): Promise<string[]> {
  const got: string[] = [];
  for (const [label, candDir, roll] of pool) {
    const d = join(dest, "pool", label);
    await fs.mkdir(d, { recursive: true });
    if (candDir && (await isDir(candDir))) {
      assert_no_leak_paths(candDir, adapter.spec.leak_globs);
      await copyTreeFiltered(candDir, join(d, "harness"));
      const surface = adapter.substrate.surface();
      const reference = await harness_tree.read_tree(surface, join(dest, "harness"));
      const candidate = await harness_tree.read_tree(surface, candDir);
      // Python: sorted(reference.keys() | candidate.keys())
      const diff = [...new Set([...Object.keys(reference), ...Object.keys(candidate)])]
        .sort()
        .flatMap((name) =>
          unifiedDiff(
            splitKeepEnds(reference[name] ?? ""),
            splitKeepEnds(candidate[name] ?? ""),
            `current/${name}`,
            `${label}/${name}`,
          ),
        )
        .join("");
      await fs.writeFile(join(d, "harness.diff"), diff, "utf8");
    }
    if (roll !== null && roll !== undefined) {
      try {
        await fs.writeFile(
          join(d, "rollout.md"),
          await adapter.trajectory(roll.run_dir, { obs_trunc: trunc }),
          "utf8",
        );
        const produced = names_only
          ? listingMd(label, await listing(adapter, roll.run_dir))
          : (await adapter.deliverable_text(roll.run_dir)) || "(nothing produced)";
        await fs.writeFile(join(d, "produced.md"), produced, "utf8");
      } catch (e) {
        await fs.writeFile(join(d, "rollout.md"), `(unavailable: ${e instanceof Error ? e.message : String(e)})`, "utf8");
      }
    }
    got.push(label);
  }
  return got;
}

async function listing(adapter: BenchmarkAdapter, run_dir: string): Promise<string[]> {
  const fn = (adapter as { deliverable_listing?: unknown }).deliverable_listing;
  if (typeof fn !== "function") {
    return [
      "(this adapter declares proposer_deliverables='names' but implements no " +
        "deliverable_listing -- nothing can be listed)",
    ];
  }
  try {
    const got = await (fn as (d: string) => Promise<string[]>).call(adapter, run_dir);
    return (got ?? []).map((x) => String(x));
  } catch (e) {
    return [`(listing unavailable: ${errText(e)})`];
  }
}

const WITHHELD_NOTE =
  "CONTENTS ARE WITHHELD ON THIS PATH, DELIBERATELY. You are shown WHICH files the rollout\n" +
  "produced and not what is inside them. This is not an oversight and not a size budget:\n" +
  "on this benchmark the extracted-deliverable tree lives inside the same trial directory as\n" +
  "the grader's own output, so serving file bodies here once served the grader's pass rate\n" +
  "and failed-check names along with them. Reason about the work from the TRAJECTORY -- what\n" +
  "was attempted, what was observed, what the run did with what it saw -- and from the file\n" +
  "set itself, which is evidence in its own right: the task names the artifacts it expects,\n" +
  "so a missing or misnamed file is a finding. Do not ask for the contents and do not infer\n" +
  "that an unlisted file is empty.\n";

function listingMd(label: string, names: string[]): string {
  return (
    `# ${label} produced ${names.length} file(s)\n\n` +
    `${label}: ${pyListRepr(names)}\n\n` +
    names.map((n) => `- \`${n}\``).join("\n") +
    "\n\n" +
    WITHHELD_NOTE
  );
}

async function writeListing(d: string, label: string, names: string[]): Promise<void> {
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(join(d, "INDEX.md"), listingMd(label, names), "utf8");
}

async function images(adapter: BenchmarkAdapter, run_dir: string): Promise<string[]> {
  const fn = (adapter as { deliverable_images?: unknown }).deliverable_images;
  if (typeof fn !== "function") return [];
  return (await (fn as (d: string) => Promise<string[]>).call(adapter, run_dir)).map((p) =>
    String(p),
  );
}

/** 拷贝组件树,丢掉字节编译产物;返回文件数(对应 Python _copy_tree)。 */
async function copyTreeFiltered(src: string, dst: string): Promise<number> {
  let n = 0;
  for (const rel of await walkFiles(src)) {
    if (rel.split("/").includes("__pycache__") || rel.endsWith(".pyc")) continue;
    const t = join(dst, rel);
    await fs.mkdir(dirname(t), { recursive: true });
    await fs.cp(join(src, rel), t, { force: true });
    n++;
  }
  return n;
}

/** 模型上下文前拒绝 benchmark 声明的答案键路径。 */
export function assert_no_leak_paths(root: string, patterns: readonly string[]): void {
  if (!patterns || patterns.length === 0 || !isDirSync(root)) return;
  const hits: string[] = [];
  for (const p of walkFilesSync(root)) {
    for (const pattern of patterns) {
      const pat = lstripDots(String(pattern).replaceAll("\\", "/"));
      if (fnmatchCase(p, pat) || fnmatchCase(p, `*/${pat}`)) {
        hits.push(p);
        break;
      }
    }
  }
  if (hits.length > 0) {
    const shown = hits.sort().slice(0, 8).join(", ");
    throw new Error(`answer-key path(s) would enter model context: ${shown}`);
  }
}

export const GRADER_VERDICT_MARKERS: readonly string[] = [
  "deterministic_eval_summary",
  "deterministic_eval_result",
  "judge_scope_and_deterministic_status",
  "Judge findings on the rendered result",
  '"passed_count"',
  '"pass_rate"',
  '"test_pass_rate"',
];

const MARKER_SCAN_SUFFIXES = new Set([
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".html",
  ".htm",
  ".log",
  ".py",
  ".js",
  ".sh",
  ".xml",
  ".ini",
  ".toml",
  ".patch",
  ".diff",
  "",
]);

function markerSnippet(body: string, where: number): string {
  return pyRepr(body.slice(Math.max(0, where - 60), where + 120));
}

/**
 * 拒绝含 grader 自身输出的上下文树,按文件名与内容双重查。
 * 这是 adapter 读边界上的绊线而非防线:真触发时去修产出匹配的读路径,而不是扩充 marker 列表。
 */
export function assert_no_grader_verdicts(
  root: string,
  markers: readonly string[] = GRADER_VERDICT_MARKERS,
): void {
  if (!markers || markers.length === 0 || !isDirSync(root)) return;
  for (const rel of walkFilesSync(root)) {
    for (const m of markers) {
      if (rel.includes(m)) {
        throw new Error(
          `grader verdict would enter model context: ${pyRepr(rel)} matched marker ${pyRepr(m)} ` +
            `in its NAME. The tripwire in core.context fired -- this is a leak, not ` +
            `a false positive to widen around. Find the read path that produced it.`,
        );
      }
    }
    if (!MARKER_SCAN_SUFFIXES.has(extname(rel).toLowerCase())) continue;
    let body: string;
    try {
      body = readFileSyncUtf8(join(root, rel));
    } catch {
      continue;
    }
    for (const m of markers) {
      const where = body.indexOf(m);
      if (where >= 0) {
        throw new Error(
          `grader verdict would enter model context: ${pyRepr(rel)} contains marker ${pyRepr(m)} ` +
            `at offset ${where} (${markerSnippet(body, where)}). The ` +
            `tripwire in core.context fired -- this is a leak, not a false positive ` +
            `to widen around. Find the read path that produced it.`,
        );
      }
    }
  }
}

/**
 * 同一绊线用于 agent 编写树(rel -> body),在滚动/入库前把关:
 * 带这些字符串的文件永远无法作为证据供给后续任务。
 */
export function assert_tree_has_no_grader_verdicts(
  tree: Readonly<Record<string, string>>,
  markers: readonly string[] = GRADER_VERDICT_MARKERS,
): void {
  for (const rel of Object.keys(tree).sort()) {
    for (const m of markers) {
      if (rel.includes(m)) {
        throw new Error(
          `harness file ${pyRepr(rel)} has grader-verdict marker ${pyRepr(m)} in its NAME; rename ` +
            `it -- files carrying these strings cannot be served as evidence to later ` +
            `tasks`,
        );
      }
    }
    if (!MARKER_SCAN_SUFFIXES.has(extname(rel).toLowerCase())) continue;
    const body = String(tree[rel]);
    for (const m of markers) {
      const where = body.indexOf(m);
      if (where >= 0) {
        throw new Error(
          `harness file ${pyRepr(rel)} contains grader-verdict marker ${pyRepr(m)} at offset ` +
            `${where} (${markerSnippet(body, where)}); remove or rename ` +
            `that string -- files carrying it cannot be served as evidence to later ` +
            `tasks`,
        );
      }
    }
  }
}

/** 证据在盘上的短指针:做什么、证据在哪、去打开它。 */
export function mission(tree: ContextTree, opts: { job: string }): string {
  const parts = [
    opts.job.trim(),
    "",
    "# YOUR EVIDENCE",
    "",
    "It is on disk, in `context/`. Read it -- do not answer from this message alone.",
    "",
    tree.layout,
    "",
    "Every trajectory EVENT is present: the trajectory was not clipped to fit this " +
      "mission. An individual observation may contain an explicit renderer-truncation " +
      "marker; that marker is ours, not behavior by the solver. Do not diagnose it as a " +
      "solver failure.",
    "",
    "Read `task.md` and the current harness first. Inventory every available rollout " +
      "or candidate and inspect each at least once before deciding. For a candidate, " +
      "compare what changed from its editing baseline, what behavior changed in its " +
      "rollout, what improved, and what regressed or remained unresolved. Then " +
      "deep-read the evidence relevant to any edit. Cite the specific trajectory " +
      "moment behind every change; one you cannot trace to a moment is speculation.",
  ];
  return parts.join("\n");
}

// ---- 同步小工具(assert_* 是同步 API,与 Python 一致) ----

function isDirSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walkFilesSync(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) rec(p);
      else out.push(relative(root, p).split(sep).join("/"));
    }
  };
  rec(root);
  return out.sort();
}

function readFileSyncUtf8(p: string): string {
  return readFileSync(p, "utf8");
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function hasAnyEntry(p: string): Promise<boolean> {
  try {
    return (await fs.readdir(p)).length > 0;
  } catch {
    return false;
  }
}
