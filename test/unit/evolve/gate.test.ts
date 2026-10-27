/**
 * L1 doctor-oracle 前闸测试(trellis-evolve 任务 12.1)。
 *
 * 对应 self-evolution spec 的四个场景:
 *   1. 命中的修复可采纳(baseline 含 workspace-toml-invalid,候选不含,
 *      无其他差异 → 可采纳,两份 verdict 入档);
 *   2. 引入回归则不可采纳(候选解决目标条目但引入新条目 → 不可采纳,
 *      新条目入档);
 *   3. 被 workspace tombstone 的全局编辑不影响该 workspace 的 verdict
 *      (对照组:无墓碑上下文同编辑确实改变条目;并断言 staging 副本带
 *      墓碑文件 —— staging 复现层分裂);
 *   4. 强制报错收口(测量失败 → 不可采纳 + verdict unknown)。
 * 外加域分派:内容类 kind 不进提案通道、不测量。
 *
 * 场景 1–3 用真实 runChecks / createStaging / applyEdits(与 host.test.ts
 * 同款 fixture);场景 4 与域分派用注入缝。凭据面只写公共 OAuth 元数据
 * (kind/owner),不含任何 client secret 或 token。全部在 scratch HOME 上。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readArchiveRecords } from "../../../src/evolve/archive.js";
import {
  VERDICT_ARCHIVE_KIND,
  diffVerdictEntries,
  dispatchProposalDomain,
  doctorFindingTargetIds,
  entryKey,
  evaluateL1Proposal,
} from "../../../src/evolve/gate.js";
import type { Proposal } from "../../../src/evolve/types.js";
import { createStaging, runChecks } from "../../../src/host/index.js";
import type { CreateStagingOptions, Staging } from "../../../src/host/index.js";
import { scratchHome, seedAgentPresence, seedCanonical } from "../../helpers/home.js";

const FIXED_TS = Date.parse("2026-10-25T12:00:00Z");

function scratchWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `trellis-${prefix}-`));
}

/** 最小 fixture:托管 claude-code+codex、空 servers、无效 workspace TOML。 */
function seedTomlFixture(prefix: string): { home: string; workspace: string } {
  const home = scratchHome(prefix);
  seedAgentPresence(home, ["claude-code", "codex"]);
  seedCanonical(home, {
    managed: ["claude-code", "codex"],
    instructions: "# instructions\n",
    serversYaml: "servers: {}\n",
  });
  const workspace = scratchWorkspace(`${prefix}-ws`);
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  writeFileSync(join(workspace, ".codex", "config.toml"), "x = [unclosed\n");
  return { home, workspace };
}

function baseProposal(overrides: Partial<Proposal> & Pick<Proposal, "edits">): Proposal {
  return {
    id: "p-l1",
    createdAt: FIXED_TS,
    kind: "workspace-config-fix",
    target: "workspace/.codex/config.toml",
    layer: { kind: "global" },
    evidence: [],
    riskClass: "B",
    summary: "L1 前闸测试提案",
    ...overrides,
  };
}

test("场景 1:命中修复可采纳 —— workspace-toml-invalid 被消除且无其他差异,两份 verdict 入档", async () => {
  const { home, workspace } = seedTomlFixture("l1-fix");
  const pre = await runChecks({ homeDir: home, workspaceRoot: workspace });
  const invalid = pre.entries.find((entry) => entry.kind === "workspace-toml-invalid");
  assert.ok(invalid, JSON.stringify(pre.entries, null, 2));
  assert.deepEqual(invalid.layer, { kind: "workspace", root: workspace });

  const proposal = baseProposal({
    id: "p-fix",
    target: join(workspace, ".codex", "config.toml"),
    layer: { kind: "workspace", root: workspace },
    evidence: [{ kind: "doctor-finding", findingId: invalid.id }],
    summary: "修复 workspace config.toml 解析错误",
    edits: [{ op: "write-file", path: join(workspace, ".codex", "config.toml"), content: "# fixed\n" }],
  });

  const result = await evaluateL1Proposal({
    homeDir: home,
    workspaceRoot: workspace,
    proposal,
    now: () => FIXED_TS,
  });

  assert.equal(result.decision, "acceptable");
  assert.equal(result.reason, "候选消除全部目标条目,无新条目,其余不变");
  assert.equal(result.verdict.status, "ok");
  assert.deepEqual(result.verdict.layer, { kind: "workspace", root: workspace });
  assert.deepEqual(result.resolvedIds, [invalid.id]);
  assert.deepEqual(result.introduced, []);
  assert.ok(result.verdict.baseline.some((entry) => entry.id === invalid.id), "baseline 含目标条目");
  assert.ok(!result.verdict.candidate.some((entry) => entry.id === invalid.id), "候选不含目标条目");

  // staging 修复不泄漏:真实 workspace 仍是坏的。
  assert.equal(readFileSync(join(workspace, ".codex", "config.toml"), "utf-8"), "x = [unclosed\n");

  // 两份 verdict 入档(baseline 与 candidate 完整条目集 + 判定原因)。
  const verdicts = readArchiveRecords(home).filter((entry) => entry.kind === VERDICT_ARCHIVE_KIND);
  assert.equal(verdicts.length, 1);
  const payload = verdicts[0]!.payload as {
    proposalId: string;
    decision: string;
    status: string;
    layer: unknown;
    targetIds: string[];
    baseline: unknown[];
    candidate: unknown[];
  };
  assert.equal(payload.proposalId, "p-fix");
  assert.equal(payload.decision, "acceptable");
  assert.equal(payload.status, "ok");
  assert.deepEqual(payload.layer, { kind: "workspace", root: workspace });
  assert.deepEqual(payload.targetIds, [invalid.id]);
  assert.ok(Array.isArray(payload.baseline) && payload.baseline.length > 0, "baseline 测量入档");
  assert.ok(Array.isArray(payload.candidate) && payload.candidate.length < payload.baseline.length, "candidate 测量入档");
});

