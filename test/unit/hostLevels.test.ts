/**
 * 分级开启测试(trellis-evolve 任务 10.2)与观测形态标注(任务 11.4)。
 *
 * 对应 self-evolution spec 的三个场景:默认关闭零副作用、更具体的级别
 * 覆盖更宽泛的、开启状态对 doctor 可见;外加策略读写往返、损坏文件的
 * 硬错误,以及 doctor 区分"事件观察 / 只有 doctor/sync 信号"两类 agent。
 * 全部在 scratch HOME 上进行,不触碰真实配置。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectDoctorReport, printReport, type DoctorReport } from "../../src/commands/doctor.js";
import {
  describeEvolveLevels,
  evolveLevelPolicyPath,
  loadEvolveLevelPolicy,
  resolveEvolveLevel,
  writeEvolveLevelPolicy,
} from "../../src/host/levels.js";
import type { EvolveLevelPolicy } from "../../src/host/levels.js";
import { scratchHome, seedAgentPresence, seedCanonical } from "../helpers/home.js";

test("默认关闭且零副作用:无 evolve.yaml 时全部解析为 off,读取不落盘,doctor 无该段", async () => {
  const home = scratchHome("levels-default");
  seedAgentPresence(home, ["claude-code"]);
  seedCanonical(home, { managed: ["claude-code"], instructions: "# global\n" });

  const policy = loadEvolveLevelPolicy(home);
  assert.deepEqual(policy, { agents: {}, workspaces: {} });
  assert.equal(resolveEvolveLevel(policy, { agent: "claude-code", workspaceRoot: "/tmp/any" }), "off");
  assert.equal(resolveEvolveLevel(policy, {}), "off");

  // 读取零副作用:既无策略文件,也无运行状态目录。
  assert.equal(existsSync(evolveLevelPolicyPath(home)), false);
  assert.equal(existsSync(join(home, ".trellis", "evolve")), false);

  const report = await collectDoctorReport(home);
  assert.equal(report.evolve, undefined);
});

test("更具体的级别覆盖更宽泛的:workspace > agent > 全局默认 > off", () => {
  const home = scratchHome("levels-override");
  const policy: EvolveLevelPolicy = {
    defaultLevel: "observe",
    agents: { codex: "propose" },
    workspaces: { "/tmp/ws-alpha": "off" },
  };
  writeEvolveLevelPolicy(home, policy);

  // workspace 覆盖盖过全局默认( spec 场景:全局 observe、某 workspace off)。
  assert.equal(resolveEvolveLevel(policy, { agent: "claude-code", workspaceRoot: "/tmp/ws-alpha" }), "off");
  // 其他位置仍按全局默认记录。
  assert.equal(resolveEvolveLevel(policy, { agent: "claude-code", workspaceRoot: "/tmp/other" }), "observe");
  // agent 覆盖盖过全局默认。
  assert.equal(resolveEvolveLevel(policy, { agent: "codex", workspaceRoot: "/tmp/other" }), "propose");
  // workspace 比 agent 更具体,仍然优先。
  assert.equal(resolveEvolveLevel(policy, { agent: "codex", workspaceRoot: "/tmp/ws-alpha" }), "off");
  // 无 workspace 上下文时按 agent / 默认取值。
  assert.equal(resolveEvolveLevel(policy, { agent: "codex" }), "propose");
  assert.equal(resolveEvolveLevel(policy, { agent: "claude-code" }), "observe");

  // 往返:显式写入 canonical 后读回,字段与层覆盖不变。
  assert.deepEqual(loadEvolveLevelPolicy(home), policy);
});

test("开启状态对 doctor 可见:某 agent 设置 propose 后 doctor 输出列出其级别", async () => {
  const home = scratchHome("levels-doctor");
  seedAgentPresence(home, ["claude-code"]);
  seedCanonical(home, { managed: ["claude-code"], instructions: "# global\n" });
  writeEvolveLevelPolicy(home, {
    defaultLevel: "observe",
    agents: { "claude-code": "propose" },
    workspaces: { "/tmp/ws-alpha": "off" },
  });

  const report = await collectDoctorReport(home);
  assert.ok(report.evolve, "doctor 报告应包含 evolve 段");
  assert.equal(report.evolve.defaultLevel, "observe");
  assert.deepEqual(report.evolve.agents, [{ agent: "claude-code", level: "propose", observation: "doctor-only" }]);
  assert.deepEqual(report.evolve.workspaces, [{ root: "/tmp/ws-alpha", level: "off" }]);

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printReport(report);
  } finally {
    console.log = originalLog;
  }
  const text = lines.join("\n");
  assert.match(text, /Self-evolution \(evolve\.yaml\)/);
  assert.match(text, /agent claude-code: propose/);
  assert.match(text, /workspace \/tmp\/ws-alpha: off/);
});

test("doctor 列出 pending 数量:无级别配置时单列一行,有级别配置时列在段内", async () => {
  const home = scratchHome("levels-doctor-pending");
  seedAgentPresence(home, ["claude-code"]);
  seedCanonical(home, { managed: ["claude-code"], instructions: "# global\n" });
  // pending 记录按存储格式直写(hostingIndependence:托管侧测试不 import
  // 消费者模块;doctor 只认 `.trellis/evolve/pending/*.json` 的 status 字段)。
  const pendingDir = join(home, ".trellis", "evolve", "pending");
  mkdirSync(pendingDir, { recursive: true });
  for (const id of ["p-1", "p-2"]) {
    writeFileSync(join(pendingDir, `${id}.json`), JSON.stringify({ id, status: "pending" }) + "\n", "utf-8");
  }
  const capture = (report: DoctorReport): string => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      printReport(report);
    } finally {
      console.log = originalLog;
    }
    return lines.join("\n");
  };

  // 无 evolve.yaml:单列一行(spec SHALL 的 else-if 分支)。
  let report = await collectDoctorReport(home);
  assert.equal(report.evolvePending, 2);
  assert.match(capture(report), /Self-evolution: 2 pending proposal\(s\)/);

  // 有 evolve.yaml:段内 pending 行。
  writeEvolveLevelPolicy(home, { defaultLevel: "observe", agents: {}, workspaces: {} });
  report = await collectDoctorReport(home);
  assert.equal(report.evolvePending, 2);
  const text = capture(report);
  assert.match(text, /Self-evolution \(evolve\.yaml\)/);
  assert.match(text, /pending proposals: 2/);
});

test("describeEvolveLevels:托管 agent 逐个列出生效级别与观测形态,显式覆盖之外按默认回退", () => {
  const policy: EvolveLevelPolicy = {
    defaultLevel: "observe",
    agents: { codex: "auto-A" },
    workspaces: {},
  };
  const section = describeEvolveLevels(policy, [
    { agent: "claude-code", observation: "events" },
    { agent: "codex", observation: "doctor-only" },
    { agent: "pi", observation: "events" },
  ]);
  assert.deepEqual(section.agents, [
    { agent: "claude-code", level: "observe", observation: "events" },
    { agent: "codex", level: "auto-A", observation: "doctor-only" },
    { agent: "pi", level: "observe", observation: "events" },
  ]);
  // 托管列表之外的显式 agent 覆盖同样可见(无 runtime 交付配置,
  // 观测形态按 doctor-only)。
  const extras = describeEvolveLevels({ agents: { solo: "propose" }, workspaces: {} }, [
    { agent: "claude-code", observation: "doctor-only" },
  ]);
  assert.deepEqual(extras.agents, [
    { agent: "claude-code", level: "off", observation: "doctor-only" },
    { agent: "solo", level: "propose", observation: "doctor-only" },
  ]);
});

test("doctor 区分事件观察与 doctor/sync 信号:runtime 交付标 events,仅原生渲染标 doctor-only", async () => {
  // fixture 含两类 agent:claude-code 走 runtime 交付(事件观察),
  // codex 仅原生渲染(doctor/sync 信号)。
  const home = scratchHome("levels-observation");
  seedAgentPresence(home, ["claude-code", "codex"]);
  seedCanonical(home, {
    managed: ["claude-code", "codex"],
    instructions: "# global\n",
    serversYaml: "runtime:\n  delivery:\n    claude-code: mcp\n    codex: native\n",
  });
  writeEvolveLevelPolicy(home, { defaultLevel: "observe", agents: {}, workspaces: {} });

  const report = await collectDoctorReport(home);
  assert.ok(report.evolve, "doctor 报告应包含 evolve 段");
  assert.deepEqual(report.evolve.agents, [
    { agent: "claude-code", level: "observe", observation: "events" },
    { agent: "codex", level: "observe", observation: "doctor-only" },
  ]);

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printReport(report);
  } finally {
    console.log = originalLog;
  }
  const text = lines.join("\n");
  assert.match(text, /agent claude-code: observe \(events\)/);
  assert.match(text, /agent codex: observe \(doctor-only\)/);
});

test("evolve.yaml trigger 段:读写往返保留各键,缺省键不出现;非法值硬错误", async () => {
  const home = scratchHome("levels-trigger");
  const policy: EvolveLevelPolicy = {
    defaultLevel: "observe",
    agents: {},
    workspaces: {},
    trigger: { signalThreshold: 20, cooldownMinutes: 120, dailyProposalCap: 5 },
  };
  writeEvolveLevelPolicy(home, policy);
  assert.deepEqual(loadEvolveLevelPolicy(home), policy);
  // editorBudget 未写 → 往返后仍缺省(由触发器回退)。

  // 原文形态:snake_case 键落盘。
  const raw = readFileSync(evolveLevelPolicyPath(home), "utf-8");
  assert.match(raw, /signal_threshold: 20/);
  assert.match(raw, /cooldown_minutes: 120/);
  assert.match(raw, /daily_proposal_cap: 5/);
  assert.doesNotMatch(raw, /editor_budget/);

  // 非法 trigger(未知键、负数、非整数)硬错误,不静默降级。
  writeFileSync(
    evolveLevelPolicyPath(home),
    "trigger:\n  signal_threshold: 1.5\n",
    "utf-8",
  );
  assert.throws(() => loadEvolveLevelPolicy(home), /signal_threshold/);
  writeFileSync(evolveLevelPolicyPath(home), "trigger:\n  unknown_key: 1\n", "utf-8");
  assert.throws(() => loadEvolveLevelPolicy(home), /unknown_key/);
  writeFileSync(evolveLevelPolicyPath(home), "trigger:\n  daily_proposal_cap: -1\n", "utf-8");
  assert.throws(() => loadEvolveLevelPolicy(home), /daily_proposal_cap/);
});

test("present-but-invalid:损坏的 evolve.yaml 硬错误,doctor 降级为段内诊断", async () => {
  const home = scratchHome("levels-invalid");
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(evolveLevelPolicyPath(home), "default_level: superuser\n", "utf-8");

  assert.throws(() => loadEvolveLevelPolicy(home), /default_level/);

  const report = await collectDoctorReport(home);
  assert.ok(report.evolve, "损坏策略仍出现在 doctor(带诊断)");
  assert.deepEqual(report.evolve.agents, []);
  assert.equal(report.evolve.diagnostics.length, 1);
  assert.match(report.evolve.diagnostics[0]!, /evolve\.yaml/);
});

test("writeEvolveLevelPolicy 幂等:相同策略重写产生相同文件", () => {
  const home = scratchHome("levels-idempotent");
  const policy: EvolveLevelPolicy = {
    defaultLevel: "propose",
    agents: { "claude-code": "auto-A" },
    workspaces: { "/tmp/ws-beta": "observe" },
  };
  writeEvolveLevelPolicy(home, policy);
  const first = loadEvolveLevelPolicy(home);
  writeEvolveLevelPolicy(home, first);
  assert.deepEqual(loadEvolveLevelPolicy(home), first);
  assert.deepEqual(first, policy);
});
