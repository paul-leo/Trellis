// pool.ts — Python `ThreadPoolExecutor(max_workers=n).map(fn, items)` 的 Promise 对应物。
// 内部细节(schedule/recursion 的并发原语),不进根导出。
//
// 语义对照:
//   pool.map 保证结果按提交序返回,与完成序无关 → mapPool 同样按 items 下标回填;
//   Python 端 recursion._roll_many 依赖这一点("a concurrent run records the same
//   sequence of labels as a serial one"),完成序是无关量。
//   as_completed 的完成序聚合没有 TS 对应默认值,调用方(schedule.run_sweep)显式
//   按 domain 序收集 —— 见 schedule.ts 头注释的聚合顺序决策。
//
// n == 1 时仍然走同一路径(并发度 1 的池),不为串行分支特判:回填顺序与记录时机
// 由调用方决定。

/** 并发至多 `width` 个 `fn`,结果数组严格按 `items` 顺序返回。 */
export async function mapPool<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const n = Math.max(1, Math.min(items.length, Math.trunc(width)));
  const out = new Array<R>(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < n; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          out[i] = await fn(items[i] as T, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}
