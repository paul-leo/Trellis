/**
 * Normalizers (trellis-onboard-closed-loop tasks.md 2.4): each stage's
 * own report shape reduced to `VerdictItem[]`, the single source both
 * the terminal verdict block and `runOnboard`'s exit code derive from.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeDoctorVerdict,
  normalizeMcpSyncVerdict,
  normalizeMemorySyncVerdict,
  normalizeMigrateVerdict,
  normalizeSecretsAuditVerdict,
  normalizeSelfVerificationVerdict,
  normalizeSyncVerdict,
} from "../../src/commands/onboardVerdict.js";
import type { AdapterPlanItem } from "../../src/core/adapter.js";
import type { MigratePlan } from "../../src/commands/migrate.js";
import type { SyncReport } from "../../src/commands/sync.js";
import type { McpSyncReport } from "../../src/commands/mcp.js";
import type { MemorySyncResult } from "../../src/commands/memory.js";
import type { SecretsAuditReport } from "../../src/commands/secretsAudit.js";
import type { DoctorReport } from "../../src/commands/doctor.js";

function planItem(overrides: Partial<AdapterPlanItem> & Pick<AdapterPlanItem, "action">): AdapterPlanItem {
  return { kind: "skill", description: "desc", target: "/some/path", ...overrides };
}

test("normalizeSyncVerdict: only conflict items become blocked verdict entries", () => {
  const report: SyncReport = {
    reports: [
      { agent: "claude-code", present: true, items: [planItem({ action: "create" }), planItem({ action: "conflict", description: "boom" })] },
      { agent: "codex", present: true, items: [planItem({ action: "remove" })] },
    ],
  };
  const items = normalizeSyncVerdict(report);
  assert.equal(items.length, 1);
  assert.equal(items[0].stage, "sync");
  assert.equal(items[0].severity, "blocked");
  assert.equal(items[0].agent, "claude-code");
  assert.equal(items[0].message, "boom");
});

test("normalizeSyncVerdict: an absent report contributes nothing, not an error", () => {
  assert.deepEqual(normalizeSyncVerdict(undefined), []);
});

test("normalizeSyncVerdict: carries remediation when the item has one", () => {
  const report: SyncReport = { reports: [{ agent: "kiro", present: true, items: [planItem({ action: "conflict", description: "boom", remediation: "do X" })] }] };
  assert.equal(normalizeSyncVerdict(report)[0].remediation, "do X");
});

test("normalizeMcpSyncVerdict: same shape as sync, labelled with its own stage name", () => {
  const report: McpSyncReport = { reports: [{ agent: "codex", present: true, items: [planItem({ action: "conflict", description: "collides" })] }] };
  const items = normalizeMcpSyncVerdict(report);
  assert.equal(items.length, 1);
  assert.equal(items[0].stage, "mcp sync");
});

test("normalizeMigrateVerdict: only conflict items become blocked, detail carries through", () => {
  const plan: MigratePlan = {
    items: [
      { kind: "skill", name: "a", action: "create", detail: "will copy" },
      { kind: "instructions", name: "agents.md", action: "conflict", detail: "already has different content" },
    ],
  };
  const items = normalizeMigrateVerdict(plan);
  assert.equal(items.length, 1);
  assert.equal(items[0].stage, "migrate");
  assert.equal(items[0].message, "already has different content");
});

test("normalizeMemorySyncVerdict: unconfigured is a warning, never blocked", () => {
  const result: MemorySyncResult = { configured: false, reason: "no memory server configured" };
  const items = normalizeMemorySyncVerdict(result);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "warning");
  assert.equal(items[0].stage, "memory sync");
});

test("normalizeMemorySyncVerdict: a real conflict is blocked", () => {
  const result: MemorySyncResult = {
    configured: true,
    graphPath: "/graph.jsonl",
    plan: { items: [{ name: "notes", action: "conflict", detail: "collides with a non-trellis entity" }] },
  };
  const items = normalizeMemorySyncVerdict(result);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "blocked");
});

test("normalizeMemorySyncVerdict: a clean configured run contributes nothing", () => {
  const result: MemorySyncResult = { configured: true, graphPath: "/graph.jsonl", plan: { items: [{ name: "notes", action: "create", detail: "will add" }] } };
  assert.deepEqual(normalizeMemorySyncVerdict(result), []);
});

test("normalizeSecretsAuditVerdict: every finding is blocked, environment findings carry no agent", () => {
  const report: SecretsAuditReport = {
    findings: [
      { agent: "claude-code", file: "/f1", kind: "literal-secret", detail: "matches reject pattern" },
      { agent: "environment", file: "/f2", kind: "missing-env-value", detail: "no value anywhere" },
    ],
  };
  const items = normalizeSecretsAuditVerdict(report);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.severity === "blocked"));
  assert.equal(items[0].agent, "claude-code");
  assert.equal(items[1].agent, undefined);
});

test("normalizeDoctorVerdict: a finding on a managed agent is blocked", () => {
  const report: DoctorReport = { snapshots: [], findings: [{ kind: "collision", agent: "claude-code", message: "collides" }] };
  const items = normalizeDoctorVerdict(report, ["claude-code"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "blocked");
});

test("normalizeDoctorVerdict: a finding on an unmanaged agent is a warning, labelled", () => {
  const report: DoctorReport = { snapshots: [], findings: [{ kind: "case-mismatch", agent: "kiro", message: "wrong case" }] };
  const items = normalizeDoctorVerdict(report, ["claude-code"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "warning");
  assert.match(items[0].remediation ?? "", /kiro/);
});

test("normalizeDoctorVerdict: a cross-agent drift finding (no agent field) is conservatively blocked", () => {
  const report: DoctorReport = { snapshots: [], findings: [{ kind: "drift", message: "differs across agents" }] };
  const items = normalizeDoctorVerdict(report, ["claude-code"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "blocked");
  assert.equal(items[0].agent, undefined);
});

test("normalizeDoctorVerdict: an absent report contributes nothing", () => {
  assert.deepEqual(normalizeDoctorVerdict(undefined, ["claude-code"]), []);
});

test("normalizeSelfVerificationVerdict: a remaining create or conflict item after a real apply is always blocked", () => {
  const reports = [{ agent: "claude-code" as const, items: [planItem({ action: "create", target: "/x", description: "still missing" })] }];
  const items = normalizeSelfVerificationVerdict("sync", reports);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "blocked");
  assert.equal(items[0].stage, "sync (verify)");
  assert.match(items[0].message, /still missing/);
});

test("normalizeSelfVerificationVerdict: an empty re-plan (the normal case) contributes nothing", () => {
  const reports = [{ agent: "claude-code" as const, items: [] }];
  assert.deepEqual(normalizeSelfVerificationVerdict("sync", reports), []);
});

test("normalizeSelfVerificationVerdict: a remove item is not a verification failure — removal isn't verified here", () => {
  const reports = [{ agent: "claude-code" as const, items: [planItem({ action: "remove" })] }];
  assert.deepEqual(normalizeSelfVerificationVerdict("mcp sync", reports), []);
});