test("场景 2:引入回归不可采纳 —— 目标被消除但新增 oauth 条目,新条目入档", async () => {
  const { home, workspace } = seedTomlFixture("l1-regress");
  const pre = await runChecks({ homeDir: home, workspaceRoot: workspace });
  const invalid = pre.entries.find((entry) => entry.kind === "workspace-toml-invalid");
  assert.ok(invalid);

  // 修 TOML 的同时往全局 servers.yaml 引入一个从未授权的 trellis-owned
  // OAuth server → 新增 oauth-expired 条目(公共元数据,无任何凭据值)。
  const serversYaml = [
    "servers:",
    "  bar:",
    "    transport: http",
    '    url: "https://example.invalid/mcp"',
    "    auth:",
    "      kind: oauth",
    "      owner: trellis",
    "",
  ].join("\n");

  const proposal = baseProposal({
    id: "p-regress",
    target: join(workspace, ".codex", "config.toml"),
    layer: { kind: "workspace", root: workspace },
    evidence: [{ kind: "doctor-finding", findingId: invalid.id }],
    summary: "修复 TOML 但引入未授权 OAuth server",
    edits: [
      { op: "write-file", path: join(workspace, ".codex", "config.toml"), content: "# fixed\n" },
      { op: "write-file", path: join(home, ".trellis", "mcp", "servers.yaml"), content: serversYaml },
    ],
  });

  const result = await evaluateL1Proposal({
    homeDir: home,
    workspaceRoot: workspace,
    proposal,
    now: () => FIXED_TS,
  });

  assert.equal(result.decision, "not-acceptable");
  assert.match(result.reason, /新条目/);
  assert.equal(result.verdict.status, "ok", "测量本身成功 —— 不可采纳不是测量失败");
  assert.deepEqual(result.resolvedIds, [invalid.id], "目标条目确实被消除");
  assert.equal(result.introduced.length, 1, JSON.stringify(result.introduced, null, 2));
  assert.equal(result.introduced[0]!.kind, "oauth-expired");
  assert.match(result.introduced[0]!.message, /"bar"/);

  // 新条目入档。
  const verdicts = readArchiveRecords(home).filter((entry) => entry.kind === VERDICT_ARCHIVE_KIND);
  assert.equal(verdicts.length, 1);
  const payload = verdicts[0]!.payload as { decision: string; introduced: Array<{ message: string }> };
  assert.equal(payload.decision, "not-acceptable");
  assert.equal(payload.introduced.length, 1);
  assert.match(payload.introduced[0]!.message, /"bar"/);
});

