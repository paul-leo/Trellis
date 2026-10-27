/**
 * 12.4 pending 提案存储与 agent 只读接口。
 *
 * 场景映射(spec):
 *   - "agent 能读到待批提案" → 摘要/证据/风险级别,不含凭据;
 *   - "agent 接口没有批准能力" → 导出面无变更类操作 + 调用零写入。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import * as agentView from "../../../src/evolve/agentView.js";
import { readArchiveRecords } from "../../../src/evolve/archive.js";
import {
  PROPOSAL_DECISION_ARCHIVE_KIND,
  decideProposal,
  enqueueProposal,
  pendingRecordsDir,
  readPendingRecord,
  readPendingRecords,
  readProposalsByStatus,
  safeProposalFileName,
} from "../../../src/evolve/pending.js";
import type { Proposal } from "../../../src/evolve/types.js";
import { scratchHome } from "../../helpers/home.js";

const scratches: string[] = [];
function home(prefix: string): string {
  const dir = scratchHome(prefix);
  scratches.push(dir);
  return dir;
}
after(() => {
  while (scratches.length > 0) {
    const dir = scratches.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function proposal(id: string, summary: string, extra?: Partial<Proposal>): Proposal {
  return {
    id,
    createdAt: 1_700_000_000_000,
    kind: "workspace-config-fix",
    target: "/tmp/ws/.codex/config.toml",
    layer: { kind: "workspace", root: "/tmp/ws" },
    evidence: [{ kind: "doctor-finding", findingId: "doctor:workspace-toml-invalid:ws:path", layer: { kind: "workspace", root: "/tmp/ws" } }],
    riskClass: "B",
    summary,
    edits: [{ op: "write-file", path: "/tmp/ws/.codex/config.toml", content: "# bad = [\n" }],
    ...extra,
  };
}

function enqueue(h: string, id: string, summary = "fix toml"): void {
  enqueueProposal({
    homeDir: h,
    proposal: proposal(id, summary),
    riskClass: "B",
    riskRuleId: "workspace-config-fix/any",
  });
}

describe("12.4 pending 存储与状态机", () => {
  it("入队往返:一提案一文件,读回完整记录", () => {
    const h = home("trellis-pending-");
    enqueue(h, "p-one");
    enqueue(h, "p-two", "second");
    const all = readPendingRecords(h);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => r.id), ["p-one", "p-two"]);
    const one = readPendingRecord(h, "p-one");
    assert.ok(one !== null);
    assert.equal(one.status, "pending");
    assert.equal(one.riskClass, "B");
    assert.equal(one.riskRuleId, "workspace-config-fix/any");
    assert.equal(one.proposal.summary, "fix toml");
    assert.equal(one.decidedAt, null);
  });

  it("id 文件名路径安全(特殊字符不逃逸 pending/ 目录)", () => {
    assert.equal(safeProposalFileName("p/../x"), "p_.._x");
    assert.equal(safeProposalFileName("ok-id.1"), "ok-id.1");
    const h = home("trellis-pending-safe-");
    enqueue(h, "evil/../name");
    assert.ok(existsSync(join(pendingRecordsDir(h), "evil_.._name.json")));
  });

  it("决策状态迁移 + 档案 proposal-decision;重复决策拒绝;不存在报 not-found", () => {
    const h = home("trellis-pending-decide-");
    enqueue(h, "p-decide");
    const ok = decideProposal({ homeDir: h, id: "p-decide", decision: "approved", now: () => 1_700_000_001_000 });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.record.status, "approved");
    assert.equal(ok.record.decidedAt, 1_700_000_001_000);

    const entries = readArchiveRecords(h).filter((e) => e.kind === PROPOSAL_DECISION_ARCHIVE_KIND);
    assert.equal(entries.length, 1);
    const payload = entries[0]!.payload as { proposalId: string; decision: string; riskClass: string; riskRuleId: string };
    assert.equal(payload.proposalId, "p-decide");
    assert.equal(payload.decision, "approved");
    assert.equal(payload.riskClass, "B");

    const again = decideProposal({ homeDir: h, id: "p-decide", decision: "rejected" });
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error, "already-decided");

    const missing = decideProposal({ homeDir: h, id: "nope", decision: "approved" });
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.error, "not-found");
  });

  it("reject 路径同样落档案", () => {
    const h = home("trellis-pending-reject-");
    enqueue(h, "p-rej");
    const ok = decideProposal({ homeDir: h, id: "p-rej", decision: "rejected" });
    assert.equal(ok.ok, true);
    assert.equal(readProposalsByStatus(h, "rejected").length, 1);
    assert.equal(readProposalsByStatus(h, "pending").length, 0);
  });
});

describe("12.4 agent 只读接口", () => {
  it("场景:两条 pending → 两条摘要(证据 + 风险级别),不含凭据", () => {
    const h = home("trellis-agent-view-");
    enqueue(h, "p-a", "修复 a");
    enqueue(h, "p-b", "修复 b");
    decideProposal({ homeDir: h, id: "p-b", decision: "approved" });

    const list = agentView.listPendingSummaries(h);
    assert.equal(list.length, 1);
    const item = list[0]!;
    assert.equal(item.id, "p-a");
    assert.equal(item.summary, "修复 a");
    assert.equal(item.riskClass, "B");
    assert.equal(item.status, "pending");
    assert.deepEqual(item.evidence, [
      { kind: "doctor-finding", ref: "doctor:workspace-toml-invalid:ws:path" },
    ]);
    // 不含凭据材料:序列化后不得出现凭据形态。
    const serialized = JSON.stringify(list);
    assert.ok(!/sk-|ghp_|Bearer\s+\S+|BEGIN [A-Z ]*PRIVATE KEY/.test(serialized));
  });

  it("摘要文本过 secrets 擦除(纵深)", () => {
    const h = home("trellis-agent-view-erase-");
    enqueue(h, "p-erase", "use sk-fixture-not-a-real-token now");
    const list = agentView.listPendingSummaries(h);
    assert.match(list[0]!.summary, /\[REDACTED\]/);
    assert.ok(!list[0]!.summary.includes("sk-fixture-not-a-real-token"));
  });

  it("场景:agent 接口没有批准能力(导出面无变更类操作)", () => {
    const mutating = Object.keys(agentView).filter((name) =>
      /approve|reject|apply|write|update|delete|create|decide|enqueue|commit|remove|set/i.test(name),
    );
    assert.deepEqual(mutating, []);
    assert.deepEqual(Object.keys(agentView), ["listPendingSummaries"]);
  });

  it("agent 读取零写入:调用后存储与档案逐字节不变", () => {
    const h = home("trellis-agent-view-ro-");
    enqueue(h, "p-ro");
    const dir = pendingRecordsDir(h);
    const before = readdirSync(dir).map((name) => ({
      name,
      content: readFileSync(join(dir, name), "utf-8"),
      mtime: statSync(join(dir, name)).mtimeMs,
    }));
    const archiveBefore = existsSync(join(h, ".trellis", "evolve", "archive", "records.jsonl"))
      ? readFileSync(join(h, ".trellis", "evolve", "archive", "records.jsonl"), "utf-8")
      : "";

    agentView.listPendingSummaries(h);

    const afterList = readdirSync(dir).map((name) => ({
      name,
      content: readFileSync(join(dir, name), "utf-8"),
      mtime: statSync(join(dir, name)).mtimeMs,
    }));
    assert.deepEqual(afterList, before);
    const archiveAfter = existsSync(join(h, ".trellis", "evolve", "archive", "records.jsonl"))
      ? readFileSync(join(h, ".trellis", "evolve", "archive", "records.jsonl"), "utf-8")
      : "";
    assert.equal(archiveAfter, archiveBefore);
  });
});
