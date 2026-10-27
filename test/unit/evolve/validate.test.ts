/**
 * 证据要求与机械校验测试(trellis-evolve 任务 12.2)。
 *
 * 对应 self-evolution spec 的场景:
 *   1. `no-evidence`:无证据提案 probe 前丢弃,档案以 `no-evidence` 记录;
 *   2. auth 目标拒绝:target 描述符(auth 块)与 `mcp/servers.yaml` 路径
 *      两形态均拒且不 probe;
 *   3. 进化自身配置拒绝(`evolve.yaml` / `evolve/`);
 *   4. 跨层拒绝:声明全局但目标在 `<repo>/.agents/` 内;workspace 提案
 *      越出 layer.root;
 *   5. 凭据字面值拒绝:workspace 编辑写凭据形态字面值以"违反可提交
 *      约束"为由拒绝;`${VAR}` 引用合法;
 *   6. 不自动升格:单 workspace 证据的全局提案不被拒绝但 `needsExplicitApproval`;
 *      全局证据/双 workspace 证据不标记;workspace 层目标不适用。
 * 外加:kind 白名单、受保护面(managed.yaml / auth.json / .credentials)、
 * 表面外用户手写文件、重试闭环(反馈接引擎 validate_tree 文案、至多一次、
 * 仍违规丢弃入档)、委派/spawn 双不可用的 rule-based fallback。
 *
 * 凭据形态字面值是被检测的测试形态(明显假值,如 `sk-fixture-not-a-real-token`),
 * 不含任何真实凭据。全部 scratch HOME;rule-based 读文件可用注入缝免写盘。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readArchiveRecords } from "../../../src/evolve/archive.js";
import {
  isDoctorFindingSignal,
  parseTomlFindingMessage,
  proposeFromSignals,
  ruleBasedProposal,
  selectProposalChannel,
} from "../../../src/evolve/propose.js";
import type { Proposal, Signal } from "../../../src/evolve/types.js";
import {
  PROPOSAL_REJECT_ARCHIVE_KIND,
  formatValidationFeedback,
  validateProposal,
  validateProposalWithRetry,
} from "../../../src/evolve/validate.js";
import { runChecks } from "../../../src/host/index.js";
import type { CheckEntry } from "../../../src/host/index.js";
import { scratchHome, seedAgentPresence, seedCanonical } from "../../helpers/home.js";

const FIXED_TS = Date.parse("2026-10-25T12:00:00Z");

function seedBase(prefix: string): string {
  const home = scratchHome(prefix);
  seedAgentPresence(home, ["claude-code", "codex"]);
  seedCanonical(home, {
    managed: ["claude-code", "codex"],
    instructions: "# instructions\n",
    serversYaml: "servers: {}\n",
  });
  return home;
}

function baseProposal(overrides: Partial<Proposal> & Pick<Proposal, "edits">): Proposal {
  return {
    id: "p-validate",
    createdAt: FIXED_TS,
    kind: "workspace-config-fix",
    target: "workspace/.agents/config.json",
    layer: { kind: "global" },
    evidence: [{ kind: "doctor-finding", findingId: "doctor:x" }],
    riskClass: "B",
    summary: "机械校验测试提案",
    ...overrides,
  };
}

function codesOf(issues: readonly { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

test("no-evidence:无证据提案丢弃,档案以 no-evidence 记录", async () => {
  const home = seedBase("v-no-evidence");
  const proposal = baseProposal({
    id: "p-no-ev",
    layer: { kind: "workspace", root: join(home, "proj") },
    evidence: [],
    edits: [{ op: "write-file", path: join(home, "proj", ".agents", "config.json"), content: "{}\n" }],
  });

  const validation = validateProposal(proposal, { homeDir: home });
  assert.equal(validation.ok, false);
  assert.deepEqual(codesOf(validation.issues), ["no-evidence"]);

  const result = await validateProposalWithRetry({ homeDir: home, proposal, now: () => FIXED_TS });
  assert.equal(result.status, "discarded");
  if (result.status !== "discarded") return;
  assert.equal(result.code, "no-evidence");
  assert.equal(result.phase, "initial");
  assert.equal(result.attempts, 1);

  const rejects = readArchiveRecords(home).filter((entry) => entry.kind === PROPOSAL_REJECT_ARCHIVE_KIND);
  assert.equal(rejects.length, 1);
  const payload = rejects[0]!.payload as { proposalId: string; code: string; retried: boolean };
  assert.equal(payload.proposalId, "p-no-ev");
  assert.equal(payload.code, "no-evidence");
  assert.equal(payload.retried, false);
});

test("auth 目标拒绝:target 描述符与 servers.yaml 路径两形态均 target-protected", () => {
  const home = seedBase("v-auth");
  const ws = join(home, "proj");
  mkdirSync(join(ws, ".agents"), { recursive: true });

  // 形态 a:target 描述符是 MCP auth 块。
  const byDescriptor = baseProposal({
    id: "p-auth-descriptor",
    target: "mcp server foo auth block",
    layer: { kind: "workspace", root: ws },
    edits: [{ op: "write-file", path: join(ws, ".agents", "config.json"), content: "{}\n" }],
  });
  const a = validateProposal(byDescriptor, { homeDir: home });
  assert.equal(a.ok, false);
  assert.ok(a.issues.some((issue) => issue.code === "target-protected"));
  assert.match(a.issues.find((issue) => issue.code === "target-protected")!.message, /auth/);

  // 形态 b:编辑路径直指 mcp/servers.yaml(MCP auth 配置整文件)。
  const byPath = baseProposal({
    id: "p-auth-path",
    kind: "mcp-config-fix",
    target: "global mcp servers.yaml",
    layer: { kind: "global" },
    edits: [
      {
        op: "write-file",
        path: join(home, ".trellis", "mcp", "servers.yaml"),
        content: "servers: {}\n",
      },
    ],
  });
  const b = validateProposal(byPath, { homeDir: home });
  assert.equal(b.ok, false);
  assert.ok(b.issues.some((issue) => issue.code === "target-protected"));
  assert.match(b.issues.find((issue) => issue.code === "target-protected")!.message, /servers\.yaml/);
});

test("受保护面:managed.yaml / auth.json / .credentials / 表面外用户手写文件", () => {
  const home = seedBase("v-protected");
  const ws = join(home, "proj");
  mkdirSync(join(ws, ".agents"), { recursive: true });

  const cases: Array<{ id: string; path: string; code: string }> = [
    { id: "p-managed", path: join(home, ".trellis", "managed.yaml"), code: "target-protected" },
    { id: "p-auth-json", path: join(home, ".codex", "auth.json"), code: "target-protected" },
    { id: "p-credentials", path: join(home, ".credentials"), code: "target-protected" },
    { id: "p-env", path: join(home, ".env"), code: "target-protected" },
    { id: "p-evolve", path: join(home, ".trellis", "evolve.yaml"), code: "target-protected" },
    { id: "p-evolve-dir", path: join(home, ".trellis", "evolve", "x.json"), code: "target-protected" },
    // Trellis 自有表面之外的用户手写文件。
    { id: "p-handwritten", path: join(ws, "notes.txt"), code: "target-not-on-surface" },
    { id: "p-servers-oauth-dir", path: join(home, ".trellis", "mcp", "oauth", "token.json"), code: "target-protected" },
  ];

  for (const item of cases) {
    const proposal = baseProposal({
      id: item.id,
      layer: item.path.startsWith(ws) ? { kind: "workspace", root: ws } : { kind: "global" },
      edits: [{ op: "write-file", path: item.path, content: "x\n" }],
    });
    const result = validateProposal(proposal, { homeDir: home });
    assert.equal(result.ok, false, item.id);
    assert.ok(codesOf(result.issues).includes(item.code), `${item.id}: ${codesOf(result.issues).join(",")}`);
  }
});

test("进化自身配置拒绝:evolve.yaml 与 evolve/ 下路径 target-protected 且写明原因", () => {
  const home = seedBase("v-evolve-self");
  for (const path of [join(home, ".trellis", "evolve.yaml"), join(home, ".trellis", "evolve", "archive", "records.jsonl")]) {
    const result = validateProposal(
      baseProposal({
        id: "p-self",
        layer: { kind: "global" },
        edits: [{ op: "write-file", path, content: "x\n" }],
      }),
      { homeDir: home },
    );
    assert.equal(result.ok, false);
    const hit = result.issues.find((issue) => issue.code === "target-protected");
    assert.ok(hit, path);
    assert.match(hit.message, /进化自身配置/);
  }
});

test("跨层拒绝:声明全局但目标在 <repo>/.agents/ 内;workspace 提案越出 root", () => {
  const home = seedBase("v-layer");
  // 仓库嵌在 HOME 之下:`.agents/` 段 parent ≠ home → workspace 形态。
  const repo = join(home, "proj");
  mkdirSync(join(repo, ".agents"), { recursive: true });

  const globalAtWorkspaceAgents = baseProposal({
    id: "p-cross",
    kind: "sync-config-fix",
    target: "repo .agents/config.json",
    layer: { kind: "global" },
    edits: [{ op: "write-file", path: join(repo, ".agents", "config.json"), content: "{}\n" }],
  });
  const cross = validateProposal(globalAtWorkspaceAgents, { homeDir: home });
  assert.equal(cross.ok, false);
  const mismatch = cross.issues.find((issue) => issue.code === "layer-mismatch");
  assert.ok(mismatch, codesOf(cross.issues).join(","));
  assert.match(mismatch.message, /\.agents\//);

  // workspace 提案越出 layer.root(目标是全局可编辑面)。
  const workspaceEscapes = baseProposal({
    id: "p-escape",
    layer: { kind: "workspace", root: repo },
    edits: [{ op: "write-file", path: join(home, ".trellis", "agents.md"), content: "# x\n" }],
  });
  const escape = validateProposal(workspaceEscapes, { homeDir: home });
  assert.equal(escape.ok, false);
  assert.ok(codesOf(escape.issues).includes("layer-mismatch"), codesOf(escape.issues).join(","));
});

test("凭据字面值拒绝:workspace 编辑写凭据形态字面值以'违反可提交约束'为由拒绝;${VAR} 引用合法", () => {
  const home = seedBase("v-commit");
  const ws = join(home, "proj");
  mkdirSync(join(ws, ".agents"), { recursive: true });
  const targetPath = join(ws, ".agents", "config.json");

  // 形态字面值(明显假值,用于验证形态检测)→ 违反可提交约束。
  for (const content of [
    '{"apiKey": "sk-fixture-not-a-real-token"}',
    '{"token": "ghp_fixturefixturefixture"}',
    'api_key = "fixture-credential-value"',
  ]) {
    const result = validateProposal(
      baseProposal({
        id: "p-literal",
        layer: { kind: "workspace", root: ws },
        edits: [{ op: "write-file", path: targetPath, content }],
      }),
      { homeDir: home },
    );
    assert.equal(result.ok, false, content);
    const hit = result.issues.find((issue) => issue.code === "workspace-commit-violation");
    assert.ok(hit, codesOf(result.issues).join(","));
    assert.match(hit.message, /可提交约束/);
  }

  // `${VAR}` 引用是可提交约束明确允许的形态。
  const varRef = validateProposal(
    baseProposal({
      id: "p-var-ref",
      layer: { kind: "workspace", root: ws },
      edits: [
        {
          op: "write-file",
          path: targetPath,
          content: '{"apiKey": "${TRELLIS_FIXTURE_KEY}"}\n',
        },
      ],
    }),
    { homeDir: home },
  );
  assert.deepEqual(varRef.issues, [], JSON.stringify(varRef.issues));
  assert.equal(varRef.ok, true);
});

test("不自动升格:单 workspace 证据的全局提案 ok 但需显式批准;全局/双 workspace 不标记", () => {
  const home = seedBase("v-promote");
  const w1 = join(home, "w1");
  const w2 = join(home, "w2");
  const globalTarget = join(home, ".trellis", "agents.md");
  const globalEdit = [{ op: "write-file" as const, path: globalTarget, content: "# x\n" }];

  // 单 workspace 证据 → 标记(不拒绝,呈现等待显式批准)。
  const single = validateProposal(
    baseProposal({
      id: "p-upgrade",
      kind: "sync-config-fix",
      target: "shared agents.md",
      layer: { kind: "global" },
      evidence: [{ kind: "doctor-finding", findingId: "doctor:a", layer: { kind: "workspace", root: w1 } }],
      edits: globalEdit,
    }),
    { homeDir: home },
  );
  assert.equal(single.ok, true, JSON.stringify(single.issues));
  assert.equal(single.needsExplicitApproval, true);
  assert.equal(single.promotionScope, "single-workspace");

  // 有全局层证据 → 不标记。
  const withGlobal = validateProposal(
    baseProposal({
      id: "p-upgrade-global-ev",
      kind: "sync-config-fix",
      target: "shared agents.md",
      layer: { kind: "global" },
      evidence: [
        { kind: "doctor-finding", findingId: "doctor:a", layer: { kind: "workspace", root: w1 } },
        { kind: "doctor-finding", findingId: "doctor:b", layer: { kind: "global" } },
      ],
      edits: globalEdit,
    }),
    { homeDir: home },
  );
  assert.equal(withGlobal.needsExplicitApproval, false);
  assert.equal(withGlobal.promotionScope, "multi-context");

  // 两个不同 workspace 的证据 = 另一上下文存在 → 不标记。
  const twoWorkspaces = validateProposal(
    baseProposal({
      id: "p-upgrade-two",
      kind: "sync-config-fix",
      target: "shared agents.md",
      layer: { kind: "global" },
      evidence: [
        { kind: "doctor-finding", findingId: "doctor:a", layer: { kind: "workspace", root: w1 } },
        { kind: "doctor-finding", findingId: "doctor:c", layer: { kind: "workspace", root: w2 } },
      ],
      edits: globalEdit,
    }),
    { homeDir: home },
  );
  assert.equal(twoWorkspaces.needsExplicitApproval, false);
  assert.equal(twoWorkspaces.promotionScope, "multi-context");

  // 证据层未知:无法证明另一上下文 → 从严标记。
  const unknown = validateProposal(
    baseProposal({
      id: "p-upgrade-unknown",
      kind: "sync-config-fix",
      target: "shared agents.md",
      layer: { kind: "global" },
      evidence: [{ kind: "run", runId: "run-1" }],
      edits: globalEdit,
    }),
    { homeDir: home },
  );
  assert.equal(unknown.ok, true, JSON.stringify(unknown.issues));
  assert.equal(unknown.needsExplicitApproval, true);
  assert.equal(unknown.promotionScope, "unknown");

  // workspace 层目标不存在升格问题。
  const wsProposal = validateProposal(
    baseProposal({
      id: "p-no-upgrade",
      layer: { kind: "workspace", root: w1 },
      evidence: [{ kind: "doctor-finding", findingId: "doctor:a", layer: { kind: "workspace", root: w1 } }],
      edits: [{ op: "write-file", path: join(w1, ".agents", "config.json"), content: "{}\n" }],
    }),
    { homeDir: home },
  );
  assert.equal(wsProposal.needsExplicitApproval, false);
  assert.equal(wsProposal.promotionScope, "not-applicable");
});

test("kind 白名单:内容类 kind 拒为 kind-not-allowed", () => {
  const home = seedBase("v-kind");
  const result = validateProposal(
    baseProposal({
      id: "p-content-kind",
      kind: "skill-content-edit",
      layer: { kind: "global" },
      edits: [{ op: "write-file", path: join(home, ".trellis", "agents.md"), content: "# x\n" }],
    }),
    { homeDir: home },
  );
  assert.equal(result.ok, false);
  assert.ok(codesOf(result.issues).includes("kind-not-allowed"));
});

test("重试闭环:反馈接引擎 validate_tree 文案,修订后通过;仍违规丢弃入档", async () => {
  const home = seedBase("v-retry");
  const ws = join(home, "proj");
  mkdirSync(join(ws, ".agents"), { recursive: true });

  // 通过路径:首版无证据 → 反馈 → 修订后 ok(attempts 2)。
  let seenFeedback = "";
  const fixed = await validateProposalWithRetry({
    homeDir: home,
    proposal: baseProposal({
      id: "p-retry-ok",
      layer: { kind: "workspace", root: ws },
      evidence: [],
      edits: [{ op: "write-file", path: join(ws, ".agents", "config.json"), content: "{}\n" }],
    }),
    now: () => FIXED_TS,
    retryEditor: async (previous, feedback) => {
      seenFeedback = feedback;
      return {
        ...previous,
        evidence: [{ kind: "doctor-finding", findingId: "doctor:fixed", layer: previous.layer }],
      };
    },
  });
  assert.equal(fixed.status, "accepted");
  if (fixed.status !== "accepted") return;
  assert.equal(fixed.attempts, 2);
  assert.match(seenFeedback, /YOUR PREVIOUS ATTEMPT WAS REJECTED/);
  assert.match(seenFeedback, /no-evidence/);
  assert.equal(fixed.validation.ok, true);

  // 仍违规:修订版依旧写凭据字面值 → 丢弃 retry-exhausted + 入档。
  const exhausted = await validateProposalWithRetry({
    homeDir: home,
    proposal: baseProposal({
      id: "p-retry-bad",
      layer: { kind: "workspace", root: ws },
      evidence: [],
      edits: [{ op: "write-file", path: join(ws, ".agents", "config.json"), content: "{}\n" }],
    }),
    now: () => FIXED_TS,
    retryEditor: async (previous) => ({
      ...previous,
      evidence: [{ kind: "doctor-finding", findingId: "doctor:x", layer: previous.layer }],
      edits: [
        {
          op: "write-file" as const,
          path: join(ws, ".agents", "config.json"),
          content: '{"apiKey": "sk-fixture-not-a-real-token"}',
        },
      ],
    }),
  });
  assert.equal(exhausted.status, "discarded");
  if (exhausted.status !== "discarded") return;
  assert.equal(exhausted.phase, "retry-exhausted");
  assert.equal(exhausted.attempts, 2);
  assert.equal(exhausted.code, "workspace-commit-violation");

  const rejects = readArchiveRecords(home).filter((entry) => entry.kind === PROPOSAL_REJECT_ARCHIVE_KIND);
  assert.equal(rejects.length, 1);
  const payload = rejects[0]!.payload as { code: string; phase: string; retried: boolean; issues: unknown[] };
  assert.equal(payload.code, "workspace-commit-violation");
  assert.equal(payload.phase, "retry-exhausted");
  assert.equal(payload.retried, true);
  assert.ok(payload.issues.length >= 1);

  // editor 放弃:retry-declined。
  const declined = await validateProposalWithRetry({
    homeDir: home,
    proposal: baseProposal({
      id: "p-retry-decline",
      layer: { kind: "workspace", root: ws },
      evidence: [],
      edits: [{ op: "write-file", path: join(ws, ".agents", "config.json"), content: "{}\n" }],
    }),
    now: () => FIXED_TS,
    retryEditor: async () => null,
  });
  assert.equal(declined.status, "discarded");
  if (declined.status !== "discarded") return;
  assert.equal(declined.phase, "retry-declined");
});

test("反馈文案形态:issue 列表渲染为可执行说明", () => {
  const feedback = formatValidationFeedback([
    { code: "no-evidence", message: "提案没有任何证据链接" },
    { code: "target-protected", message: "MCP auth 配置受硬排除" },
  ]);
  assert.match(feedback, /^# YOUR PREVIOUS ATTEMPT WAS REJECTED/);
  assert.match(feedback, /- \[no-evidence\] 提案没有任何证据链接/);
  assert.match(feedback, /- \[target-protected\] MCP auth 配置受硬排除/);
  assert.match(feedback, /Fix the listed problems and reply with a revised proposal\./);
});

test("通道选择:委派/spawn 双不可用才降级 rule-based", () => {
  assert.equal(selectProposalChannel({ delegate: false, spawn: false }), "rule-based");
  assert.equal(selectProposalChannel({ delegate: true, spawn: false }), "editor");
  assert.equal(selectProposalChannel({ delegate: false, spawn: true }), "editor");
  assert.equal(selectProposalChannel({ delegate: true, spawn: true }), "editor");
});

test("消息解析:workspace-toml 消息 → 路径/行/列/原因", () => {
  const parsed = parseTomlFindingMessage(
    "/tmp/ws/.codex/config.toml:1:6 — Invalid TOML document: invalid value (not rendered by Trellis; fix by hand)",
  );
  assert.ok(parsed);
  assert.equal(parsed.path, "/tmp/ws/.codex/config.toml");
  assert.equal(parsed.line, 1);
  assert.equal(parsed.column, 6);
  assert.equal(parsed.reason, "Invalid TOML document: invalid value");

  const bare = parseTomlFindingMessage("/tmp/ws/.codex/config.toml — boom (not rendered by Trellis; fix by hand)");
  assert.ok(bare);
  assert.equal(bare.line, undefined);
  assert.equal(bare.reason, "boom");

  assert.equal(parseTomlFindingMessage("no separator here"), null);
});

test("ruleBasedProposal:注释失败行;无行号/JSON/空行/已注释不硬造", () => {
  const ws = "/tmp/fixture-ws";
  const tomlPath = join(ws, ".codex", "config.toml");
  const entry = (message: string, kind = "workspace-toml-invalid"): CheckEntry => ({
    id: `doctor:${kind}:codex:${message}`,
    source: "doctor",
    kind,
    layer: { kind: "workspace", root: ws },
    message,
  });
  const message = (path: string, line?: number) =>
    `${path}${line !== undefined ? `:${line}` : ""} — Invalid TOML document: invalid value (not rendered by Trellis; fix by hand)`;

  // 正常修复:失败行行首加 `# `。
  const fixable = entry(message(tomlPath, 2));
  const proposal = ruleBasedProposal(fixable, {
    id: "rule-1",
    now: () => FIXED_TS,
    readFile: () => "good = 1\nbad = [\n",
  });
  assert.ok(proposal);
  assert.equal(proposal.id, "rule-1");
  assert.equal(proposal.kind, "workspace-config-fix");
  assert.equal(proposal.target, tomlPath);
  assert.deepEqual(proposal.layer, { kind: "workspace", root: ws });
  assert.deepEqual(proposal.evidence, [
    { kind: "doctor-finding", findingId: fixable.id, layer: fixable.layer },
  ]);
  assert.equal(proposal.edits.length, 1);
  const edit = proposal.edits[0]!;
  assert.equal(edit.op, "write-file");
  if (edit.op !== "write-file") return;
  assert.equal(edit.content, "good = 1\n# bad = [\n");

  // 无行号 → 不硬造。
  assert.equal(ruleBasedProposal(entry(message(tomlPath)), { readFile: () => "x = 1\n" }), null);
  // 非 .toml(JSON 无注释语法)→ 不硬造。
  assert.equal(
    ruleBasedProposal(entry(message(join(ws, ".mcp.json"), 1)), { readFile: () => "{}\n" }),
    null,
  );
  // 空行 / 已注释行 → 不硬造。
  assert.equal(ruleBasedProposal(entry(message(tomlPath, 1)), { readFile: () => "\nx = 1\n" }), null);
  assert.equal(ruleBasedProposal(entry(message(tomlPath, 1)), { readFile: () => "# x = 1\n" }), null);
  // 读不到文件 → null。
  assert.equal(
    ruleBasedProposal(entry(message(tomlPath, 1)), {
      readFile: () => {
        throw new Error("injected read failure");
      },
    }),
    null,
  );
  // 非 workspace-toml-invalid kind → null。
  assert.equal(ruleBasedProposal(entry(message(tomlPath, 1), "mcp-unreachable"), { readFile: () => "x = 1\n" }), null);
});

test("fallback:委派/spawn 双不可用时 doctor finding 形态信号走 rule-based 提案", async () => {
  const home = seedBase("v-fallback");
  // 真实 fixture:坏 workspace TOML,runChecks 产出 doctor finding。
  const ws = mkdtempSync(join(tmpdir(), "trellis-fallback-ws-"));
  mkdirSync(join(ws, ".codex"), { recursive: true });
  writeFileSync(join(ws, ".codex", "config.toml"), "x = [unclosed\n");
  const checks = await runChecks({ homeDir: home, workspaceRoot: ws });
  const invalid = checks.entries.find((entry) => entry.kind === "workspace-toml-invalid");
  assert.ok(invalid, JSON.stringify(checks.entries, null, 2));

  const doctorSignal: Signal = {
    kind: "user-correction",
    source: "agent-report",
    stableId: invalid.id,
    collectedAt: FIXED_TS,
    layer: invalid.layer,
    ts: FIXED_TS,
    agent: "codex",
    session: "s1",
    text: "config.toml does not parse",
  };
  const otherSignal: Signal = {
    kind: "tool-call",
    source: "gateway-event",
    stableId: "tool-call:other",
    collectedAt: FIXED_TS,
    layer: { kind: "global" },
    ts: FIXED_TS,
    agent: "claude-code",
    session: "s2",
    provider: "p",
    tool: "t",
    durationMs: 1,
    result: "ok",
  };
  assert.equal(isDoctorFindingSignal(doctorSignal), true);
  assert.equal(isDoctorFindingSignal(otherSignal), false);

  const result = proposeFromSignals({
    signals: [otherSignal, doctorSignal, doctorSignal],
    findings: checks.entries,
    availability: { delegate: false, spawn: false },
    now: () => FIXED_TS,
  });
  assert.equal(result.channel, "rule-based");
  assert.equal(result.proposals.length, 1, JSON.stringify(result.skipped));
  assert.deepEqual(result.skipped, []);

  const proposal = result.proposals[0]!;
  // 机械修复产出的草稿本身要过机械校验(证据/白名单/层/可提交约束)。
  const validation = validateProposal(proposal, { homeDir: home });
  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));
  assert.equal(validation.needsExplicitApproval, false);
  const edit = proposal.edits[0]!;
  if (edit.op !== "write-file") return;
  assert.equal(edit.path, join(ws, ".codex", "config.toml"));
  assert.equal(edit.content.split("\n")[0], "# x = [unclosed");
  // 只是草稿:真实文件未被改动。
  assert.equal(readFileSync(join(ws, ".codex", "config.toml"), "utf-8"), "x = [unclosed\n");

  // editor 通道可用时不代产提案。
  const editorSide = proposeFromSignals({
    signals: [doctorSignal],
    findings: checks.entries,
    availability: { delegate: true, spawn: false },
    now: () => FIXED_TS,
  });
  assert.equal(editorSide.channel, "editor");
  assert.deepEqual(editorSide.proposals, []);

  // 无法机械修复的 finding 记入 skipped。
  const unfixable: CheckEntry = {
    id: "doctor:mcp-unreachable:-:x",
    source: "doctor",
    kind: "mcp-unreachable",
    layer: { kind: "global" },
    message: "server unreachable",
  };
  const skippedResult = proposeFromSignals({
    signals: [
      {
        kind: "user-correction",
        source: "agent-report",
        stableId: unfixable.id,
        collectedAt: FIXED_TS,
        layer: { kind: "global" },
        ts: FIXED_TS,
        agent: "claude-code",
        session: "s3",
        text: "unreachable",
      },
    ],
    findings: [unfixable],
    availability: { delegate: false, spawn: false },
    now: () => FIXED_TS,
  });
  assert.equal(skippedResult.proposals.length, 0);
  assert.equal(skippedResult.skipped.length, 1);
  assert.match(skippedResult.skipped[0]!.reason, /机械修复/);
});
