// library.ts — harness2/core/library.py 的 TypeScript 移植(逐段对应)。
// 按域存放的经验库 R:早期任务采纳的完整 harness 树 + 采纳理由 + 可迁移教训。
//
//   <root>/<domain>/INDEX.md
//   <root>/<domain>/harnesses/<task-slug>/harness/<rel>   采纳的完整树
//   <root>/<domain>/harnesses/<task-slug>/EXPERIENCE.md   为何采纳 + 教训
//
// 移植说明:
// - read_tree/write_tree 在 TS 侧是 async,add/rebuild_index/context_dir 相应 async。
// - str(experience) 的 grader-verdict 绊线扫描 → pyDictRepr(tripwire 用途近似)。
// - {n:,} → pyComma。

import * as fs from "node:fs/promises";
import { join } from "node:path";

import { assert_tree_has_no_grader_verdicts } from "./context.js";
import { pyComma, pyDictRepr } from "./pyutil.js";
import * as harness_tree from "./tree.js";
import type { SurfaceSpec, Tree } from "./tree.js";

export function slug(task_id: string): string {
  return task_id.replaceAll("/", "__");
}

export interface Experience {
  readonly cue?: unknown;
  readonly lesson?: unknown;
  readonly evidence?: unknown;
  readonly edits?: unknown;
  readonly confidence?: unknown;
  readonly [key: string]: unknown;
}

function nonEmptyStr(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** cue/lesson/evidence 三个字段都是非空字符串才入库。 */
export function has_experience(experience: unknown): boolean {
  return (
    typeof experience === "object" &&
    experience !== null &&
    !Array.isArray(experience) &&
    nonEmptyStr((experience as Experience).cue) &&
    nonEmptyStr((experience as Experience).lesson) &&
    nonEmptyStr((experience as Experience).evidence)
  );
}

/** 域名 → 一个目录名(不是路径):只有分隔符及其两侧空白折叠。 */
export function domain_dir(domain: string): string {
  return domain.replace(/\s*[/\\]\s*/g, "__").trim() || "unknown";
}

export interface AddResult {
  entryDir: string;
}

/** 一个 (run, domain) 经验库:每个任务前读,之后追加。 */
export class Library {
  readonly root: string;
  readonly domain: string;
  readonly surface: SurfaceSpec;

  constructor(root: string, domain: string, surface: SurfaceSpec) {
    this.root = root;
    this.domain = domain;
    this.surface = surface;
  }

  get dir(): string {
    return join(this.root, domain_dir(this.domain));
  }

  get index(): string {
    return join(this.dir, "INDEX.md");
  }

  entry_dir(task_id: string): string {
    return join(this.dir, "harnesses", slug(task_id));
  }

  async exists(): Promise<boolean> {
    try {
      return (await fs.stat(this.index)).isFile();
    } catch {
      return false;
    }
  }

  /** 交给 improver 会话的目录;域为空时为 null。 */
  async context_dir(): Promise<string | null> {
    if (!(await this.exists())) return null;
    if (await anyExperience(this.dir)) return this.dir;
    return null;
  }

  async entries(): Promise<string[]> {
    const d = join(this.dir, "harnesses");
    let names: string[];
    try {
      names = await fs.readdir(d);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      try {
        if ((await fs.stat(join(d, name))).isDirectory()) out.push(name);
      } catch {
        // readdir 与 stat 之间的竞态,忽略。
      }
    }
    return out.sort();
  }

  async tree_of(task_id: string): Promise<Tree> {
    return harness_tree.read_tree(this.surface, join(this.entry_dir(task_id), "harness"));
  }

  /** 删掉这些任务的条目并重建 INDEX.md;未知任务被忽略。 */
  async forget(task_ids: readonly string[]): Promise<void> {
    let removed = false;
    for (const tid of task_ids) {
      const d = this.entry_dir(tid);
      if (await isDir(d)) {
        await fs.rm(d, { recursive: true, force: true });
        removed = true;
      }
    }
    if (removed) await this.rebuild_index();
  }

  /** 只保留流中当前任务之前的条目。 */
  async retain(task_ids: readonly string[]): Promise<void> {
    const keep = new Set(task_ids.map(slug));
    await this.forget((await this.entries()).filter((entry) => !keep.has(entry)));
  }

  /**
   * 入库一份采纳的 harness 及采纳理由,并从磁盘重建 INDEX.md。
   * 写盘前先对树做 grader-verdict 绊线检查。
   * 无有效 experience 时返回 null(不写任何文件)。
   */
  async add(
    task_id: string,
    harness: Tree,
    opts: { why?: string; label?: string; run_id?: string; experience?: unknown } = {},
  ): Promise<string | null> {
    const { why = "", label = "", run_id = "", experience = null } = opts;
    if (!has_experience(experience)) return null;
    assert_tree_has_no_grader_verdicts(harness);
    assert_tree_has_no_grader_verdicts({
      "EXPERIENCE.md": pyDictRepr(experience as Record<string, unknown>) + why,
    });
    const d = this.entry_dir(task_id);

    await fs.rm(join(d, "harness"), { recursive: true, force: true });
    await fs.mkdir(join(d, "harness"), { recursive: true });
    await harness_tree.write_tree(this.surface, harness, join(d, "harness"), { stubs: false });

    const exp = (experience ?? {}) as Experience;
    const lines: string[] = [
      `# ${task_id}`,
      "",
      `- adopted: \`${label}\`` + (run_id ? `  (run \`${run_id}\`)` : ""),
      `- components: ${inventory(this.surface, harness)}`,
      "",
    ];
    if (why.trim()) {
      lines.push("## Why this was chosen", why.trim(), "");
    }
    if (exp.edits) {
      lines.push("## What each edit did", String(exp.edits).trim(), "");
    }
    if (exp.lesson) {
      lines.push("## Transferable lesson");
      for (const f of ["cue", "lesson", "evidence", "confidence"] as const) {
        if (exp[f]) {
          lines.push(`- **${f}**: ${String(exp[f]).trim()}`);
        }
      }
      lines.push("");
    }
    await fs.writeFile(join(d, "EXPERIENCE.md"), lines.join("\n"), "utf8");
    await this.rebuild_index();
    return d;
  }

  /** 按磁盘内容重建 INDEX.md。 */
  async rebuild_index(): Promise<string> {
    const rows: string[] = [
      `# Library — ${this.domain}`,
      "",
      "Each entry is an earlier task in THIS domain whose harness was chosen, stored " +
        "with its FULL component tree and why it was picked. Browse this index, then " +
        "open the entries that look relevant to the matter in front of you.",
      "",
    ];
    const names = await this.entries();
    if (names.length === 0) {
      rows.push("_(empty — this is the first task in this domain)_");
    }
    for (const name of names) {
      const ed = join(this.dir, "harnesses", name);
      const cue = await field(join(ed, "EXPERIENCE.md"), "cue");
      const tree = await harness_tree.read_tree(this.surface, join(ed, "harness"));
      rows.push(
        `## \`harnesses/${name}/\``,
        `- harness: \`harnesses/${name}/harness/\` — ${inventory(this.surface, tree)}`,
        `- why:     \`harnesses/${name}/EXPERIENCE.md\``,
      );
      if (cue) rows.push(`- cue:     ${cue}`);
      rows.push("");
    }
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.index, rows.join("\n"), "utf8");
    return this.index;
  }
}

