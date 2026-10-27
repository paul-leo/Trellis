// Derived from harness2 `harness2/core/tree.py` (Apache-2.0, Copyright 2026 Google LLC).
// 任务 3.1:tree 模块原样翻译。函数名与字段名保留 Python snake_case 原样,
// 便于逐行对照与 golden JSON 对齐。
//
// 语言适配(非语义偏差):
// - fs/spawn I/O 一律 async;
// - `re.fullmatch(p)` → 锚定正则 `^(?:p)$`;
// - Python `compile(src, rel, "exec")` 在 TS 无进程内等价物,改为 spawn
//   `python3 -c <compile 探针>`;python3 缺席时跳过脚本编译检查(harness2 作为
//   Python 进程不存在此情形,这是环境差异而非语义偏差,见 design 评审记录);
// - json.loads 失败与 JSONDecodeError 的详细文案不复刻,外层错误包装文案保持一致;
// - Python `round(x, 4)` 是 half-even,JS Math.round 是 half-up,差异点用
//   pyRound 显式实现 half-even。

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { pyRound } from "./pyutil.js";

export type Tree = Record<string, string>;

export const RESERVED_SCRIPTS: ReadonlySet<string> = new Set([
  "read_doc.py",
  "pack.py",
  "unpack.py",
]);

const _NAME = String.raw`[a-z0-9][a-z0-9_\-]*`;

export interface SurfaceSpec {
  readonly name: string;
  readonly always_on: readonly string[];
  readonly always_on_max: number;
  readonly always_on_cap_reason: string;
  readonly skill_dir: string;
  readonly skill_name_rule: string;
  readonly trigger_hint: string;
  readonly autotrigger_file: string;
  readonly trigger_line: string;
  readonly subagent_requires_mode: boolean;
  readonly plugin_dir: string | null;
  readonly hooks_file: string | null;
  /** frozenset[str] = frozenset() */
  readonly hook_events: ReadonlySet<string>;
  /** = False */
  readonly compile_skill_scripts: boolean;
  /** = False */
  readonly reject_empty_always_on: boolean;
  /** tuple[tuple[str, str], ...] = () */
  readonly stubs: readonly (readonly [string, string])[];
}

/** SurfaceSpec 的构造输入,默认值与 Python dataclass 字段默认值一一对应。 */
export type SurfaceSpecInput = Omit<
  SurfaceSpec,
  "hook_events" | "compile_skill_scripts" | "reject_empty_always_on" | "stubs"
> &
  Partial<
    Pick<
      SurfaceSpec,
      "hook_events" | "compile_skill_scripts" | "reject_empty_always_on" | "stubs"
    >
  >;

export function makeSurfaceSpec(input: SurfaceSpecInput): SurfaceSpec {
  return Object.freeze({
    hook_events: new Set<string>() as ReadonlySet<string>,
    compile_skill_scripts: false,
    reject_empty_always_on: false,
    stubs: [],
    ...input,
  });
}

