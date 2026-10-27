/**
 * 12.5 应用与生效。
 *
 * 场景映射(spec):
 *   - "原子运行与回滚":三条编辑在同一备份会话内写入,标准回滚逐字节还原;
 *   - "采纳的生效边界":runtime 投递 agent 新会话读到新版本且无需同步;
 *     原生渲染 agent 触发同步并报告结果;生效说明入档可回放;
 *   - "批准即应用与显式应用入口":应用幂等(重复调用跳过)。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { APPLY_ARCHIVE_KIND, applyApprovedProposals } from "../../../src/evolve/apply.js";
import { readArchiveRecords } from "../../../src/evolve/archive.js";
import { decideProposal, enqueueProposal, pendingRecordsDir, readPendingRecord } from "../../../src/evolve/pending.js";
import type { Proposal } from "../../../src/evolve/types.js";
import { HostEditError, rollbackSession } from "../../../src/host/index.js";
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

/** 合法 workspace 层提案(应用阶段会重跑机械校验:路径必须在声明层
 * 之内且在表面白名单上——`.agents/**`)。`workspace` 是真实目录。 */
function proposal(id: string, path: string, content: string, workspace: string): Proposal {
  return {
    id,
    createdAt: 1_700_000_000_000,
    kind: "workspace-config-fix",
    target: path,
    layer: { kind: "workspace", root: workspace },
    evidence: [{ kind: "doctor-finding", findingId: `doctor:workspace-toml-invalid:${id}`, layer: { kind: "workspace", root: workspace } }],
    riskClass: "B",
    summary: `apply ${id}`,
    edits: [{ op: "write-file", path, content }],
  };
}

function approve(h: string, id: string, path: string, content: string, workspace: string): void {
  enqueueProposal({ homeDir: h, proposal: proposal(id, path, content, workspace), riskClass: "B", riskRuleId: "workspace-config-fix/any" });
  const decided = decideProposal({ homeDir: h, id, decision: "approved" });
  assert.equal(decided.ok, true);
}

/** 任意编辑组合的批准捷径(部分失败/幂等重放测试用)。 */
function approveEdits(h: string, id: string, workspace: string, edits: Proposal["edits"]): void {
  const base = proposal(id, join(workspace, ".agents", `${id}.md`), "x\n", workspace);
  enqueueProposal({ homeDir: h, proposal: { ...base, edits }, riskClass: "B", riskRuleId: "workspace-config-fix/any" });
  const decided = decideProposal({ homeDir: h, id, decision: "approved" });
  assert.equal(decided.ok, true);
}

/** 造一个真实 workspace 目录(`.agents/` 在表面白名单上)。 */
function workspace(h: string): string {
  const ws = join(h, "ws");
  mkdirSync(join(ws, ".agents"), { recursive: true });
  return ws;
}

function applyRunCount(h: string): number {
  return readArchiveRecords(h).filter((e) => e.kind === APPLY_ARCHIVE_KIND).length;
}

