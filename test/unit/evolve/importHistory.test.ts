/**
 * 历史数据导入与幂等回填(trellis-evolve-run-backfill 3.1–3.4)。
 *
 * 对应 spec 场景:元数据白名单(载荷不入库)/ 凭据擦除 / 重复导入为空
 * 操作 / 导入不触发作业 / 重复消费不产生重复提案 / 不可解析源失败收口。
 * 全部在 scratch HOME 上进行;不 spawn 真实 agent CLI。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runEvolveCommand } from "../../../src/commands/evolve.js";
import { readArchiveRecords } from "../../../src/evolve/archive.js";
import { importHistory, importLedgerPath, ImportSourceError } from "../../../src/evolve/importHistory.js";
import { runEvolveJob } from "../../../src/evolve/jobRun.js";
import { readPendingRecords } from "../../../src/evolve/pending.js";
import { readSignals, signalFilePath } from "../../../src/evolve/recorder.js";
import { JOB_RUN_KIND, TRIGGER_DECISION_KIND } from "../../../src/evolve/trigger.js";
import { writeEvolveLevelPolicy } from "../../../src/host/index.js";
import { scratchHome, seedAgentPresence, seedCanonical } from "../../helpers/home.js";

const FIXED_TS = Date.parse("2026-10-20T10:00:00Z");

/** Claude Code transcript 形态的 JSONL 夹具:文本轮次 + tool_use(载荷
 * 混入凭据形态)+ tool_result(带 is_error)+ 一条坏行。 */
function writeTranscript(path: string): void {
  const lines = [
    JSON.stringify({
      type: "user",
      sessionId: "sess-1",
      timestamp: "2026-10-20T10:00:00.000Z",
      message: { role: "user", content: "please fix api_key=hunter2hunter2" },
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "sess-1",
      timestamp: "2026-10-20T10:00:01.000Z",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "cat config", token: "sk-ant-do-not-store-this-token" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      sessionId: "sess-1",
      timestamp: "2026-10-20T10:00:02.000Z",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "ghp_0123456789abcdef0123" }],
      },
    }),
    "not-json{{",
  ];
  writeFileSync(path, lines.join("\n") + "\n");
}

function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("场景:元数据白名单——载荷/正文不入库,只留白名单字段;坏行跳过计数", () => {
  const home = scratchHome("import-whitelist");
  const src = join(home, "session-a.jsonl");
  writeTranscript(src);

  const result = importHistory({ homeDir: home, paths: [src], now: () => FIXED_TS });
  assert.equal(result.written, 1, "一条 tool_use 记录写为一条 tool-call 信号");
  const source = result.sources[0]!;
  assert.equal(source.badLines, 1, "坏行跳过计数");
  assert.equal(source.skippedNoTool, 2, "文本轮次与 tool_result(无工具名)不写");

  const signals = readSignals(result.signalFile!);
  assert.equal(signals.length, 1);
  const signal = signals[0]!;
  // 字段白名单:信封 + 载荷字段,无任何载体字段(input/content/message)。
  assert.deepEqual(
    Object.keys(signal).sort(),
    ["agent", "collectedAt", "durationMs", "kind", "layer", "provider", "result", "session", "source", "stableId", "tool", "ts"].sort(),
  );
  assert.equal(signal.kind, "tool-call");
  assert.equal(signal.source, "history-import");
  assert.equal(signal.tool, "Bash");
  assert.match(signal.stableId ?? "", /^import:[0-9a-f]{12}:2$/, "stableId = import:<digest12>:<行号>");
  const raw = readFileSync(result.signalFile!, "utf-8");
  assert.ok(!raw.includes("please fix"), "正文不入库");
  assert.ok(!raw.includes("cat config"), "入参载荷不入库");
});

test("场景:凭据擦除——字符串字段过 eraseSecrets,凭据形态不落盘", () => {
  const home = scratchHome("import-erase");
  const src = join(home, "session-secret.jsonl");
  writeTranscript(src);
  const result = importHistory({ homeDir: home, paths: [src], now: () => FIXED_TS });
  const raw = readFileSync(result.signalFile!, "utf-8");
  assert.ok(!raw.includes("sk-ant-do-not-store-this-token"), "入参里的凭据(本就不入库)与任何凭据形态都不落盘");
  assert.ok(!raw.includes("hunter2hunter2"));
  assert.ok(!raw.includes("ghp_0123456789abcdef0123"));
});

test("场景:重复导入为空操作——台账幂等,不新增信号、不重复记账", () => {
  const home = scratchHome("import-dedupe");
  const src = join(home, "session-b.jsonl");
  writeTranscript(src);

  const first = importHistory({ homeDir: home, paths: [src], now: () => FIXED_TS });
  assert.equal(first.written, 1);
  const digest = digestOf(readFileSync(src, "utf-8"));
  const ledger = importLedgerPath(home, digest);
  const ledgerBefore = readFileSync(ledger, "utf-8");

  // 同内容不同文件名(同摘要)再导入:空操作。
  const copy = join(home, "session-b-copy.jsonl");
  writeFileSync(copy, readFileSync(src, "utf-8"));
  const second = importHistory({ homeDir: home, paths: [copy], now: () => FIXED_TS + 1000 });
  assert.equal(second.written, 0);
  assert.equal(second.sources[0]!.duplicate, true);
  assert.equal(second.signalFile, null);
  assert.equal(readSignals(first.signalFile!).length, 1, "不新增信号");
  assert.equal(readFileSync(ledger, "utf-8"), ledgerBefore, "台账不重复记账");
});

