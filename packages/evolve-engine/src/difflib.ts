// difflib.ts — Python difflib 的 unified_diff / SequenceMatcher 子集,
// 供 context 的 pool harness.diff 渲染使用(harness2/core/context.py:312)。
// 输出逐字节对齐 Python difflib(含 hunk 边界、autojunk、空文件区间格式)。

interface Opcode {
  tag: "replace" | "delete" | "insert" | "equal";
  i1: number;
  i2: number;
  j1: number;
  j2: number;
}

/** Python difflib.SequenceMatcher(None, a, b) 的 get_opcodes/get_matching_blocks 子集。 */
class SequenceMatcher {
  private readonly a: readonly string[];
  private readonly b: readonly string[];
  /** b 中被 autojunk 判定为垃圾的元素(永不出现在匹配块内,仅可在匹配两端延伸)。 */
  private readonly bjunk = new Set<string>();
  /** elt → 在 b 中的升序下标;垃圾元素已剔除。 */
  private readonly b2j = new Map<string, number[]>();

  constructor(a: readonly string[], b: readonly string[]) {
    this.a = a;
    this.b = b;
    const n = b.length;
    for (let i = 0; i < n; i++) {
      const elt = b[i];
      const idx = this.b2j.get(elt);
      if (idx) idx.push(i);
      else this.b2j.set(elt, [i]);
    }
    // Python autojunk=True:b 长度 >= 200 时出现次数 > n//100+1 的元素视为垃圾。
    if (n >= 200) {
      const ntest = Math.trunc(n / 100) + 1;
      for (const elt of [...this.b2j.keys()]) {
        const idx = this.b2j.get(elt)!;
        if (idx.length > ntest) {
          this.bjunk.add(elt);
          this.b2j.delete(elt);
        }
      }
    }
  }

  /** Python find_longest_match:含两端 junk 延伸。 */
  find_longest_match(
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): { i: number; j: number; size: number } {
    const { a, b } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of this.b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // 非垃圾两端延伸
    while (
      besti > alo &&
      bestj > blo &&
      !this.bjunk.has(b[bestj - 1]) &&
      a[besti - 1] === b[bestj - 1]
    ) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !this.bjunk.has(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize++;
    }
    // 垃圾两端延伸
    while (
      besti > alo &&
      bestj > blo &&
      this.bjunk.has(b[bestj - 1]) &&
      a[besti - 1] === b[bestj - 1]
    ) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      this.bjunk.has(b[bestj + bestsize]) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize++;
    }
    return { i: besti, j: bestj, size: bestsize };
  }

  /** Python get_matching_blocks,末哨兵 (la, lb, 0) 在列。 */
  get_matching_blocks(): { i: number; j: number; size: number }[] {
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const matching_blocks: { i: number; j: number; size: number }[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.find_longest_match(alo, ahi, blo, bhi);
      const { i, j, size } = x;
      // Python:if k 为 0 时整段无匹配,子区间也不必再查(嵌套在 if k 内)。
      // 若在 k==0 时仍把原区间回推,会把同一区间无限重入。
      if (size > 0) {
        matching_blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + size < ahi && j + size < bhi) queue.push([i + size, ahi, j + size, bhi]);
      }
    }
    matching_blocks.sort((p, q) => p.i - q.i || p.j - q.j || p.size - q.size);
    // 折叠相邻块
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const non_adjacent: { i: number; j: number; size: number }[] = [];
    for (const [i2, j2, k2] of matching_blocks.map((m) => [m.i, m.j, m.size] as const)) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1 > 0) non_adjacent.push({ i: i1, j: j1, size: k1 });
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1 > 0) non_adjacent.push({ i: i1, j: j1, size: k1 });
    non_adjacent.push({ i: la, j: lb, size: 0 });
    return non_adjacent;
  }

  get_opcodes(): Opcode[] {
    let i = 0;
    let j = 0;
    const answer: Opcode[] = [];
    for (const { i: ai, j: bj, size } of this.get_matching_blocks()) {
      let tag: Opcode["tag"] | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push({ tag, i1: i, i2: ai, j1: j, j2: bj });
      i = ai + size;
      j = bj + size;
      if (size > 0) answer.push({ tag: "equal", i1: ai, i2: i, j1: bj, j2: j });
    }
    return answer;
  }

  /** Python get_grouped_opcodes(n=3)。 */
  get_grouped_opcodes(n: number): Opcode[][] {
    let codes = this.get_opcodes();
    if (codes.length === 0) {
      codes = [{ tag: "equal", i1: 0, i2: 1, j1: 0, j2: 1 }];
    }
    if (codes[0].tag === "equal") {
      const c = codes[0];
      codes[0] = {
        tag: "equal",
        i1: Math.max(c.i1, c.i2 - n),
        i2: c.i2,
        j1: Math.max(c.j1, c.j2 - n),
        j2: c.j2,
      };
    }
    if (codes[codes.length - 1].tag === "equal") {
      const c = codes[codes.length - 1];
      codes[codes.length - 1] = {
        tag: "equal",
        i1: c.i1,
        i2: Math.min(c.i2, c.i1 + n),
        j1: c.j1,
        j2: Math.min(c.j2, c.j1 + n),
      };
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (let c of codes) {
      if (c.tag === "equal" && c.i2 - c.i1 > nn) {
        group.push({
          tag: "equal",
          i1: c.i1,
          i2: Math.min(c.i2, c.i1 + n),
          j1: c.j1,
          j2: Math.min(c.j2, c.j1 + n),
        });
        groups.push(group);
        group = [];
        c = {
          tag: "equal",
          i1: Math.max(c.i1, c.i2 - n),
          i2: c.i2,
          j1: Math.max(c.j1, c.j2 - n),
          j2: c.j2,
        };
      }
      group.push(c);
    }
    if (group.length > 0 && !(group.length === 1 && group[0].tag === "equal")) {
      groups.push(group);
    }
    return groups;
  }
}

/** Python difflib._format_range_unified。 */
function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (length === 0) beginning -= 1; // 空区间从区间前一行起算
  return `${beginning},${length}`;
}

/**
 * Python str.splitlines(keepends=True) 的行切分边界全集:
 * \r\n 整体,以及 \n \r \v \f \x1c \x1d \x1e \x85    。
 * 空串 → [];末段无换行则原样保留。
 */
export function splitKeepEnds(s: string): string[] {
  if (s === "") return [];
  const out: string[] = [];
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(s.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/**
 * Python difflib.unified_diff(a, b, fromfile, tofile, n=3, lineterm='\n')。
 * a/b 为 splitlines(keepends=True) 形态的行数组;逐行 yield(行内含换行)。
 */
export function unifiedDiff(
  a: readonly string[],
  b: readonly string[],
  fromfile = "",
  tofile = "",
  n = 3,
  lineterm = "\n",
): string[] {
  const out: string[] = [];
  let started = false;
  for (const group of new SequenceMatcher(a, b).get_grouped_opcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}${lineterm}`);
      out.push(`+++ ${tofile}${lineterm}`);
    }
    const first = group[0];
    const last = group[group.length - 1];
    const file1Range = formatRangeUnified(first.i1, last.i2);
    const file2Range = formatRangeUnified(first.j1, last.j2);
    out.push(`@@ -${file1Range} +${file2Range} @@${lineterm}`);
    for (const { tag, i1, i2, j1, j2 } of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(` ${line}`);
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        for (const line of a.slice(i1, i2)) out.push(`-${line}`);
      }
      if (tag === "replace" || tag === "insert") {
        for (const line of b.slice(j1, j2)) out.push(`+${line}`);
      }
    }
  }
  return out;
}