describe("12.5 应用与生效", () => {
  it("场景:三条编辑在同一备份会话内写入,标准回滚逐字节还原", async () => {
    const h = home("trellis-apply-atomic-");
    const ws = workspace(h);
    const paths = [join(ws, ".agents", "a.md"), join(ws, ".agents", "b.md"), join(ws, ".agents", "c.md")];
    const befores = ["before-a\n", "before-b\n", "before-c\n"];
    const afters = ["after-a\n", "after-b\n", "after-c\n"];
    paths.forEach((p, i) => writeFileSync(p, befores[i]!));
    paths.forEach((p, i) => approve(h, `p-${i}`, p, afters[i]!, ws));

    const result = await applyApprovedProposals({ homeDir: h, agents: [] });
    assert.ok(result.runId !== null);
    assert.deepEqual(result.appliedProposalIds, ["p-0", "p-1", "p-2"]);
    // 三条写入全部生效。
    paths.forEach((p, i) => assert.equal(readFileSync(p, "utf-8"), afters[i]!));
    // 档案记录备份会话标识与提案集合(spec"运行档案 SHALL 记录该备份会话标识")。
    const runs = readArchiveRecords(h).filter((e) => e.kind === APPLY_ARCHIVE_KIND);
    assert.equal(runs.length, 1);
    const payload = runs[0]!.payload as { runId: string; proposalIds: string[] };
    assert.equal(payload.runId, result.runId);
    assert.deepEqual(payload.proposalIds, ["p-0", "p-1", "p-2"]);

    // 标准回滚(host 门面,与 `trellis rollback` 同一 plan/apply 路径)。
    const rollback = await rollbackSession({ homeDir: h, runId: result.runId! });
    assert.ok(rollback.items.length >= 3);
    assert.ok(rollback.items.every((item) => item.action !== "conflict"));
    // 逐字节还原。
    paths.forEach((p, i) => assert.equal(readFileSync(p, "utf-8"), befores[i]!));
  });

  it("场景:runtime 投递 agent 新会话读到新版本且无需同步", async () => {
    const h = home("trellis-apply-runtime-");
    const ws = workspace(h);
    const path = join(ws, ".agents", "skill.md");
    writeFileSync(path, "old version\n");
    approve(h, "p-rt", path, "new version\n", ws);

    let syncCalls = 0;
    const result = await applyApprovedProposals({
      homeDir: h,
      agents: [{ agent: "kimi-code", observation: "events" }],
      triggerSync: async () => {
        syncCalls += 1;
        return { exitCode: 0 };
      },
    });

    assert.ok(result.runId !== null);
    // runtime 投递:新会话读取 canonical 即新版本(9.4:provider 每请求
    // 实时读盘),无需同步。
    assert.equal(readFileSync(path, "utf-8"), "new version\n");
    assert.equal(syncCalls, 0);
    assert.equal(result.syncExitCode, null);
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0]!.observation, "events");
    assert.match(result.effects[0]!.effect, /无需同步/);
  });

  it("场景:原生渲染 agent 触发同步并报告结果", async () => {
    const h = home("trellis-apply-native-");
    const ws = workspace(h);
    const path = join(ws, ".agents", "claude.md");
    writeFileSync(path, "old\n");
    approve(h, "p-nat", path, "new\n", ws);

    let syncCalls = 0;
    const result = await applyApprovedProposals({
      homeDir: h,
      agents: [
        { agent: "claude-code", observation: "doctor-only" },
        { agent: "kimi-code", observation: "events" },
      ],
      triggerSync: async () => {
        syncCalls += 1;
        return { exitCode: 0 };
      },
    });

    assert.equal(syncCalls, 1);
    assert.equal(result.syncExitCode, 0);
    const native = result.effects.find((e) => e.agent === "claude-code");
    const runtime = result.effects.find((e) => e.agent === "kimi-code");
    assert.ok(native !== undefined && runtime !== undefined);
    assert.match(native.effect, /已触发渲染同步/);
    assert.match(native.effect, /exit 0/);
    assert.match(runtime.effect, /无需同步/);
  });

  it("无未应用的已批准提案:零副作用(不开会话、不触发同步、不写档案)", async () => {
    const h = home("trellis-apply-noop-");
    let syncCalls = 0;
    const result = await applyApprovedProposals({
      homeDir: h,
      agents: [{ agent: "claude-code", observation: "doctor-only" }],
      triggerSync: async () => {
        syncCalls += 1;
        return { exitCode: 0 };
      },
    });
    assert.equal(result.runId, null);
    assert.deepEqual(result.appliedProposalIds, []);
    assert.equal(syncCalls, 0);
    assert.equal(applyRunCount(h), 0);
  });

  it("重复调用按档案查重跳过:同一提案不开第二个会话", async () => {
    const h = home("trellis-apply-dedupe-");
    const ws = workspace(h);
    const path = join(ws, ".agents", "x.md");
    writeFileSync(path, "before\n");
    approve(h, "p-once", path, "after\n", ws);

    const first = await applyApprovedProposals({ homeDir: h, agents: [] });
    assert.ok(first.runId !== null);
    const second = await applyApprovedProposals({ homeDir: h, agents: [] });
    assert.equal(second.runId, null);
    assert.deepEqual(second.appliedProposalIds, []);
    assert.deepEqual(second.alreadyAppliedIds, ["p-once"]);
    assert.equal(applyRunCount(h), 1);
    assert.equal(readFileSync(path, "utf-8"), "after\n");
  });

  it("应用前重校验:pending 磁盘漂移的编辑被跳过,到不了写入面", async () => {
    const h = home("trellis-apply-revalidate-");
    const ws = workspace(h);
    approve(h, "p-good", join(ws, ".agents", "ok.md"), "ok\n", ws);
    // 磁盘漂移:把编辑路径改到声明层之外(伪造/手误的 pending 记录)。
    const record = readPendingRecord(h, "p-good");
    assert.ok(record !== null);
    const drifted = {
      ...record,
      proposal: { ...record.proposal, edits: [{ op: "write-file", path: join(h, "outside.txt"), content: "x\n" }] },
    };
    writeFileSync(join(pendingRecordsDir(h), "p-good.json"), JSON.stringify(drifted, null, 2) + "\n");

    const result = await applyApprovedProposals({ homeDir: h, agents: [] });
    assert.deepEqual(result.skippedInvalidIds, ["p-good"]);
    assert.equal(result.runId, null, "全部记录重校验失败 → 不开备份会话");
    assert.equal(existsSync(join(h, "outside.txt")), false, "层外路径未被写入");
    assert.equal(applyRunCount(h), 0);
  });

  it("场景:生效说明入档可回放(effects 与同步结果随 apply-run 档案)", async () => {
    const h = home("trellis-apply-effects-");
    const ws = workspace(h);
    const path = join(ws, ".agents", "eff.md");
    writeFileSync(path, "old\n");
    approve(h, "p-eff", path, "new\n", ws);

    const result = await applyApprovedProposals({
      homeDir: h,
      agents: [
        { agent: "claude-code", observation: "doctor-only" },
        { agent: "kimi-code", observation: "events" },
      ],
      triggerSync: async () => ({ exitCode: 0 }),
    });
    const runs = readArchiveRecords(h).filter((e) => e.kind === APPLY_ARCHIVE_KIND);
    const payload = runs[0]!.payload as {
      effects?: { agent: string; effect: string }[];
      syncExitCode?: number | null;
    };
    assert.equal(payload.syncExitCode, 0);
    assert.ok(Array.isArray(payload.effects));
    assert.equal(payload.effects!.length, 2);
    assert.deepEqual(
      payload.effects!.map((e) => e.agent),
      ["claude-code", "kimi-code"],
    );
    assert.equal(payload.effects![0]!.effect, result.effects[0]!.effect);
    assert.match(payload.effects![1]!.effect, /无需同步/);
  });

  it("同步触发失败收口为效果文本:应用照常完成,档案记 syncError", async () => {
    const h = home("trellis-apply-syncfail-");
    const ws = workspace(h);
    const path = join(ws, ".agents", "sf.md");
    writeFileSync(path, "old\n");
    approve(h, "p-sf", path, "new\n", ws);

    const result = await applyApprovedProposals({
      homeDir: h,
      agents: [{ agent: "claude-code", observation: "doctor-only" }],
      triggerSync: async () => {
        throw new Error("sync exploded");
      },
    });
    assert.ok(result.runId !== null, "编辑已写入:同步失败不吞应用");
    assert.equal(readFileSync(path, "utf-8"), "new\n");
    assert.equal(result.syncError, "sync exploded");
    assert.match(result.effects[0]!.effect, /触发渲染同步失败:sync exploded/);
    assert.match(result.effects[0]!.effect, /trellis sync/);
    const runs = readArchiveRecords(h).filter((e) => e.kind === APPLY_ARCHIVE_KIND);
    const payload = runs[0]!.payload as { syncError?: string; effects?: { effect: string }[] };
    assert.equal(payload.syncError, "sync exploded");
    assert.ok(payload.effects !== undefined && payload.effects.length === 1);
  });

  it("部分失败:failed 档案落盘且不计入查重,重试按幂等重放完成", async () => {
    const h = home("trellis-apply-partial-");
    const ws = workspace(h);
    const link = join(ws, ".agents", "old-link.md");
    symlinkSync(join(ws, "target-a"), link);
    const blocker = join(ws, ".agents", "blocker.md");
    writeFileSync(blocker, "regular file\n");

    // id 序即应用序:p-1-rm 成功(remove-symlink),p-2-repair 失败
    // (blocker 此刻是普通文件)。
    approveEdits(h, "p-1-rm", ws, [{ op: "remove-symlink", path: link }]);
    approveEdits(h, "p-2-repair", ws, [{ op: "repair-symlink", path: blocker, target: join(ws, "target-b") }]);

    await assert.rejects(applyApprovedProposals({ homeDir: h, agents: [] }), HostEditError);
    const runs = readArchiveRecords(h).filter((e) => e.kind === APPLY_ARCHIVE_KIND);
    assert.equal(runs.length, 1, "部分失败也落 apply-run 档案");
    const payload = runs[0]!.payload as { failed?: boolean; runId?: string };
    assert.equal(payload.failed, true);
    assert.equal(typeof payload.runId, "string", "runId 可经 rollback 撤销已应用部分");
    assert.equal(existsSync(link), false, "第一条编辑已应用");

    // 修复阻塞后重试:remove-symlink 目标已不存在 → 幂等成功;repair 继续。
    rmSync(blocker);
    symlinkSync(join(ws, "target-a"), blocker);
    const retry = await applyApprovedProposals({ homeDir: h, agents: [] });
    assert.ok(retry.runId !== null);
    assert.deepEqual([...retry.appliedProposalIds].sort(), ["p-1-rm", "p-2-repair"]);
    assert.equal(readlinkSync(blocker), join(ws, "target-b"));
  });
});