interface SurfaceRegexes {
  skill: RegExp;
  skill_script: RegExp;
  subagent: RegExp;
  script: RegExp;
  script_ref: RegExp;
  plugin?: RegExp;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// lru_cache(maxsize=8) 的等价物:Map 插入序 + 命中提首 + 超容逐出最久未用。
const _resCache = new Map<string, SurfaceRegexes>();

function _res(surface_name: string, skill_dir: string, plugin_dir: string | null): SurfaceRegexes {
  const cacheKey = `${surface_name}\u001f${skill_dir}\u001f${plugin_dir ?? ""}`;
  const hit = _resCache.get(cacheKey);
  if (hit) {
    _resCache.delete(cacheKey);
    _resCache.set(cacheKey, hit);
    return hit;
  }
  const sd = escapeRegExp(skill_dir);
  const out: SurfaceRegexes = {
    skill: new RegExp(String.raw`^(?:${sd}/(${_NAME})/SKILL\.md)$`),
    skill_script: new RegExp(String.raw`^(?:${sd}/${_NAME}/scripts/[A-Za-z0-9_.\-]+)$`),
    subagent: new RegExp(String.raw`^(?:sub_agents/(${_NAME})/AGENT\.md)$`),
    script: new RegExp(String.raw`^(?:scripts/[a-z0-9_][a-z0-9_]*\.py)$`),
    script_ref: new RegExp(String.raw`(?:python3?\s+)((?:${sd}/[\w\-]+/)?scripts/[\w.\-]+\.py)`, "g"),
  };
  if (plugin_dir !== null) {
    out.plugin = new RegExp(String.raw`^(?:${escapeRegExp(plugin_dir)}/(${_NAME})\.ts)$`);
  }
  _resCache.set(cacheKey, out);
  if (_resCache.size > 8) {
    const oldest = _resCache.keys().next().value;
    if (oldest !== undefined) _resCache.delete(oldest);
  }
  return out;
}

function _rx(surface: SurfaceSpec): SurfaceRegexes {
  return _res(surface.name, surface.skill_dir, surface.plugin_dir);
}

/** Normalise a relative path, rejecting escapes before it is joined to a directory. */
export function normalize_rel(rel: string): string {
  let r = String(rel).trim().replaceAll("\\", "/");
  if (r.startsWith("/") || r.split("/").includes("..")) {
    // Python repr 风格:单引号包裹。
    throw new Error(`path escapes the harness: '${rel}'`);
  }
  while (r.startsWith("./")) {
    r = r.slice(2);
  }
  return r.replace(/^\/+|\/+$/g, "");
}

/** Whether this path is on the editable surface. A predicate: it never throws. */
export function is_allowed(surface: SurfaceSpec, rel: string): boolean {
  try {
    rel = normalize_rel(rel);
  } catch {
    return false;
  }
  if (surface.always_on.includes(rel)) {
    return true;
  }
  if (surface.hooks_file !== null && rel === surface.hooks_file) {
    return true;
  }
  const r = _rx(surface);
  if (
    r.skill.test(rel) ||
    r.skill_script.test(rel) ||
    r.subagent.test(rel) ||
    r.script.test(rel)
  ) {
    return true;
  }
  return r.plugin !== undefined && r.plugin.test(rel);
}

export function skill_names(surface: SurfaceSpec, tree: Tree): string[] {
  const rx = _rx(surface).skill;
  const names = new Set<string>();
  for (const rel of Object.keys(tree)) {
    const m = rx.exec(rel);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

export function subagent_names(surface: SurfaceSpec, tree: Tree): string[] {
  const rx = _rx(surface).subagent;
  const names = new Set<string>();
  for (const rel of Object.keys(tree)) {
    const m = rx.exec(rel);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

function _stub_paths(surface: SurfaceSpec): ReadonlySet<string> {
  return new Set(surface.stubs.map(([rel]) => rel));
}

async function _listFiles(d: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  };
  await walk(d, "");
  return out.sort();
}

/**
 * rel -> content for every file on the editable surface, README stubs excluded.
 * Pass `rejected` to collect paths that exist on disk but are off the surface.
 */
export async function read_tree(
  surface: SurfaceSpec,
  d: string,
  opts: { rejected?: string[] } = {},
): Promise<Tree> {
  const out: Tree = {};
  try {
    if (!(await fs.stat(d)).isDirectory()) return out;
  } catch {
    return out;
  }
  const stubs = _stub_paths(surface);
  for (const rel of await _listFiles(d)) {
    if (rel.split("/").includes("__pycache__")) continue;
    if (stubs.has(rel)) continue;
    if (!is_allowed(surface, rel)) {
      opts.rejected?.push(rel);
      continue;
    }
    // errors="replace":Node 的 utf8 解码对非法序列默认替换为 U+FFFD。
    out[rel] = await fs.readFile(join(d, rel), "utf8");
  }
  return out;
}

export async function is_tree(surface: SurfaceSpec, d: string): Promise<boolean> {
  try {
    if (!(await fs.stat(d)).isDirectory()) return false;
  } catch {
    return false;
  }
  for (const a of surface.always_on) {
    try {
      if ((await fs.stat(join(d, a))).isFile()) return true;
    } catch {
      // 不存在则继续看下一个 always_on。
    }
  }
  return false;
}

/**
 * Materialise an exact editable tree, with always-on files and optional stubs present.
 * Files outside the editable surface are preserved; editable files already there are not.
 */
export async function write_tree(
  surface: SurfaceSpec,
  tree: Tree,
  dest: string,
  opts: { stubs?: boolean } = {},
): Promise<string> {
  const writeStubs = opts.stubs ?? true;
  await fs.mkdir(dest, { recursive: true });
  const stubSet = _stub_paths(surface);
  for (const rel of (await _listFiles(dest)).reverse()) {
    if (is_allowed(surface, rel) || stubSet.has(rel)) {
      await fs.unlink(join(dest, rel));
    }
  }
  for (const a of surface.always_on) {
    const p = join(dest, a);
    await fs.mkdir(join(p, ".."), { recursive: true });
    if (!(a in tree)) {
      try {
        await fs.stat(p);
      } catch {
        await fs.writeFile(p, "", "utf8");
      }
    }
  }
  for (const [rel, content] of Object.entries(tree)) {
    const p = join(dest, normalize_rel(rel));
    await fs.mkdir(join(p, ".."), { recursive: true });
    await fs.writeFile(p, content, "utf8");
  }
  if (writeStubs) {
    for (const [rel, body] of surface.stubs) {
      const p = join(dest, rel);
      await fs.mkdir(join(p, ".."), { recursive: true });
      try {
        await fs.stat(p);
      } catch {
        await fs.writeFile(p, body, "utf8");
      }
    }
  }
  return dest;
}

export function always_on_text(surface: SurfaceSpec, tree: Tree): string {
  return surface.always_on.map((a) => tree[a] ?? "").join("\n\n");
}

function _format(template: string, values: Record<string, string>): string {
  // Python str.format 的最小子集:本模块只用 {name} / {desc} 两个具名槽位。
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

/**
 * Give every skill a trigger line in always-on text; return the names repaired.
 * A line that would push the body over the always-on cap is skipped instead.
 * 与 Python 版一致:原地修改 tree。
 */
export function autotrigger(
  surface: SurfaceSpec,
  tree: Tree,
  opts: { always_on_max?: number } = {},
): string[] {
  const cap = opts.always_on_max ?? surface.always_on_max;
  let body = always_on_text(surface, tree);
  const fixed: string[] = [];
  for (const name of skill_names(surface, tree)) {
    if (body.includes(name)) continue;
    const fm = (tree[`${surface.skill_dir}/${name}/SKILL.md`] ?? "").slice(0, 600);
    const m = /^description:\s*(.+)$/m.exec(fm);
    const desc = m ? m[1].trim().replace(/\.+$/, "") : `the ${name} workflow applies`;
    const line = _format(surface.trigger_line, { name, desc });
    const cur = tree[surface.autotrigger_file] ?? "";
    if (always_on_text(surface, tree).length + line.length + 2 > cap) {
      continue;
    }
    tree[surface.autotrigger_file] = cur.trim() ? `${cur.trimEnd()}\n${line}` : line;
    body = always_on_text(surface, tree);
    fixed.push(name);
  }
  return fixed;
}

function _isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate the hooks file against the schema the framework dispatches; a malformed one
 * never fires rather than erroring, so the shape is enforced where the proposer sees it.
 */
export function check_hooks(surface: SurfaceSpec, src: string, errs: string[]): void {
  const hf = surface.hooks_file;
  let doc: unknown;
  try {
    doc = JSON.parse(src);
  } catch (exc) {
    // JSONDecodeError 的详细文案不复刻,仅保证外层包装一致。
    errs.push(`${hf} is not valid JSON: ${exc instanceof Error ? exc.message : String(exc)}`);
    return;
  }
  const hooks = _isPlainObject(doc) ? doc["hooks"] : undefined;
  if (!_isPlainObject(hooks) || Object.keys(hooks).length === 0) {
    errs.push(`${hf} needs a top-level {"hooks": {"<Event>": [...]}} object`);
    return;
  }
  for (const [event, entries] of Object.entries(hooks)) {
    if (!surface.hook_events.has(event)) {
      errs.push(
        `${hf}: unknown event '${event}'; the framework dispatches ` +
          `${[...surface.hook_events].sort().join(", ")} (PascalCase)`,
      );
      continue;
    }
    if (!Array.isArray(entries)) {
      errs.push(`${hf}: ${event} must map to a LIST of matcher entries`);
      continue;
    }
    for (const [i, entry] of entries.entries()) {
      if (!_isPlainObject(entry) || !Array.isArray(entry["hooks"])) {
        errs.push(`${hf}: ${event}[${i}] needs a \`hooks\` list`);
        continue;
      }
      for (const h of entry["hooks"] as unknown[]) {
        if (!_isPlainObject(h) || h["type"] !== "command") {
          errs.push(
            `${hf}: ${event}[${i}] hook type must be "command" — ` +
              `async/prompt/agent hooks are skipped as 'not supported yet'`,
          );
        } else if (!String(h["command"] ?? "").trim()) {
          errs.push(`${hf}: ${event}[${i}] has an empty \`command\``);
        }
      }
    }
  }
}

// `compile(src, rel, "exec")` 的 spawn 等价物:python3 缺席时跳过(见文件头)。
async function _py_compiles(rel: string, src: string, errs: string[]): Promise<void> {
  const probe =
    "import sys\n" +
    "src = sys.stdin.read()\n" +
    "try:\n" +
    "    compile(src, sys.argv[1], 'exec')\n" +
    "except (SyntaxError, ValueError) as exc:\n" +
    "    if isinstance(exc, SyntaxError):\n" +
    "        detail = f'{type(exc).__name__}: {exc.msg} (line {exc.lineno})'\n" +
    "    else:\n" +
    "        detail = f'{type(exc).__name__}: {exc}'\n" +
    "    print(detail[:160])\n" +
    "    sys.exit(1)\n";
  const result = await new Promise<{ code: number | null; out: string; unavailable: boolean }>(
    (resolve) => {
      let child;
      try {
        child = spawn("python3", ["-c", probe, rel], { stdio: ["pipe", "pipe", "ignore"] });
      } catch {
        resolve({ code: null, out: "", unavailable: true });
        return;
      }
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.on("error", () => resolve({ code: null, out: "", unavailable: true }));
      child.on("close", (code) => resolve({ code, out: out.trim(), unavailable: false }));
      child.stdin.write(src);
      child.stdin.end();
    },
  );
  if (result.unavailable) return; // python3 缺席:跳过编译检查(环境差异,已记录)
  if (result.code !== 0) {
    errs.push(`${rel} does not compile: ${result.out}`);
  }
}

/** Append every skill-frontmatter and untriggered-skill problem; return the skill names. */
function _check_skills(surface: SurfaceSpec, tree: Tree, body: string, errs: string[]): string[] {
  const skills = skill_names(surface, tree);
  for (const name of skills) {
    const fm = tree[`${surface.skill_dir}/${name}/SKILL.md`].slice(0, 600);
    if (!/^description:\s*\S/m.test(fm)) {
      errs.push(
        `${surface.skill_dir}/${name}/SKILL.md needs a \`description:\` in its ` +
          `frontmatter, or the skill is dropped SILENTLY at load`,
      );
    }
    const m_name = /^name:\s*(\S+)\s*$/m.exec(fm);
    if (surface.skill_name_rule === "must_match") {
      if (!(m_name && m_name[1] === name)) {
        errs.push(
          `${surface.skill_dir}/${name}/SKILL.md needs frontmatter ` +
            `\`name: ${name}\` matching its directory (a mismatch is dropped ` +
            `SILENTLY at load)`,
        );
      }
    } else if (m_name && m_name[1] !== name) {
      errs.push(
        `${surface.skill_dir}/${name}/SKILL.md frontmatter \`name: ` +
          `${m_name[1]}\` OVERRIDES the directory name at load, so every ` +
          `trigger line naming \`${name}\` stops matching; drop the \`name:\` line ` +
          `or make it \`name: ${name}\``,
      );
    }
    if (!body.includes(name)) {
      errs.push(
        `skill '${name}' is never named in the always-on text, so the agent ` +
          `will not know to invoke it — an untriggered skill is dead weight. ` +
          _format(surface.trigger_hint, { name }),
      );
    }
  }
  return skills;
}

/** Append every sub-agent problem; return the sub-agent names. */
function _check_subagents(
  surface: SurfaceSpec,
  tree: Tree,
  allow_subagents: boolean,
  errs: string[],
): string[] {
  const subs = subagent_names(surface, tree);
  if (subs.length > 0 && !allow_subagents) {
    // Python list repr: ['a', 'b']
    errs.push(
      `sub_agents are not available on this deployment: [${subs.map((s) => `'${s}'`).join(", ")}]`,
    );
  }
  for (const name of subs) {
    const fm = tree[`sub_agents/${name}/AGENT.md`].slice(0, 600);
    if (surface.subagent_requires_mode && !/^mode:\s*subagent\s*$/m.test(fm)) {
      errs.push(`sub_agents/${name}/AGENT.md needs frontmatter \`mode: subagent\``);
    }
    if (!/^description:\s*\S/m.test(fm)) {
      errs.push(`sub_agents/${name}/AGENT.md needs a \`description:\``);
    }
  }
  return subs;
}

/** Append a problem for every script a skill or always-on file invokes but does not ship. */
function _check_script_refs(
  surface: SurfaceSpec,
  tree: Tree,
  r: SurfaceRegexes,
  reserved_scripts: ReadonlySet<string>,
  errs: string[],
): void {
  const have = new Set(
    Object.keys(tree).filter((rel) => r.script.test(rel) || r.skill_script.test(rel)),
  );
  for (const [rel, src] of Object.entries(tree)) {
    if (!(r.skill.test(rel) || surface.always_on.includes(rel))) continue;
    for (const m of src.matchAll(r.script_ref)) {
      const ref = m[1];
      const basename = ref.slice(ref.lastIndexOf("/") + 1);
      if (reserved_scripts.has(basename)) continue;
      if (!have.has(ref)) {
        errs.push(`${rel} invokes \`${ref}\` but that file is not in the harness`);
      }
    }
  }
}

export interface ValidateOptions {
  allow_subagents?: boolean;
  always_on_max?: number;
  reserved_scripts?: ReadonlySet<string>;
}

export interface ValidateCensus {
  always_on_chars: number;
  n_files: number;
  skills: number;
  sub_agents: number;
  scripts: number;
  plugins?: number;
  hooks?: number;
}

/** Raise listing every problem; return a census of the validated tree. */
export async function validate(
  surface: SurfaceSpec,
  tree: Tree,
  opts: ValidateOptions = {},
): Promise<ValidateCensus> {
  const allow_subagents = opts.allow_subagents ?? true;
  const reserved_scripts = opts.reserved_scripts ?? RESERVED_SCRIPTS;
  const errs: string[] = [];
  const r = _rx(surface);
  const cap = opts.always_on_max ?? surface.always_on_max;
  const body = always_on_text(surface, tree);

  if (body.length > cap) {
    errs.push(
      `always-on content is ${body.length} chars, over the ${cap} cap; ` +
        `${surface.always_on_cap_reason}`,
    );
  }
  if (surface.reject_empty_always_on && !body.trim()) {
    errs.push(
      `${surface.always_on[0]} is empty — it is the only always-on file on ` +
        `this framework, so an empty one is a harness that does not exist`,
    );
  }

  const skills = _check_skills(surface, tree, body, errs);
  const subs = _check_subagents(surface, tree, allow_subagents, errs);

  for (const [rel, src] of Object.entries(tree)) {
    if (
      r.script.test(rel) ||
      (surface.compile_skill_scripts && r.skill_script.test(rel) && rel.endsWith(".py"))
    ) {
      await _py_compiles(rel, src, errs);
    }
  }

  if (surface.hooks_file !== null && surface.hooks_file in tree) {
    check_hooks(surface, tree[surface.hooks_file], errs);
  }

  _check_script_refs(surface, tree, r, reserved_scripts, errs);

  if (errs.length > 0) {
    throw new Error(errs.join(" | "));
  }
  const out: ValidateCensus = {
    always_on_chars: body.length,
    n_files: Object.keys(tree).length,
    skills: skills.length,
    sub_agents: subs.length,
    scripts: Object.keys(tree).filter((rel) => r.script.test(rel)).length,
  };
  if (surface.plugin_dir !== null) {
    out.plugins = Object.keys(tree).filter((rel) => r.plugin!.test(rel)).length;
  }
  if (surface.hooks_file !== null) {
    out.hooks = surface.hooks_file in tree ? 1 : 0;
  }
  return out;
}

export interface DiffSummary {
  added: string[];
  removed: string[];
  modified: string[];
  always_on_char_delta: number;
}

export function diff_summary(surface: SurfaceSpec, before: Tree, after: Tree): DiffSummary {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  const added = [...afterKeys].filter((k) => !beforeKeys.has(k)).sort();
  const removed = [...beforeKeys].filter((k) => !afterKeys.has(k)).sort();
  const modified = [...beforeKeys]
    .filter((k) => afterKeys.has(k) && before[k] !== after[k])
    .sort();
  return {
    added,
    removed,
    modified,
    always_on_char_delta:
      always_on_text(surface, after).length - always_on_text(surface, before).length,
  };
}

export interface Diversity {
  n: number;
  n_distinct: number;
  mean_line_jaccard: number;
}

/** Pairwise line-Jaccard over candidate trees, so collapse to one body is visible. */
export function diversity(trees: Record<string, Tree>): Diversity {
  const names = Object.keys(trees).sort();
  if (names.length < 2) {
    return { n: names.length, n_distinct: names.length, mean_line_jaccard: 1.0 };
  }
  const lines = (t: Tree): Set<string> => {
    const out = new Set<string>();
    for (const [rel, c] of Object.entries(t)) {
      for (const ln of c.split("\n")) {
        if (ln.trim()) out.add(`${rel}:${ln}`);
      }
    }
    return out;
  };
  const sets = new Map(names.map((n) => [n, lines(trees[n])]));
  const sims: number[] = [];
  for (const [i, a] of names.entries()) {
    for (const b of names.slice(i + 1)) {
      const sa = sets.get(a)!;
      const sb = sets.get(b)!;
      const u = new Set([...sa, ...sb]);
      let inter = 0;
      for (const x of sa) if (sb.has(x)) inter++;
      sims.push(u.size > 0 ? inter / u.size : 1.0);
    }
  }
  const distinct = new Set(
    Object.values(trees).map((t) => JSON.stringify(Object.entries(t).sort())),
  ).size;
  return {
    n: names.length,
    n_distinct: distinct,
    mean_line_jaccard: pyRound(sims.reduce((a, b) => a + b, 0) / sims.length, 4),
  };
}