test("场景:导入不触发作业——无 job-run/trigger-decision,信号静止待消费", () => {
  const home = scratchHome("import-nojob");
  const src = join(home, "session-c.jsonl");
  writeTranscript(src);
  importHistory({ homeDir: home, paths: [src], now: () => FIXED_TS });
  const records = readArchiveRecords(home).filter(
    (e) => e.kind === JOB_RUN_KIND || e.kind === TRIGGER_DECISION_KIND,
  );
  assert.deepEqual(records, [], "导入本身零作业副作用");
});

test("场景:不可解析源失败收口——非零退出、零写入;整批任一失败全批零写入", async () => {
  const home = scratchHome("import-unparseable");
  const bad = join(home, "notes.txt");
  writeFileSync(bad, "plain text, not a transcript\n");

  assert.throws(
    () => importHistory({ homeDir: home, paths: [bad], now: () => FIXED_TS }),
    ImportSourceError,
  );
  assert.equal(existsSync(join(home, ".trellis", "evolve", "signals")), false, "零写入:信号目录都不产生");

  // 整批先校验后写入:好源 + 坏源同批 → 全批零写入。
  const good = join(home, "session-d.jsonl");
  writeTranscript(good);
  assert.throws(() => importHistory({ homeDir: home, paths: [good, bad] }), ImportSourceError);
  assert.equal(existsSync(signalFilePath(home, FIXED_TS)), false);
  assert.equal(existsSync(importLedgerPath(home, digestOf(readFileSync(good, "utf-8")))), false);

  // CLI 同语义:非零退出并说明原因(输出经 capture 收口)。
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  let exitCode: number;
  try {
    ({ exitCode } = await runEvolveCommand(["import", bad], { homeDir: home, isTTY: false }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(exitCode, 1);
  assert.match(lines.join("\n"), /无法导入|不匹配任何已注册适配器/);
  assert.match(lines.join("\n"), /零写入/);
});

test("场景:重复消费不产生重复提案——导入信号进发现面,提案 id 确定性", async () => {
  const home = scratchHome("import-consume");
  seedAgentPresence(home, ["claude-code", "codex"]);
  seedCanonical(home, {
    managed: ["claude-code", "codex"],
    instructions: "# instructions\n",
    serversYaml: "servers: {}\n",
  });
  const workspace = mkdtempSync(join(tmpdir(), "trellis-import-ws-"));
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  const brokenToml = join(workspace, ".codex", "config.toml");
  writeFileSync(brokenToml, "x = [unclosed\n");
  writeEvolveLevelPolicy(home, { defaultLevel: "propose", agents: {}, workspaces: {} });

  // 导入(层归属指到故障 workspace):信号把该 workspace 带进发现面。
  const src = join(home, "session-e.jsonl");
  writeTranscript(src);
  const imported = importHistory({
    homeDir: home,
    paths: [src],
    workspaceRoot: workspace,
    now: () => FIXED_TS,
  });
  assert.equal(imported.written, 1);
  const signal = readSignals(imported.signalFile!)[0]!;
  assert.deepEqual(signal.layer, { kind: "workspace", root: workspace });

  // 第一次消费:导入信号 → 扫描 workspace → 故障成提案。
  const run1 = await runEvolveJob(home, { now: () => FIXED_TS + 1, applyAgents: [] });
  assert.equal(run1.enqueuedIds.length, 1, `skipped=${JSON.stringify(run1.skippedNotes)}`);
  const firstPending = readPendingRecords(home);
  assert.equal(firstPending.length, 1);
  assert.equal(firstPending[0]!.proposal.target, brokenToml);

  // 再次运行(重复消费):同一发现 → 同一提案 id,不重复进 pending。
  const run2 = await runEvolveJob(home, { now: () => FIXED_TS + 2000, applyAgents: [] });
  assert.equal(run2.enqueuedIds.length + run2.autoAdoptedIds.length, 0);
  const secondPending = readPendingRecords(home);
  assert.equal(secondPending.length, 1, "不重复进 pending");
  assert.equal(secondPending[0]!.id, firstPending[0]!.id, "提案 id 确定性");
});

test("CLI:import 分发——显式路径导入成功(--workspace 层归属),缺路径非零", async () => {
  const home = scratchHome("import-cli");
  const workspace = mkdtempSync(join(tmpdir(), "trellis-import-cli-ws-"));
  const src = join(home, "session-f.jsonl");
  writeTranscript(src);

  const ok = await runEvolveCommand(["import", src, "--workspace", workspace], { homeDir: home, isTTY: false });
  assert.equal(ok.exitCode, 0);
  assert.equal(existsSync(importLedgerPath(home, digestOf(readFileSync(src, "utf-8")))), true, "台账已记账");

  const missing = await runEvolveCommand(["import"], { homeDir: home, isTTY: false });
  assert.equal(missing.exitCode, 1);
});
