// runmark.ts — harness2/core/runmark.py(116 行)的逐行移植。
// 对应原版的"trial identity":rollout 是否完成、是否由当前 harness 配置产出。
//
// 逐条对照:
//   MARK = ".adapt_complete" / VERSION = 1          原样保留
//   _ignored(p)        → _ignored(relParts, suffix, name):__pycache__/.pyc/.DS_Store
//   fingerprint(dir)   → fingerprint(harnessDir):None → "base";目录缺席 → "absent";
//                        sha1(相对路径 + \0 + 内容 + \0) 按排序后遍历,取前 16 hex。
//                        Python sorted(rglob) 按路径字符串比较(POSIX 上即字节序),
//                        与"按 posix 相对路径字符串排序"一致。读取失败 → "<unreadable>"。
//   mark_complete      → mark_complete:tmp 文件 <MARK>.<pid>.tmp + rename 原子落盘;
//                        payload JSON 与 Python json.dumps(indent=2, sort_keys=True) 一致;
//                        extra 键展开到顶层(**extra)。
//   read_mark          → read_mark:任何异常 → null
//   is_complete        → is_complete:version 不符 → false;match_harness=false → true;
//                        否则比较 harness 指纹
//   why_not            → why_not:三种解释文案逐字保留(含 " -- ")
//
// 环境差异(已记录):Python 的 time.time() 是 float 秒;TS 用 Date.now()/1000,
// 精度只影响 "at" 字段的观测值,不影响身份语义。

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

export const MARK = ".adapt_complete";
export const VERSION = 1;

function _ignored(rel: string): boolean {
  const parts = rel.split("/");
  return (
    parts.includes("__pycache__") || rel.endsWith(".pyc") || parts[parts.length - 1] === ".DS_Store"
  );
}

/** 递归收集 root 下的文件相对路径(posix 分隔),按字符串排序,对应 sorted(root.rglob("*"))。 */
async function _listFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return out; // 读取失败的子树不贡献任何条目(对应 rglob 遇错由外层 try 兜底)
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await _listFiles(root, rel)));
    } else if (e.isFile()) {
      out.push(rel);
    }
    // 符号链接等其他类型:Python 的 p.is_file() 跟随符号链接;Node Dirent.isFile()
    // 对符号链接为 false。harness 树由 write_tree 产出、不含符号链接,差异不可达。
  }
  return out.sort();
}

export async function fingerprint(harnessDir: string | null): Promise<string> {
  if (harnessDir === null) return "base";
  let stat;
  try {
    stat = await fs.stat(harnessDir);
  } catch {
    return "absent";
  }
  if (!stat.isDirectory()) return "absent";
  const h = createHash("sha1");
  for (const rel of await _listFiles(harnessDir)) {
    const name = rel.split("/").pop() as string;
    if (name === MARK || _ignored(rel)) continue;
    h.update(rel, "utf8");
    h.update("\0");
    try {
      h.update(await fs.readFile(join(harnessDir, rel)));
    } catch {
      h.update("<unreadable>");
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export interface Mark extends Record<string, unknown> {
  version: number;
  run_id: string;
  at: number;
  harness: string;
}

export async function mark_complete(
  where: string,
  opts: { run_id: string; harness_dir?: string | null; extra?: Record<string, unknown> },
): Promise<string> {
  await fs.mkdir(where, { recursive: true });
  const payload: Record<string, unknown> = {
    version: VERSION,
    run_id: opts.run_id,
    at: Date.now() / 1000,
    harness: await fingerprint(opts.harness_dir ?? null),
    ...(opts.extra ?? {}),
  };
  // json.dumps(payload, indent=2, sort_keys=True):键排序、两空格缩进。
  const text = JSON.stringify(
    Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    null,
    2,
  );
  const tmp = join(where, `${MARK}.${process.pid}.tmp`);
  await fs.writeFile(tmp, text);
  const final = join(where, MARK);
  await fs.rename(tmp, final);
  return final;
}

export async function read_mark(where: string): Promise<Mark | null> {
  try {
    return JSON.parse(await fs.readFile(join(where, MARK), "utf8")) as Mark;
  } catch {
    return null;
  }
}

export async function is_complete(
  where: string,
  opts: { harness_dir?: string | null; match_harness?: boolean } = {},
): Promise<boolean> {
  const m = await read_mark(where);
  if (!m || m.version !== VERSION) return false;
  if (opts.match_harness === false) return true;
  return m.harness === (await fingerprint(opts.harness_dir ?? null));
}

export async function why_not(
  where: string,
  opts: { harness_dir?: string | null } = {},
): Promise<string> {
  const m = await read_mark(where);
  if (!m) {
    return `no ${MARK} -- never finished, or finished before completion was recorded`;
  }
  if (m.version !== VERSION) {
    return `marker version ${m.version} != ${VERSION}`;
  }
  const want = await fingerprint(opts.harness_dir ?? null);
  const got = m.harness;
  if (want !== got) {
    return `harness fingerprint ${got} != ${want} -- produced by a different configuration`;
  }
  return "reusable";
}