test("场景 3:被 workspace tombstone 的全局编辑不影响该 workspace 的 verdict;对照组同编辑确实改变", async () => {
  const home = scratchHome("l1-tombstone");
  seedAgentPresence(home, ["claude-code", "codex"]);
  // 全局定义 trellis-owned OAuth server foo(无 token → oauth-expired);
  // 只写公共元数据 kind/owner,无 client secret。
  seedCanonical(home, {
    managed: ["claude-code", "codex"],
    instructions: "# instructions\n",
    serversYaml: [
      "servers:",
      "  foo:",
      "    transport: http",
      '    url: "https://example.invalid/mcp"',
      "    auth:",
      "      kind: oauth",
      "      owner: trellis",
      "",
    ].join("\n"),
  });

  // W_tomb:墓碑 foo;W_open:无墓碑。层分裂由 .agents/config.json 表达。
  const wTomb = scratchWorkspace("l1-w-tomb");
  mkdirSync(join(wTomb, ".agents"), { recursive: true });
  writeFileSync(
    join(wTomb, ".agents", "config.json"),
    JSON.stringify({ mcp: { servers: { foo: { enabled: false } } } }),
  );
  const wOpen = scratchWorkspace("l1-w-open");
  mkdirSync(join(wOpen, ".agents"), { recursive: true });

  // 同一条全局编辑:从 servers.yaml 移除 foo。
  const globalEdit = {
    op: "write-file" as const,
    path: join(home, ".trellis", "mcp", "servers.yaml"),
    content: "servers: {}\n",
  };

  // ---- 对照组(W_open,无墓碑):同编辑确实改变条目 ----
  const preOpen = await runChecks({ homeDir: home, workspaceRoot: wOpen });
  const fooFinding = preOpen.entries.find(
    (entry) => entry.kind === "oauth-expired" && entry.message.includes('"foo"'),
  );
  assert.ok(fooFinding, JSON.stringify(preOpen.entries, null, 2));

  const openProposal = baseProposal({
    id: "p-open",
    kind: "mcp-config-fix",
    target: "global mcp servers.yaml foo",
    layer: { kind: "global" },
    evidence: [{ kind: "doctor-finding", findingId: fooFinding.id }],
    summary: "移除全局 foo 定义",
    edits: [globalEdit],
  });
  const openResult = await evaluateL1Proposal({
    homeDir: home,
    workspaceRoot: wOpen,
    proposal: openProposal,
    now: () => FIXED_TS,
  });
  assert.equal(openResult.decision, "acceptable", openResult.reason);
  assert.deepEqual(openResult.resolvedIds, [fooFinding.id], "无墓碑上下文:foo 的 oauth-expired 被消除");

  // ---- 被测组(W_tomb,墓碑):同编辑不影响该 workspace 的 verdict ----
  let stagedTombstone: { seen: boolean; content: string | null } = { seen: false, content: null };
  const createStagingSpy = (opts: CreateStagingOptions): Staging => {
    const staging = createStaging(opts);
    // staging 复现层分裂:scratch workspace 必须带墓碑文件。
    const tombPath = staging.workspaceRoot !== null ? join(staging.workspaceRoot, ".agents", "config.json") : null;
    stagedTombstone = {
      seen: tombPath !== null && existsSync(tombPath),
      content: tombPath !== null && existsSync(tombPath) ? readFileSync(tombPath, "utf-8") : null,
    };
    return staging;
  };

  const tombProposal = baseProposal({
    id: "p-tomb",
    kind: "mcp-config-fix",
    target: "global mcp servers.yaml foo",
    layer: { kind: "global" },
    // 目标条目取对照组所见的全局 finding id —— 在被墓碑的 workspace 里
    // 它不可见,这正是"不影响该 workspace 的 verdict"的直接表达。
    evidence: [{ kind: "doctor-finding", findingId: fooFinding.id }],
    summary: "移除全局 foo 定义(在墓碑 workspace 中评估)",
    edits: [globalEdit],
  });
  const tombResult = await evaluateL1Proposal({
    homeDir: home,
    workspaceRoot: wTomb,
    proposal: tombProposal,
    createStagingFn: createStagingSpy,
    now: () => FIXED_TS,
  });

  // 墓碑把目标条目从合并视图移除:目标不可见 → 无法确认修复(不采纳)。
  assert.equal(tombResult.decision, "not-acceptable");
  assert.match(tombResult.reason, /无法确认修复/);
  // 该 workspace 的 verdict 不因此变化:无引入、无消除,条目集逐键相等。
  assert.deepEqual(tombResult.introduced, []);
  assert.deepEqual(tombResult.resolvedIds, []);
  const tombDiff = diffVerdictEntries(tombResult.verdict.baseline, tombResult.verdict.candidate);
  assert.deepEqual(tombDiff.introduced, []);
  assert.deepEqual(tombDiff.resolved, []);
  assert.deepEqual(
    tombResult.verdict.baseline.map(entryKey).sort(),
    tombResult.verdict.candidate.map(entryKey).sort(),
  );
  // 被测组的 foo 条目从一开始就不可见(墓碑生效于合并视图)。
  assert.ok(!tombResult.verdict.baseline.some((entry) => entry.message.includes('"foo"')));
  // staging 副本带墓碑文件且内容一致(层分裂被 scratch 复现)。
  assert.equal(stagedTombstone.seen, true, "staging workspace 必须带 .agents/config.json 墓碑");
  assert.equal(stagedTombstone.content, JSON.stringify({ mcp: { servers: { foo: { enabled: false } } } }));
});

