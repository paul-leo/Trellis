/**
 * 12.3 风险分类器与采纳门:分类表逐行测试 + 四个过门场景。
 *
 * 场景映射(spec "风险分级与采纳门"):
 *   - 场景1 自动采纳并通知     → "auto-A + Class A + probe 通过时自动采纳并通知"
 *   - 场景2 低于 auto-A 不自动 → "propose 级别下 Class A 也不自动采纳"
 *   - 场景3 无法分类按 B       → "未知 kind 不匹配任何规则 → B 呈现等待批准"
 *   - 场景4 升格仍按 B         → "auto-A 下单 workspace 证据升格不自动采纳"
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EditOp, Level, SurfaceLayer } from "../../../src/host/index.js";
import type { Proposal } from "../../../src/evolve/types.js";
import {
  RISK_RULES,
  classifyProposalRisk,
  evaluateAdoptionGate,
  type RiskClassification,
} from "../../../src/evolve/risk.js";

const scratches: string[] = [];
function scratchHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}
after(() => {
  while (scratches.length > 0) {
    const dir = scratches.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function baseProposal(overrides: {
  kind: string;
  target: string;
  edits?: readonly EditOp[];
  layer?: SurfaceLayer;
  evidence?: Proposal["evidence"];
  id?: string;
}): Proposal {
  return {
    id: overrides.id ?? "p-risk",
    createdAt: 1_700_000_000_000,
    kind: overrides.kind,
    target: overrides.target,
    layer: overrides.layer ?? { kind: "global" },
    evidence: overrides.evidence ?? [
      { kind: "doctor-finding", findingId: "doctor:fixture:agent:path", layer: { kind: "global" } },
    ],
    riskClass: "B",
    summary: "fixture",
    edits: overrides.edits ?? [{ op: "write-file", path: overrides.target, content: "x = 1\n" }],
  };
}

describe("12.3 分类表:kind + target 形态 → A/B", () => {
  it("sync-config-fix + agent 原生 home 配置面 → A(drift 修复)", () => {
    const home = scratchHome("trellis-risk-a1-");
    const path = join(home, ".claude.json");
    const proposal = baseProposal({ kind: "sync-config-fix", target: path, edits: [{ op: "write-file", path, content: "{}\n" }] });
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "A");
    assert.equal(result.ruleId, "sync-config-fix/agent-native");
    assert.equal(result.demotedByPromotion, false);
  });

  it("secrets-policy-fix + secrets.policy.yaml → A(补 `${VAR}` 名形态)", () => {
    const home = scratchHome("trellis-risk-a2-");
    const path = join(home, ".trellis", "secrets.policy.yaml");
    const proposal = baseProposal({
      kind: "secrets-policy-fix",
      target: path,
      edits: [{ op: "write-file", path, content: "allowed: [MY_VAR]\n" }],
    });
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "A");
    assert.equal(result.ruleId, "secrets-policy-fix/secrets-policy");
  });

  it("workspace-config-fix → B(workspace 配置 git 可见,对外副作用非零)", () => {
    const home = scratchHome("trellis-risk-b1-");
    const root = join(home, "proj");
    const path = join(root, ".codex", "config.toml");
    const layer: SurfaceLayer = { kind: "workspace", root };
    const proposal = baseProposal({
      kind: "workspace-config-fix",
      target: path,
      layer,
      evidence: [{ kind: "doctor-finding", findingId: "doctor:workspace-toml-invalid", layer }],
      edits: [{ op: "write-file", path, content: "# bad = [\n" }],
    });
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "B");
    assert.equal(result.ruleId, "workspace-config-fix/any");
    assert.equal(result.demotedByPromotion, false);
  });

  it("mcp-config-fix → B(路由编辑永远人批)", () => {
    const home = scratchHome("trellis-risk-b2-");
    const path = join(home, ".trellis", "mcp", "routes.yaml");
    const proposal = baseProposal({ kind: "mcp-config-fix", target: path, edits: [{ op: "write-file", path, content: "routes: {}\n" }] });
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "B");
    assert.equal(result.ruleId, "mcp-config-fix/any");
  });

  it("oauth-config-fix → B(auth 相邻不自动)", () => {
    const home = scratchHome("trellis-risk-b3-");
    const proposal = baseProposal({ kind: "oauth-config-fix", target: "oauth policy surface" });
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "B");
    assert.equal(result.ruleId, "oauth-config-fix/any");
  });

  it("同 kind 但 target 形态不匹配 → 兜底 B(sync-config-fix 打到非原生面)", () => {
    const home = scratchHome("trellis-risk-fb-");
    const path = join(home, ".trellis", "skills", "demo", "SKILL.md");
    const proposal = baseProposal({ kind: "sync-config-fix", target: path, edits: [{ op: "write-file", path, content: "# demo\n" }] });
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "B");
    assert.equal(result.ruleId, "fallback-unclassified");
    assert.match(result.reason, /无法分类按 B/);
  });

  it("不采信自报 riskClass:自报 A 的 workspace 提案仍按表算 B", () => {
    const home = scratchHome("trellis-risk-self-");
    const root = join(home, "proj");
    const path = join(root, ".mcp.json");
    const layer: SurfaceLayer = { kind: "workspace", root };
    const proposal = {
      ...baseProposal({ kind: "workspace-config-fix", target: path, layer }),
      riskClass: "A",
    } as const;
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "B");
  });

  it("C 前置:auth 描述符与受保护路径 → C(校验阶段已拒,分类器映射)", () => {
    const home = scratchHome("trellis-risk-c-");
    const byDescriptor = classifyProposalRisk(
      baseProposal({ kind: "mcp-config-fix", target: "mcp server foo auth block" }),
      { homeDir: home },
    );
    assert.equal(byDescriptor.riskClass, "C");
    assert.equal(byDescriptor.ruleId, "protected/auth-descriptor");

    const servers = join(home, ".trellis", "mcp", "servers.yaml");
    const byPath = classifyProposalRisk(
      baseProposal({ kind: "mcp-config-fix", target: servers, edits: [{ op: "write-file", path: servers, content: "servers: {}\n" }] }),
      { homeDir: home },
    );
    assert.equal(byPath.riskClass, "C");
    assert.equal(byPath.ruleId, "protected/path");
  });

  it("升格降级:全局目标 + 单 workspace 证据 → 一律 B(消费 12.2 标记)", () => {
    const home = scratchHome("trellis-risk-promo-");
    const path = join(home, ".trellis", "agents.md");
    const wsLayer: SurfaceLayer = { kind: "workspace", root: join(home, "proj") };
    const proposal = baseProposal({
      kind: "sync-config-fix",
      target: path,
      edits: [{ op: "write-file", path, content: "# note\n" }],
      evidence: [{ kind: "doctor-finding", findingId: "doctor:drift:ws", layer: wsLayer }],
    });
    const result = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(result.riskClass, "B");
    assert.equal(result.ruleId, "promotion-demotion");
    assert.equal(result.demotedByPromotion, true);

    // 显式传入 12.2 标记时同结果(消费点)。
    const flagged = classifyProposalRisk(proposal, { homeDir: home, needsExplicitApproval: true });
    assert.equal(flagged.riskClass, "B");
    assert.equal(flagged.demotedByPromotion, true);

    // 全局层证据 → 不降级(A 规则正常命中)。
    const nativePath = join(home, ".claude.json");
    const multi = baseProposal({
      kind: "sync-config-fix",
      target: nativePath,
      edits: [{ op: "write-file", path: nativePath, content: "{}\n" }],
    });
    const multiResult = classifyProposalRisk(multi, { homeDir: home });
    assert.equal(multiResult.riskClass, "A");
    assert.equal(multiResult.demotedByPromotion, false);
  });

  it("分类表与文档对齐:每条规则都有 kind + 形态 + 注释", () => {
    assert.ok(RISK_RULES.length >= 5);
    for (const rule of RISK_RULES) {
      assert.ok(rule.kind.length > 0);
      assert.ok(rule.note.length > 0);
      assert.ok(rule.riskClass === "A" || rule.riskClass === "B");
      assert.ok(["any", "agent-native", "secrets-policy"].includes(rule.targetShape));
    }
  });
});

function classAOnHome(home: string): Proposal {
  const path = join(home, ".claude.json");
  return baseProposal({
    kind: "sync-config-fix",
    target: path,
    edits: [{ op: "write-file", path, content: "{}\n" }],
  });
}

describe("12.3 采纳门四个过门场景", () => {
  it("场景1:auto-A + Class A + probe 通过 → 自动采纳,通知含编辑/证据/回滚路径", () => {
    const home = scratchHome("trellis-risk-g1-");
    const proposal = classAOnHome(home);
    const classification = classifyProposalRisk(proposal, { homeDir: home });
    const decision = evaluateAdoptionGate({
      level: "auto-A",
      classification,
      probePassed: true,
      proposal,
    });
    assert.equal(decision.action, "auto-adopt");
    assert.equal(decision.riskClass, "A");
    if (decision.action !== "auto-adopt") return;
    // 通知中指明编辑、证据与回滚路径。
    const notice = decision.notification;
    assert.equal(notice.proposalId, proposal.id);
    assert.deepEqual(notice.editPaths, [join(home, ".claude.json")]);
    assert.match(notice.message, /\.claude\.json/);
    assert.match(notice.message, /doctor-finding:doctor:fixture:agent:path/);
    assert.match(notice.message, /回滚:/);
    assert.match(notice.message, /trellis rollback/);
    assert.ok(notice.evidence.length >= 1);
  });

  it("场景2:propose 级别下 Class A 也不自动采纳(呈现等待批准)", () => {
    const home = scratchHome("trellis-risk-g2-");
    const proposal = classAOnHome(home);
    const classification = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(classification.riskClass, "A");
    const decision = evaluateAdoptionGate({
      level: "propose",
      classification,
      probePassed: true,
      proposal,
    });
    assert.equal(decision.action, "await-approval");
    assert.equal(decision.riskClass, "A");
    assert.match(decision.reason, /低于 auto-A/);
  });

  it("场景3:无法分类(未知 kind)→ B,即使 auto-A 也呈现等待批准", () => {
    const home = scratchHome("trellis-risk-g3-");
    const path = join(home, ".trellis", "agents.md");
    const proposal = baseProposal({
      kind: "skill-content-edit",
      target: path,
      edits: [{ op: "write-file", path, content: "# x\n" }],
    });
    const classification = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(classification.riskClass, "B");
    assert.equal(classification.ruleId, "fallback-unclassified");
    const decision = evaluateAdoptionGate({
      level: "auto-A",
      classification,
      probePassed: true,
      proposal,
    });
    assert.equal(decision.action, "await-approval");
    assert.equal(decision.riskClass, "B");
  });

  it("场景4:auto-A 下升格编辑仍按 B 呈现,不自动采纳", () => {
    const home = scratchHome("trellis-risk-g4-");
    const path = join(home, ".trellis", "agents.md");
    const wsLayer: SurfaceLayer = { kind: "workspace", root: join(home, "proj") };
    const proposal = baseProposal({
      kind: "secrets-policy-fix",
      target: path,
      edits: [{ op: "write-file", path, content: "# promote\n" }],
      evidence: [{ kind: "doctor-finding", findingId: "doctor:drift:ws-only", layer: wsLayer }],
    });
    const classification = classifyProposalRisk(proposal, { homeDir: home });
    assert.equal(classification.riskClass, "B");
    assert.equal(classification.demotedByPromotion, true);
    const decision = evaluateAdoptionGate({
      level: "auto-A",
      classification,
      probePassed: true,
      proposal,
    });
    assert.equal(decision.action, "await-approval");
    assert.equal(decision.riskClass, "B");
    assert.match(decision.reason, /升格/);
  });

  it("防御:probe 未通过时 Class A 不自动采纳", () => {
    const home = scratchHome("trellis-risk-g5-");
    const proposal = classAOnHome(home);
    const classification = classifyProposalRisk(proposal, { homeDir: home });
    const decision = evaluateAdoptionGate({
      level: "auto-A",
      classification,
      probePassed: false,
      proposal,
    });
    assert.equal(decision.action, "await-approval");
    assert.match(decision.reason, /probe/);
  });

  it("防御:off/observe 级别永远不自动;C 类不到自动采纳", () => {
    const home = scratchHome("trellis-risk-g6-");
    const proposal = classAOnHome(home);
    const classification: RiskClassification = classifyProposalRisk(proposal, { homeDir: home });
    const levels: Level[] = ["off", "observe"];
    for (const level of levels) {
      const decision = evaluateAdoptionGate({ level, classification, probePassed: true, proposal });
      assert.equal(decision.action, "await-approval");
    }
    const cDecision = evaluateAdoptionGate({
      level: "auto-A",
      classification: { riskClass: "C", ruleId: "protected/path", reason: "受保护", demotedByPromotion: false },
      probePassed: true,
      proposal,
    });
    assert.equal(cDecision.action, "await-approval");
    assert.equal(cDecision.riskClass, "C");
  });

  it("自定义回滚指引进入通知(12.5 应用后替换为真实会话指引)", () => {
    const home = scratchHome("trellis-risk-g7-");
    const proposal = classAOnHome(home);
    const classification = classifyProposalRisk(proposal, { homeDir: home });
    const decision = evaluateAdoptionGate({
      level: "auto-A",
      classification,
      probePassed: true,
      proposal,
      rollbackHint: "trellis rollback --session run-42",
    });
    assert.equal(decision.action, "auto-adopt");
    if (decision.action !== "auto-adopt") return;
    assert.equal(decision.notification.rollbackPath, "trellis rollback --session run-42");
    assert.match(decision.notification.message, /run-42/);
  });
});
