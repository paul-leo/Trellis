/**
 * The plan/apply two-call gate (trellis-gui design.md Decision 4): a
 * `/plan/<op>` call returns a real, freshly-computed plan plus an opaque
 * id; `/apply/<op>` requires that exact id and consumes it — one plan is
 * good for exactly one apply, so a caller can never apply without having
 * just fetched a plan for that specific operation.
 */
import { randomUUID } from "node:crypto";

export interface StoredPlan {
  operation: string;
  plan: unknown;
  createdAt: number;
}

const PLAN_TTL_MS = 5 * 60_000;

export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>();

  store(operation: string, plan: unknown): string {
    const planId = randomUUID();
    this.plans.set(planId, { operation, plan, createdAt: Date.now() });
    return planId;
  }

  /** Consumes the plan if it exists, matches `operation`, and hasn't
   * expired — returns `undefined` otherwise. A plan is single-use: found
   * or not, it is removed from the store so a stale id can never be
   * replayed. */
  take(planId: string, operation: string): StoredPlan | undefined {
    const stored = this.plans.get(planId);
    this.plans.delete(planId);
    if (!stored) return undefined;
    if (stored.operation !== operation) return undefined;
    if (Date.now() - stored.createdAt > PLAN_TTL_MS) return undefined;
    return stored;
  }
}
