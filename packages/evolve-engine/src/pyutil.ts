// pyutil.ts — Python 语义的小工具,供多个移植模块共享。
// 与 harness2 的对照点:
//   pyRound   ↔ Python 内建 round(x, ndigits)(half-even,银行家舍入)
//   pyListRepr ↔ Python repr(list[str])(单引号,用于错误文案逐字符一致)

/** Python round(x, ndigits):half-even(银行家舍入),非 JS 的 half-up。 */
export function pyRound(x: number, ndigits: number): number {
  const f = 10 ** ndigits;
  const y = x * f;
  const fl = Math.floor(y);
  if (Math.abs(y - fl) === 0.5) {
    return (fl % 2 === 0 ? fl : fl + 1) / f;
  }
  return Math.round(y) / f;
}

/** Python repr(list[str]):['a', 'b'] —— 单引号、逗号后空格。 */
export function pyListRepr(items: string[]): string {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}

/** Python repr(tuple[str, ...]):('a', 'b') —— 单引号、圆括号。 */
export function pyTupleRepr(items: readonly string[]): string {
  return `(${items.map((s) => `'${s}'`).join(", ")})`;
}

/** Python repr(值)的最小子集:null/undefined → None,字符串 → 单引号包裹,其余 String()。 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return `'${v}'`;
  return String(v);
}

/**
 * Python str(dict) 的 tripwire 用途近似(插入序、'k': v 形态)。
 * 只喂给 grader-verdict 标记扫描,引号风格不影响 marker 命中,故不复刻
 * Python repr 在含引号字符串上的换引号/转义细节。
 */
export function pyDictRepr(d: Record<string, unknown>): string {
  const parts = Object.entries(d).map(([k, v]) => `'${k}': ${pyRepr(v)}`);
  return `{${parts.join(", ")}}`;
}

/** Python f"{n:,}":千分位整数格式。 */
export function pyComma(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