test("场景 4:强制报错收口 —— 测量失败按'不采纳'收口,verdict 记 unknown 不表示为通过", async () => {
  const { home, workspace } = seedTomlFixture("l1-throw");
  const proposal = baseProposal({
    id: "p-throw",
    target: join(workspace, ".codex", "config.toml"),
    layer: { kind: "workspace", root: workspace },
    evidence: [{ kind: "doctor-finding", findingId: "doctor:workspace-toml-invalid:codex:injected" }],
    edits: [{ op: "write-file", path: join(workspace, ".codex", "config.toml"), content: "# fixed\n" }],
  });

  const result = await evaluateL1Proposal({
    homeDir: home,
    workspaceRoot: workspace,
    proposal,
    now: () => FIXED_TS,
    runChecksFn: async () => {
      throw new Error("injected measurement failure");
    },
  });

  assert.equal(result.decision, "not-acceptable");
  assert.equal(result.verdict.status, "unknown");
  assert.deepEqual(result.verdict.baseline, [], "测量失败不得表示为零分/通过");
  assert.deepEqual(result.verdict.candidate, []);
  assert.match(result.reason, /不采纳/);
  assert.match(result.reason, /injected measurement failure/);
  assert.deepEqual(result.introduced, []);
  assert.deepEqual(result.resolvedIds, []);

  // 失败判定同样入档,status 为 unknown。
  const verdicts = readArchiveRecords(home).filter((entry) => entry.kind === VERDICT_ARCHIVE_KIND);
  assert.equal(verdicts.length, 1);
  const payload = verdicts[0]!.payload as { decision: string; status: string; reason: string };
  assert.equal(payload.decision, "not-acceptable");
  assert.equal(payload.status, "unknown");
  assert.match(payload.reason, /injected measurement failure/);
});

test("域分派:配置类 kind 进入提案通道,内容类 kind 本期不产出且不测量", async () => {
  // 白名单逐项是配置类。
  for (const kind of ["workspace-config-fix", "mcp-config-fix", "sync-config-fix", "secrets-policy-fix", "oauth-config-fix"]) {
    const dispatch = dispatchProposalDomain(kind);
    assert.equal(dispatch.domain, "config");
    assert.equal(dispatch.entersProposalChannel, true);
  }
  // 名单外(含内容类)不进通道。
  for (const kind of ["skill-content-edit", "memory-body-edit", "instructions-content-edit", "unknown-kind"]) {
    const dispatch = dispatchProposalDomain(kind);
    assert.equal(dispatch.domain, "content");
    assert.equal(dispatch.entersProposalChannel, false);
    assert.match(dispatch.note, /不产出/);
  }

  // evaluate 对内容类提案:不采纳 + 不测量(createStaging 都不会被调用)。
  const home = scratchHome("l1-domain");
  seedAgentPresence(home, ["claude-code"]);
  seedCanonical(home, { managed: ["claude-code"], instructions: "# instructions\n", serversYaml: "servers: {}\n" });
  let staged = false;
  const result = await evaluateL1Proposal({
    homeDir: home,
    proposal: baseProposal({
      id: "p-content",
      kind: "skill-content-edit",
      evidence: [{ kind: "doctor-finding", findingId: "doctor:any:any:any" }],
      edits: [{ op: "write-file", path: join(home, ".claude.json"), content: "{}" }],
    }),
    now: () => FIXED_TS,
    createStagingFn: () => {
      staged = true;
      throw new Error("must not reach staging for content proposals");
    },
  });
  assert.equal(staged, false, "内容类提案不进入测量通道");
  assert.equal(result.decision, "not-acceptable");
  assert.equal(result.domain, "content");
  assert.match(result.reason, /不在配置类白名单/);
  assert.equal(result.verdict.status, "unknown");
  assert.deepEqual(result.verdict.baseline, []);
  assert.deepEqual(result.verdict.candidate, []);
});

test("无 doctor-finding 目标条目:按'无法确认修复'不采纳(测量记 unknown)", async () => {
  const home = scratchHome("l1-no-target");
  const result = await evaluateL1Proposal({
    homeDir: home,
    proposal: baseProposal({
      id: "p-no-target",
      evidence: [{ kind: "run", runId: "run-1" }],
      edits: [{ op: "write-file", path: join(home, "x.txt"), content: "x" }],
    }),
    now: () => FIXED_TS,
    createStagingFn: () => {
      throw new Error("must not reach staging without a target");
    },
  });
  assert.equal(result.decision, "not-acceptable");
  assert.match(result.reason, /无法确认修复/);
  assert.equal(result.verdict.status, "unknown");
  assert.deepEqual(doctorFindingTargetIds([{ kind: "run", runId: "r" }, { kind: "doctor-finding", findingId: "f1" }]), ["f1"]);
});
