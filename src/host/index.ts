/**
 * `agent-trellis/host` — the narrow host facade (host-extension-points).
 *
 * The ONLY symbols published under the `./host` subpath. Everything here
 * is host-owned: functions defined in this directory, plus their own
 * option/result types. No `src/adapters/*` or `src/commands/*` symbol is
 * re-exported — the facade composes those layers internally and hands
 * out its own shapes, so a consumer (the self-evolution engine) can
 * never come to depend on internal surfaces the spec says it must not
 * see.
 */

export { readSurface } from "./surface.js";
export type { ReadSurfaceOptions, SurfaceLayer, SurfaceRead } from "./surface.js";

export { describeEvolveLevels, evolveLevelPolicyPath, LEVELS, loadEvolveLevelPolicy, resolveEvolveLevel, writeEvolveLevelPolicy } from "./levels.js";
export type { EvolveLevelPolicy, EvolveLevelSection, Level } from "./levels.js";

export { createStaging, NATIVE_CHECK_SURFACE } from "./staging.js";
export type { CreateStagingOptions, Staging } from "./staging.js";

export { runChecks } from "./checks.js";
export type { CheckEntry, CheckResult, CheckSource, RunChecksOptions } from "./checks.js";

export { applyEdits, HostEditError, rollbackSession } from "./edits.js";
export type { ApplyEditsOptions, ApplyEditsResult, EditOp, RollbackItem, RollbackSessionOptions, RollbackSessionResult } from "./edits.js";

export { classifyManagedObservation, isMemoryDeliveryEnabled, triggerRenderSync } from "./delivery.js";
