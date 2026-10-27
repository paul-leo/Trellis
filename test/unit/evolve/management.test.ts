/**
 * 12.4 管理面命令 `trellis evolve <sub>`。
 *
 * 场景映射(spec):
 *   - "非交互环境拒绝批准" → 非 TTY approve 被拒,提案保持 pending
 *     (含 `--yes` 类确认参数被无视的回归);
 *   - "命令不触发循环" → status/enable 后信号目录与档案零新增;
 *   - "批准即应用与显式应用入口"(trellis-evolve-review-fixes)→ 批准即应用 /
 *     应用失败保持 approved 可重试 / 显式应用幂等零副作用 / 作业运行中暂缓。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runEvolveCommand } from "../../../src/commands/evolve.js";
import { APPLY_ARCHIVE_KIND } from "../../../src/evolve/apply.js";
import { readArchiveRecords } from "../../../src/evolve/archive.js";
import {
  enqueueProposal,
  readPendingRecord,
  readPendingRecords,
  readProposalsByStatus,
} from "../../../src/evolve/pending.js";
import { evolveStateDir } from "../../../src/evolve/stateDir.js";
import { acquireJobLock, releaseJobLock } from "../../../src/evolve/trigger.js";
import { loadEvolveLevelPolicy, writeEvolveLevelPolicy } from "../../../src/host/index.js";
import { extensionsManifestPath } from "../../../src/lib/hostExtensions.js";
import type { Proposal } from "../../../src/evolve/types.js";
import { scratchHome } from "../../helpers/home.js";

/** 捕获运行期间的 console.log/console.error 文本。 */
async function captureOutput(run: () => Promise<{ exitCode: number }>): Promise<{ exitCode: number; text: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const { exitCode } = await run();
    return { exitCode, text: lines.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

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

/** 合法 workspace 层提案(真实 scratch 目录;批准即应用会真实写入)。
 * 返回编辑目标路径,供断言写入/暂缓时的文件状态。 */
function enqueue(h: string, id: string): string {
  const ws = join(h, "ws");
  const path = join(ws, ".agents", `${id}.md`);
  mkdirSync(join(ws, ".agents"), { recursive: true });
  const proposal: Proposal = {
    id,
    createdAt: 1_700_000_000_000,
    kind: "workspace-config-fix",
    target: path,
    layer: { kind: "workspace", root: ws },
    evidence: [{ kind: "doctor-finding", findingId: `doctor:workspace-toml-invalid:${id}` }],
    riskClass: "B",
    summary: "fix toml",
    edits: [{ op: "write-file", path, content: "# fixed = true\n" }],
  };
  enqueueProposal({ homeDir: h, proposal, riskClass: "B", riskRuleId: "workspace-config-fix/any" });
  return path;
}

/** 任意编辑组合的入队捷径(应用失败/幂等重放测试用;target 用编辑首路径)。 */
function enqueueEdits(h: string, id: string, ws: string, edits: Proposal["edits"]): void {
  mkdirSync(join(ws, ".agents"), { recursive: true });
  const proposal: Proposal = {
    id,
    createdAt: 1_700_000_000_000,
    kind: "workspace-config-fix",
    target: edits[0]!.path,
    layer: { kind: "workspace", root: ws },
    evidence: [{ kind: "doctor-finding", findingId: `doctor:workspace-toml-invalid:${id}` }],
    riskClass: "B",
    summary: `fix ${id}`,
    edits,
  };
  enqueueProposal({ homeDir: h, proposal, riskClass: "B", riskRuleId: "workspace-config-fix/any" });
}

function applyRunCount(h: string): number {
  return readArchiveRecords(h).filter((e) => e.kind === APPLY_ARCHIVE_KIND).length;
}

function signalsInventory(h: string): string[] {
  const dir = join(evolveStateDir(h), "signals");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function archiveLineCount(h: string): number {
  return readArchiveRecords(h).length;
}

describe("12.4 管理面命令", () => {
  it("status 只读零副作用:不写信号、不写档案、不建新目录", async () => {
    const h = home("trellis-evolve-status-");
    enqueue(h, "p-stat");
    const signalsBefore = signalsInventory(h);
    const archiveBefore = archiveLineCount(h);
    const entriesBefore = readdirSync(evolveStateDir(h)).sort();

    const { exitCode } = await runEvolveCommand(["status"], { homeDir: h, isTTY: true });
    assert.equal(exitCode, 0);
    assert.deepEqual(signalsInventory(h), signalsBefore);
    assert.equal(archiveLineCount(h), archiveBefore);
    assert.deepEqual(readdirSync(evolveStateDir(h)).sort(), entriesBefore);
  });

  it("pending 列出待批(管理面含编辑路径);无 pending 时明确空", async () => {
    const h = home("trellis-evolve-pending-cmd-");
    enqueue(h, "p-list");
    const listed = await captureOutput(() => runEvolveCommand(["pending"], { homeDir: h, isTTY: true }));
    assert.equal(listed.exitCode, 0);
    // 摘要/风险级别/编辑路径都要在输出里(spec"管理面呈现")。
    assert.match(listed.text, /p-list/);
    assert.match(listed.text, /risk=B/);
    assert.match(listed.text, /edit: write-file/);
    const empty = await runEvolveCommand(["pending"], { homeDir: home("trellis-evolve-pending-empty-"), isTTY: true });
    assert.equal(empty.exitCode, 0);
  });

  it("场景:非交互环境拒绝批准,提案保持 pending;--yes 不构成批准", async () => {
    const h = home("trellis-evolve-reject-tty-");
    enqueue(h, "p-tty");

    const denied = await runEvolveCommand(["approve", "p-tty"], { homeDir: h, isTTY: false });
    assert.equal(denied.exitCode, 1);
    assert.equal(readPendingRecord(h, "p-tty")?.status, "pending");

    // agent 传入的"确认"参数不构成批准。
    const deniedYes = await runEvolveCommand(["approve", "p-tty", "--yes", "--confirm", "-y"], { homeDir: h, isTTY: false });
    assert.equal(deniedYes.exitCode, 1);
    assert.equal(readPendingRecord(h, "p-tty")?.status, "pending");

    // 非交互 reject 同样拒。
    const deniedReject = await runEvolveCommand(["reject", "p-tty"], { homeDir: h, isTTY: false });
    assert.equal(deniedReject.exitCode, 1);
    assert.equal(readPendingRecord(h, "p-tty")?.status, "pending");
  });

  it("交互式批准/拒绝:状态迁移 + 档案;重复决策与未知 id 失败", async () => {
    const h = home("trellis-evolve-approve-");
    enqueue(h, "p-ok");
    enqueue(h, "p-no");

    const approved = await runEvolveCommand(["approve", "p-ok"], { homeDir: h, isTTY: true });
    assert.equal(approved.exitCode, 0);
    assert.equal(readPendingRecord(h, "p-ok")?.status, "approved");
    assert.ok(readArchiveRecords(h).some((e) => e.kind === "proposal-decision"));

    const again = await runEvolveCommand(["approve", "p-ok"], { homeDir: h, isTTY: true });
    assert.equal(again.exitCode, 1);
    assert.equal(readPendingRecord(h, "p-ok")?.status, "approved");

    const rejected = await runEvolveCommand(["reject", "p-no"], { homeDir: h, isTTY: true });
    assert.equal(rejected.exitCode, 0);
    assert.equal(readPendingRecord(h, "p-no")?.status, "rejected");
    assert.equal(readProposalsByStatus(h, "pending").length, 0);

    const missing = await runEvolveCommand(["approve", "ghost"], { homeDir: h, isTTY: true });
    assert.equal(missing.exitCode, 1);
  });

  it("enable/disable 写 canonical 级别策略并保留粒度覆盖", async () => {
    const h = home("trellis-evolve-levels-");
    const enabled = await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
    assert.equal(enabled.exitCode, 0);
    assert.equal(loadEvolveLevelPolicy(h).defaultLevel, "observe");

    const promoted = await runEvolveCommand(["enable", "--level", "propose"], { homeDir: h, isTTY: true });
    assert.equal(promoted.exitCode, 0);
    const policyPath = join(h, ".trellis", "evolve.yaml");
    assert.match(readFileSync(policyPath, "utf-8"), /default_level: propose/);

    const badLevel = await runEvolveCommand(["enable", "--level", "yolo"], { homeDir: h, isTTY: true });
    assert.equal(badLevel.exitCode, 1);

    const disabled = await runEvolveCommand(["disable"], { homeDir: h, isTTY: true });
    assert.equal(disabled.exitCode, 0);
    assert.equal(loadEvolveLevelPolicy(h).defaultLevel, "off");
  });

  it("命令不触发循环:enable/status 后信号目录与档案零新增", async () => {
    const h = home("trellis-evolve-noloop-");
    const signalsBefore = signalsInventory(h);
    const archiveBefore = archiveLineCount(h);
    await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
    await runEvolveCommand(["status"], { homeDir: h, isTTY: true });
    await runEvolveCommand(["disable"], { homeDir: h, isTTY: true });
    assert.deepEqual(signalsInventory(h), signalsBefore);
    assert.equal(archiveLineCount(h), archiveBefore, "管理面命令不产提案/触发判定等档案");
  });

  it("未知子命令失败并给出用法;help 成功", async () => {
    const h = home("trellis-evolve-usage-");
    const unknown = await runEvolveCommand(["frobnicate"], { homeDir: h, isTTY: true });
    assert.equal(unknown.exitCode, 1);
    const help = await runEvolveCommand(["help"], { homeDir: h, isTTY: true });
    assert.equal(help.exitCode, 0);
  });

  it("自治升级门:非交互 enable --level propose/auto-A 被拒;observe 不设门", async () => {
    const h = home("trellis-evolve-gate-");
    const denied = await runEvolveCommand(["enable", "--level", "propose"], { homeDir: h, isTTY: false });
    assert.equal(denied.exitCode, 1);
    assert.equal(existsSync(join(h, ".trellis", "evolve.yaml")), false, "被拒时不写策略");
    const deniedAuto = await runEvolveCommand(["enable", "--level", "auto-A"], { homeDir: h, isTTY: false });
    assert.equal(deniedAuto.exitCode, 1);
    const okObserve = await runEvolveCommand(["enable", "--level", "observe"], { homeDir: h, isTTY: false });
    assert.equal(okObserve.exitCode, 0, "observe 只采集信号,不设门");
  });

  it("disable 拒绝 --level;存在非 off 覆盖时保留清单条目并明确提示", async () => {
    const h = home("trellis-evolve-disable-");
    await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
    const bad = await runEvolveCommand(["disable", "--level", "propose"], { homeDir: h, isTTY: true });
    assert.equal(bad.exitCode, 1);
    assert.equal(loadEvolveLevelPolicy(h).defaultLevel, "observe", "被拒的 disable 不改策略");

    writeEvolveLevelPolicy(h, { defaultLevel: "observe", agents: {}, workspaces: { "/tmp/ws-x": "observe" } });
    const result = await captureOutput(() => runEvolveCommand(["disable"], { homeDir: h, isTTY: true }));
    assert.equal(result.exitCode, 0);
    assert.equal(loadEvolveLevelPolicy(h).defaultLevel, "off");
    assert.equal(loadEvolveLevelPolicy(h).workspaces["/tmp/ws-x"], "observe", "粒度覆盖保留");
    assert.match(result.text, /仍存在非 off 覆盖/);
    assert.match(readFileSync(extensionsManifestPath(h), "utf-8"), /id: evolve/, "清单条目按 any-of 规则保留");
  });

  it("enable 建状态目录骨架;dotfiles 仓库场景把 evolve/ 加入 .gitignore", async () => {
    const h = home("trellis-evolve-gitignore-");
    mkdirSync(join(h, ".git")); // 伪装 git work tree(~/.trellis 收进 dotfiles 的场景)
    const result = await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(join(evolveStateDir(h), "signals")), true, "状态目录骨架已建");
    assert.match(readFileSync(join(h, ".trellis", ".gitignore"), "utf-8"), /evolve\//);

    // 幂等:重复 enable 不产生重复 .gitignore 条目。
    await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
    const ignore = readFileSync(join(h, ".trellis", ".gitignore"), "utf-8");
    assert.equal(ignore.match(/evolve\//g)!.length, 1);
  });

  it("status/report --json:合法 JSON、与人类可读同源、零副作用、非 TTY 可用", async () => {
    const h = home("trellis-evolve-report-json-");
    enqueue(h, "p-json-1");
    enqueue(h, "p-json-2");
    await runEvolveCommand(["approve", "p-json-1"], { homeDir: h, isTTY: true });
    const before = archiveLineCount(h);
    const inventoryBefore = readdirSync(evolveStateDir(h)).sort();

    // 非 TTY 可用(只读出口不设 TTY 门)。
    const statusJson = await captureOutput(() => runEvolveCommand(["status", "--json"], { homeDir: h, isTTY: false }));
    assert.equal(statusJson.exitCode, 0);
    const parsed = JSON.parse(statusJson.text) as { counts: Record<string, number>; levels: Record<string, unknown>; notices: string[] };
    assert.equal(parsed.counts.pending, 1);
    assert.equal(parsed.counts.approved, 1);
    assert.equal(parsed.counts.rejected, 0);

    // 人类可读与 JSON 同源:数值一致。
    const statusText = await captureOutput(() => runEvolveCommand(["status"], { homeDir: h, isTTY: true }));
    assert.match(statusText.text, /proposals: 1 pending, 1 approved, 0 rejected/);

    const reportJson = await captureOutput(() => runEvolveCommand(["report", "--json"], { homeDir: h, isTTY: false }));
    assert.equal(reportJson.exitCode, 0);
    const report = JSON.parse(reportJson.text) as { timeline: unknown[]; trends: { id: string; source: string }[]; state: string };
    assert.equal(report.timeline.length, 2);
    assert.ok(report.trends.every((t) => t.source.length > 0));

    // 零副作用(spec 场景:查看前后逐字节不变)。
    assert.equal(archiveLineCount(h), before);
    assert.deepEqual(readdirSync(evolveStateDir(h)).sort(), inventoryBefore);
  });

  it("report 文本渲染:时间线含测量/无测量记录,回滚入口可见", async () => {
    const h = home("trellis-evolve-report-text-");
    enqueue(h, "p-text");
    const text = await captureOutput(() => runEvolveCommand(["report"], { homeDir: h, isTTY: false }));
    assert.equal(text.exitCode, 0);
    assert.match(text.text, /p-text/);
    assert.match(text.text, /无测量记录/);
    assert.match(text.text, /趋势/);
  });

  it("场景:批准即应用——决策后同一命令内经备份会话写入,输出真实回滚命令与生效时点", async () => {
    const h = home("trellis-evolve-approve-apply-");
    const path = enqueue(h, "p-aa");
    let syncCalls = 0;
    const out = await captureOutput(() =>
      runEvolveCommand(["approve", "p-aa"], {
        homeDir: h,
        isTTY: true,
        applyAgents: [{ agent: "claude-code", observation: "doctor-only" }],
        triggerSync: async () => {
          syncCalls += 1;
          return { exitCode: 0 };
        },
      }),
    );
    assert.equal(out.exitCode, 0);
    assert.equal(readPendingRecord(h, "p-aa")?.status, "approved");
    assert.equal(readFileSync(path, "utf-8"), "# fixed = true\n", "编辑在同一命令内写入,不滞留待应用");

    const run = readArchiveRecords(h).find((e) => e.kind === APPLY_ARCHIVE_KIND);
    assert.ok(run !== undefined, "apply-run 档案记录备份会话");
    const runId = (run!.payload as { runId: string }).runId;
    assert.match(out.text, /已应用 1 条提案:p-aa/);
    assert.match(out.text, new RegExp(`备份会话 ${runId}。回滚:trellis evolve rollback ${runId}`));
    assert.equal(syncCalls, 1);
    assert.match(out.text, /生效时点 claude-code\(doctor-only\):已触发渲染同步\(exit 0\)/);
  });

  it("场景:应用失败保持已批准——输出真实回滚,显式 apply 重试按编辑幂等重放", async () => {
    const h = home("trellis-evolve-apply-retry-");
    const ws = join(h, "ws");
    const blocker = join(ws, ".agents", "blocker.md");
    mkdirSync(join(ws, ".agents"), { recursive: true });
    writeFileSync(join(ws, "target-a"), "");
    writeFileSync(join(ws, "target-b"), "");
    writeFileSync(blocker, "regular file\n");
    // repair-symlink 打在普通文件上 → 应用抛 HostEditError(部分失败形态)。
    enqueueEdits(h, "p-retry", ws, [{ op: "repair-symlink", path: blocker, target: join(ws, "target-b") }]);

    const failed = await captureOutput(() =>
      runEvolveCommand(["approve", "p-retry"], { homeDir: h, isTTY: true, applyAgents: [] }),
    );
    assert.equal(failed.exitCode, 1);
    assert.equal(readPendingRecord(h, "p-retry")?.status, "approved", "应用失败不回滚决策");
    assert.match(failed.text, /应用部分失败/);
    assert.match(failed.text, /trellis evolve rollback /);
    assert.match(failed.text, /提案保持 approved/);
    assert.equal(applyRunCount(h), 1, "部分失败也落 apply-run 档案(failed)");
    assert.equal(readFileSync(blocker, "utf-8"), "regular file\n", "阻塞编辑未写入");

    // 修好阻塞(普通文件换回 symlink)后显式重试:编辑幂等重放完成。
    rmSync(blocker);
    symlinkSync(join(ws, "target-a"), blocker);
    const retry = await captureOutput(() =>
      runEvolveCommand(["apply"], { homeDir: h, isTTY: true, applyAgents: [] }),
    );
    assert.equal(retry.exitCode, 0);
    assert.match(retry.text, /已应用 1 条提案:p-retry/);
    assert.equal(readlinkSync(blocker), join(ws, "target-b"));
  });

  it("场景:显式应用幂等——无事可做零副作用;已应用过的不重复写入", async () => {
    const h = home("trellis-evolve-apply-idem-");
    let syncCalls = 0;
    const triggerSync = async (): Promise<{ exitCode: number }> => {
      syncCalls += 1;
      return { exitCode: 0 };
    };

    // 无已批准提案:不开备份会话、不写档案、不触发同步(spec 零副作用)。
    const empty = await captureOutput(() =>
      runEvolveCommand(["apply"], { homeDir: h, isTTY: true, applyAgents: [], triggerSync }),
    );
    assert.equal(empty.exitCode, 0);
    assert.match(empty.text, /没有已批准未应用的提案/);
    assert.equal(applyRunCount(h), 0);
    assert.equal(archiveLineCount(h), 0);
    assert.equal(syncCalls, 0);

    // 批准即应用后,重复 apply:已应用过的不重复写入(幂等)。
    const path = enqueue(h, "p-once");
    await captureOutput(() => runEvolveCommand(["approve", "p-once"], { homeDir: h, isTTY: true, applyAgents: [], triggerSync }));
    assert.equal(readFileSync(path, "utf-8"), "# fixed = true\n");
    const again = await captureOutput(() =>
      runEvolveCommand(["apply"], { homeDir: h, isTTY: true, applyAgents: [], triggerSync }),
    );
    assert.equal(again.exitCode, 0);
    assert.match(again.text, /没有已批准未应用的提案\(已应用过的不重复写入\)/);
    assert.equal(applyRunCount(h), 1, "不为已应用提案开第二个备份会话");
  });

  it("场景:作业运行中暂缓应用——决策照常完成,暂缓如实告知,显式应用收尾", async () => {
    const h = home("trellis-evolve-apply-lock-");
    const path = enqueue(h, "p-lock");
    // 测试侧持活锁(本进程 pid 存活 → 作业锁视为被占用)。
    assert.equal(acquireJobLock(h, process.pid, Date.now()), true);

    const out = await captureOutput(() =>
      runEvolveCommand(["approve", "p-lock"], { homeDir: h, isTTY: true, applyAgents: [] }),
    );
    assert.equal(out.exitCode, 0);
    assert.equal(readPendingRecord(h, "p-lock")?.status, "approved", "决策照常完成");
    assert.match(out.text, /已有作业在运行:本次应用暂缓/);
    assert.equal(existsSync(path), false, "暂缓:编辑未写入");
    assert.equal(applyRunCount(h), 0, "暂缓:不开备份会话");

    // 作业结束后显式应用收尾。
    releaseJobLock(h, process.pid);
    const done = await captureOutput(() =>
      runEvolveCommand(["apply"], { homeDir: h, isTTY: true, applyAgents: [] }),
    );
    assert.equal(done.exitCode, 0);
    assert.match(done.text, /已应用 1 条提案:p-lock/);
    assert.equal(readFileSync(path, "utf-8"), "# fixed = true\n");
  });
});
