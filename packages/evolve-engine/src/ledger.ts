// ledger.ts — harness2/core/ledger.py(133 行)的逐行移植。
// 预算记账:R = 4k rollouts、P = 3k improvement stages。
// Base executions 计入每个 mode;重试是独立的 attempts 计数;
// selection 与 reflection 记在此账本之外。
//
// 逐条对照:
//   expected_rollouts(k) → 4k(k shared base + 2k candidates + k finals)
//   expected_sessions(k) → 3k(k INV + k DOM + k compositions)
//   BudgetError(AssertionError) → BudgetError extends Error(name 保留)
//   Entry dataclass            → Entry readonly 接口 + makeEntry(usd=0.0/cached=false/attempts=1)
//   Ledger dataclass           → Ledger 类(mode/task_id/k 构造参数,entries 从空开始)
//   R/P/usd/rollout_usd/session_usd property → 同名 getter;round(x,6) 用 pyRound(half-even)
//   labels(kind)               → labels(kind)
//   assert_identity()          → assert_identity():先查重复标签再查计数;文案逐字保留,
//                                Python list repr ['a', 'b'] 用 pyListRepr
//   to_dict()                  → to_dict():键序与 Python dict 字面量一致
//                                  (mode/task_id/k/R/expected_R/P/session_attempts/expected_P/
//                                   usd/rollout_usd/session_usd/rollouts/sessions)

import { pyListRepr, pyRound } from "./pyutil.js";

export function expected_rollouts(k: number): number {
  return 4 * Math.trunc(k);
}

export function expected_sessions(k: number): number {
  return 3 * Math.trunc(k);
}

/** 对应 Python 的 class BudgetError(AssertionError)。 */
export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

export interface Entry {
  readonly kind: string;
  readonly label: string;
  readonly usd: number;
  readonly cached: boolean;
  readonly attempts: number;
}

export function makeEntry(input: {
  kind: string;
  label: string;
  usd?: number;
  cached?: boolean;
  attempts?: number;
}): Entry {
  return Object.freeze({
    kind: input.kind,
    label: input.label,
    usd: input.usd ?? 0.0,
    cached: input.cached ?? false,
    attempts: input.attempts ?? 1,
  });
}

export class Ledger {
  readonly mode: string;
  readonly task_id: string;
  readonly k: number;
  readonly entries: Entry[] = [];

  constructor(mode: string, task_id: string, k: number) {
    this.mode = mode;
    this.task_id = task_id;
    this.k = k;
  }

  rollout(label: string, usd = 0.0, opts: { cached?: boolean } = {}): void {
    this.entries.push(makeEntry({ kind: "rollout", label, usd, cached: opts.cached ?? false }));
  }

  session(
    label: string,
    usd = 0.0,
    opts: { cached?: boolean; attempts?: number } = {},
  ): void {
    this.entries.push(
      makeEntry({
        kind: "session",
        label,
        usd,
        cached: opts.cached ?? false,
        attempts: opts.attempts ?? 1,
      }),
    );
  }

  get R(): number {
    return this.entries.filter((e) => e.kind === "rollout").length;
  }

  get P(): number {
    return this.entries.filter((e) => e.kind === "session").length;
  }

  get usd(): number {
    return pyRound(this.entries.reduce((a, e) => a + e.usd, 0), 6);
  }

  get rollout_usd(): number {
    return pyRound(
      this.entries.filter((e) => e.kind === "rollout").reduce((a, e) => a + e.usd, 0),
      6,
    );
  }

  get session_usd(): number {
    return pyRound(
      this.entries.filter((e) => e.kind === "session").reduce((a, e) => a + e.usd, 0),
      6,
    );
  }

  labels(kind: string): string[] {
    return this.entries.filter((e) => e.kind === kind).map((e) => e.label);
  }

  /** 除非记录恰好落在 R=4k、P=3k 且无重复标签,否则抛 BudgetError。
   *  重复先于计数检查:一个重复标签可能恰好凑齐计数。 */
  assert_identity(): void {
    const want_r = expected_rollouts(this.k);
    const want_p = expected_sessions(this.k);
    const rl = this.labels("rollout");
    const sl = this.labels("session");
    const dupeSet = new Set<string>();
    for (const labels of [rl, sl]) {
      const seen = new Set<string>();
      for (const label of labels) {
        if (seen.has(label)) dupeSet.add(label);
        seen.add(label);
      }
    }
    const dupes = [...dupeSet].sort();
    if (dupes.length === 0 && this.R === want_r && this.P === want_p) return;
    const detail = [
      `${this.mode}-${this.k} ${this.task_id}: ` +
        `R=${this.R} (want ${want_r}), P=${this.P} (want ${want_p})`,
      `  rollouts: ${rl.join(", ") || "(none)"}`,
      `  sessions: ${sl.join(", ") || "(none)"}`,
    ];
    if (dupes.length > 0) {
      detail.push(
        `  DUPLICATE labels: ${pyListRepr(dupes)} -- a repeated label means two stages ` +
          `wrote the same run id and one silently overwrote the other, so a ` +
          `candidate the ledger counts was never actually produced`,
      );
    }
    throw new BudgetError(detail.join("\n"));
  }

  to_dict(): Record<string, unknown> {
    return {
      mode: this.mode,
      task_id: this.task_id,
      k: this.k,
      R: this.R,
      expected_R: expected_rollouts(this.k),
      P: this.P,
      session_attempts: this.entries
        .filter((e) => e.kind === "session")
        .reduce((a, e) => a + e.attempts, 0),
      expected_P: expected_sessions(this.k),
      usd: this.usd,
      rollout_usd: this.rollout_usd,
      session_usd: this.session_usd,
      rollouts: this.labels("rollout"),
      sessions: this.labels("session"),
    };
  }
}
