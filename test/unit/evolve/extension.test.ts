/**
 * 进化扩展 `activate` 包装(trellis-evolve 8.1/11.1/11.5 生产接线)。
 *
 * 覆盖:级别 → 订阅者组合(off 零订阅、observe 只挂 recorder、propose+
 * 加触发器)、workspace 粒度覆盖、与真实清单 loader 的结构契约兼容
 * (loadHostExtensions 装载本扩展并驱动事件)、清单写入幂等与移除语义。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";

import {
  activate,
  evolveExtensionLoadSpecifier,
  EVOLVE_EXTENSION_ID,
} from "../../../src/evolve/extension.js";
import { readAllSignals } from "../../../src/evolve/recorder.js";
import { readArchiveRecords } from "../../../src/evolve/archive.js";
import { jobLockPath, TRIGGER_DECISION_KIND } from "../../../src/evolve/trigger.js";
import {
  extensionsManifestPath,
  loadHostExtensions,
  removeExtensionEntry,
  upsertExtensionEntry,
} from "../../../src/lib/hostExtensions.js";
import {
  sessionEndEvent,
  sessionStartEvent,
  toolCallEvent,
} from "../../../src/host/hostEvents.js";
import { writeEvolveLevelPolicy } from "../../../src/host/index.js";
import { scratchHome } from "../../helpers/home.js";

const TS = 1_000;

test("默认 off:activate 零订阅者(结构上零副作用)", () => {
  const home = scratchHome("ext-off");
  const activation = activate({ homeDir: home, agent: "codex", workspaceRoot: null });
  assert.deepEqual(activation, {});
});

test("observe:只挂 recorder——事件写入信号,会话事件不触发作业", () => {
  const home = scratchHome("ext-observe");
  writeEvolveLevelPolicy(home, { defaultLevel: "observe", agents: {}, workspaces: {} });

  const activation = activate({ homeDir: home, agent: "codex", workspaceRoot: null });
  assert.equal(activation.subscribers?.length, 1);
  const handle = activation.subscribers![0]!;

  handle(sessionStartEvent({ ts: TS, agent: "codex", session: "s1", workspaceRoot: null }));
  handle(
    toolCallEvent({
      ts: TS + 1,
      agent: "codex",
      session: "s1",
      provider: "trellis",
      tool: "skills_read",
      durationMs: 5,
      result: "ok",
    }),
  );
  handle(sessionEndEvent({ ts: TS + 2, agent: "codex", session: "s1" }));

  const signals = readAllSignals(home, null);
  assert.deepEqual(
    signals.map((s) => s.kind),
    ["session-start", "tool-call", "session-end"],
  );
  // observe 不挂触发器:无判定档案、无作业锁。
  assert.equal(readArchiveRecords(home).filter((e) => e.kind === TRIGGER_DECISION_KIND).length, 0);
  assert.equal(existsSync(jobLockPath(home)), false);
});

test("propose:recorder + 触发器;会话启动补偿判定入档(未达阈值 skip,不拉起)", () => {
  const home = scratchHome("ext-propose");
  writeEvolveLevelPolicy(home, { defaultLevel: "propose", agents: {}, workspaces: {} });

  const activation = activate({ homeDir: home, agent: "codex", workspaceRoot: null });
  assert.equal(activation.subscribers?.length, 2);
  const [record, trigger] = activation.subscribers!;

  record!(sessionStartEvent({ ts: TS, agent: "codex", session: "s2", workspaceRoot: null }));
  // 无累计信号 → 补偿判定 skip/below-threshold;不 spawn(job.lock 不存在)。
  trigger!(sessionStartEvent({ ts: TS, agent: "codex", session: "s2", workspaceRoot: null }));

  const decisions = readArchiveRecords(home).filter((e) => e.kind === TRIGGER_DECISION_KIND);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0]!.payload, {
    decision: "skip",
    reason: "below-threshold",
    note: "累计信号 1 未达阈值 10",
    trigger: "event",
  });
  assert.equal(existsSync(jobLockPath(home)), false);
});

test("workspace 覆盖 off:该 workspace 会话零订阅(更具体覆盖更宽泛)", () => {
  const home = scratchHome("ext-ws-off");
  writeEvolveLevelPolicy(home, {
    defaultLevel: "observe",
    agents: {},
    workspaces: { ["/tmp/some-ws"]: "off" },
  });
  const activation = activate({ homeDir: home, agent: "codex", workspaceRoot: "/tmp/some-ws" });
  assert.deepEqual(activation, {});
});

test("清单装载集成:loadHostExtensions 装载本扩展(结构契约兼容)", async () => {
  const home = scratchHome("ext-manifest");
  writeEvolveLevelPolicy(home, { defaultLevel: "observe", agents: {}, workspaces: {} });
  upsertExtensionEntry(home, { id: EVOLVE_EXTENSION_ID, load: evolveExtensionLoadSpecifier() });

  const warnings: string[] = [];
  const loaded = await loadHostExtensions(
    { homeDir: home, agent: "codex", workspaceRoot: null },
    (message) => warnings.push(message),
  );
  assert.deepEqual(loaded.failures, []);
  assert.deepEqual(warnings, []);
  assert.equal(loaded.subscribers.length, 1);
  assert.equal(loaded.providers.length, 0);

  loaded.subscribers[0]!(
    toolCallEvent({
      ts: TS,
      agent: "codex",
      session: "s3",
      provider: "trellis",
      tool: "skills_read",
      durationMs: 1,
      result: "ok",
    }),
  );
  // 异步落盘契约:热路径(工具调用)setImmediate 合并落盘,turn 结束后可见。
  await new Promise((resolve) => setImmediate(resolve));
  const signals = readAllSignals(home, null);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "tool-call");
});

test("清单写入幂等、移除不伤他条目", () => {
  const home = scratchHome("ext-manifest-crud");
  upsertExtensionEntry(home, { id: EVOLVE_EXTENSION_ID, load: evolveExtensionLoadSpecifier() });
  upsertExtensionEntry(home, { id: EVOLVE_EXTENSION_ID, load: evolveExtensionLoadSpecifier() });
  upsertExtensionEntry(home, { id: "other", load: "/tmp/other.js" });

  const manifestPath = extensionsManifestPath(home);
  const text = readFileSync(manifestPath, "utf-8");
  assert.equal((text.match(/id:/g) ?? []).length, 2, "upsert 不重复同 id 条目");
  assert.match(text, /id: other/);

  assert.equal(removeExtensionEntry(home, EVOLVE_EXTENSION_ID), true);
  assert.equal(removeExtensionEntry(home, EVOLVE_EXTENSION_ID), false, "二次移除是 no-op");
  const after = readFileSync(manifestPath, "utf-8");
  assert.match(after, /id: other/, "其他条目保留");
  assert.doesNotMatch(after, new RegExp(`id: ${EVOLVE_EXTENSION_ID}`));
});

test("坏 load 拒绝:upsert 空 id/load 抛错且不落盘", () => {
  const home = scratchHome("ext-manifest-bad");
  assert.throws(() => upsertExtensionEntry(home, { id: "", load: "/x.js" }), /\{id, load\}/);
  assert.throws(() => upsertExtensionEntry(home, { id: "x", load: "" }), /\{id, load\}/);
  assert.equal(existsSync(extensionsManifestPath(home)), false, "拒绝不落盘");
});

test("清单 extensions 键非数组:upsert 硬抛而不是静默重置掉他人条目", () => {
  const home = scratchHome("ext-manifest-nonarray");
  mkdirSync(dirname(extensionsManifestPath(home)), { recursive: true });
  writeFileSync(extensionsManifestPath(home), "extensions: {}\n", "utf-8");
  assert.throws(() => upsertExtensionEntry(home, { id: "x", load: "/x.js" }), /must be a list/);
  assert.match(readFileSync(extensionsManifestPath(home), "utf-8"), /extensions: \{\}/, "原文件未被改写");
});