/** 树里实际组件的一行普查。 */
export function inventory(surface: SurfaceSpec, tree: Tree): string {
  // 插入序即 Python dict 顺序:skills, sub_agents, scripts, 然后按需 plugins/hooks。
  const st = new Map<string, number>([
    ["skills", 0],
    ["sub_agents", 0],
    ["scripts", 0],
  ]);
  const skill_prefix = surface.skill_dir + "/";
  const plugin_prefix = surface.plugin_dir === null ? null : surface.plugin_dir + "/";
  const hooks_file = surface.hooks_file;
  for (const rel of Object.keys(tree)) {
    if (rel.startsWith(skill_prefix) && rel.endsWith("SKILL.md")) {
      st.set("skills", (st.get("skills") ?? 0) + 1);
    } else if (rel.startsWith("sub_agents/")) {
      st.set("sub_agents", (st.get("sub_agents") ?? 0) + 1);
    } else if (rel.startsWith("scripts/")) {
      st.set("scripts", (st.get("scripts") ?? 0) + 1);
    } else if (plugin_prefix !== null && rel.startsWith(plugin_prefix)) {
      st.set("plugins", (st.get("plugins") ?? 0) + 1);
    } else if (hooks_file !== null && rel === hooks_file) {
      st.set("hooks", (st.get("hooks") ?? 0) + 1);
    }
  }
  const on = harness_tree.always_on_text(surface, tree).length;
  const bits: string[] = [];
  for (const [k, v] of st) {
    if (v) bits.push(`${v} ${k}`);
  }
  return `${bits.length > 0 ? bits.join(", ") : "always-on edits only"}; ${pyComma(on)} always-on chars`;
}

async function field(path: string, name: string): Promise<string> {
  let body: string;
  try {
    body = await fs.readFile(path, "utf8");
  } catch {
    return "";
  }
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.startsWith(`- **${name}**:`)) {
      // Python line.split(":", 1)[1].strip():首个冒号之后的全部内容。
      return line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return "";
}

/**
 * 每个 run 的库根 `<base>/<benchmark>/k<k>-<variant>`;显式 `tag` 则跨 run 共享一个库。
 */
export function root_for(
  base: string,
  opts: { benchmark: string; k: number; variant?: string; tag?: string },
): string {
  const { benchmark, k, variant = "", tag = "" } = opts;
  if (tag) return join(base, benchmark, tag);
  const parts = [`k${Math.trunc(k)}`];
  if (variant) parts.push(variant);
  return join(base, benchmark, parts.join("-"));
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function anyExperience(dir: string): Promise<boolean> {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = await fs.readdir(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === "EXPERIENCE.md") return true;
      const p = join(cur, name);
      try {
        if ((await fs.stat(p)).isDirectory()) stack.push(p);
      } catch {
        // 竞态忽略。
      }
    }
  }
  return false;
}
