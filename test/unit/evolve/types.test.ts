/**
 * 进化核心类型的序列化 fixture 测试(trellis-evolve 任务 10.1)。
 *
 * 证明 `layer` 字段贯穿所有落盘类型(Signal 信封、Proposal、Verdict、
 * Lesson),在 JSON 完整往返后逐字段保留(含具体 workspace root)。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EvidenceLink,
  Lesson,
  Proposal,
  Signal,
  Verdict,
} from "../../../src/evolve/types.js";
import { LEVELS } from "../../../src/evolve/types.js";

const GLOBAL_LAYER = { kind: "global" } as const;
const WORKSPACE_LAYER = { kind: "workspace", root: "/tmp/ws-alpha" } as const;

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 全类型 fixture:global 与 workspace 两层各覆盖一份。 */
function fixtures(): {
  signals: Signal[];
  proposals: Proposal[];
  verdicts: Verdict[];
  lessons: Lesson[];
} {
  const evidence: EvidenceLink[] = [
    { kind: "run", runId: "run-1" },
    { kind: "doctor-finding", findingId: "finding-1" },
    { kind: "user-correction", signalId: "signal-1" },
  ];

  const signals: Signal[] = [
    // workspace 层 tool-call:覆盖 result 类别与完整白名单字段。
    {
      kind: "tool-call",
      source: "gateway-event",
      stableId: "gw-evt-1",
      collectedAt: 1_000,
      layer: WORKSPACE_LAYER,
      ts: 900,
      agent: "claude",
      session: "sess-1",
      provider: "filesystem",
      tool: "read_file",
      durationMs: 12,
      result: "ok",
    },
    // global 层 tool-call:error 结果 + 来源无稳定标识。
    {
      kind: "tool-call",
      source: "agent-bridge",
      stableId: null,
      collectedAt: 1_100,
      layer: GLOBAL_LAYER,
      ts: 1_050,
      agent: "codex",
      session: "sess-2",
      provider: "shell",
      tool: "exec",
      durationMs: 340,
      result: "error",
    },
    // timeout 结果类别补全白名单。
    {
      kind: "tool-call",
      source: "gateway-event",
      stableId: "gw-evt-3",
      collectedAt: 1_200,
      layer: WORKSPACE_LAYER,
      ts: 1_150,
      agent: "claude",
      session: "sess-3",
      provider: "browser",
      tool: "navigate",
      durationMs: 30_000,
      result: "timeout",
    },
    {
      kind: "session-start",
      source: "gateway-event",
      stableId: "gw-evt-4",
      collectedAt: 1_300,
      layer: GLOBAL_LAYER,
      ts: 1_250,
      agent: "claude",
      session: "sess-4",
    },
    {
      kind: "session-end",
      source: "gateway-event",
      stableId: "gw-evt-5",
      collectedAt: 1_400,
      layer: WORKSPACE_LAYER,
      ts: 1_350,
      agent: "codex",
      session: "sess-5",
    },
    // user-correction:text 已过 secrets 擦除。
    {
      kind: "user-correction",
      source: "agent-report",
      stableId: "report-6",
      collectedAt: 1_500,
      layer: WORKSPACE_LAYER,
      ts: 1_450,
      agent: "claude",
      session: "sess-6",
      text: "请改用 --json 输出",
    },
  ];

  const proposals: Proposal[] = [
    {
      id: "prop-1",
      createdAt: 2_000,
      kind: "mcp-server-timeout",
      target: "servers.yaml#browser",
      layer: GLOBAL_LAYER,
      evidence,
      riskClass: "A",
      summary: "browser MCP 超时阈值从 30s 调到 60s",
      edits: [
        {
          op: "write-file",
          path: "/home/u/.trellis/mcp/servers.yaml",
          content: "browser:\n  timeout: 60000\n",
        },
        {
          op: "create-symlink",
          path: "/home/u/.trellis/mcp/active.yaml",
          target: "/home/u/.trellis/mcp/servers.yaml",
        },
        { op: "repair-symlink", path: "/home/u/.trellis/mcp/legacy.yaml", target: "servers.yaml" },
        { op: "remove-symlink", path: "/home/u/.trellis/mcp/broken.yaml" },
      ],
    },
    {
      id: "prop-2",
      createdAt: 2_100,
      kind: "skill-reorder",
      target: "skills/e2e-test",
      layer: WORKSPACE_LAYER,
      evidence: [{ kind: "run", runId: "run-2" }],
      riskClass: "B",
      summary: "单 workspace 证据,升格全局一律 B",
      edits: [],
    },
    {
      id: "prop-3",
      createdAt: 2_200,
      kind: "skill-delete",
      target: "skills/obsolete",
      layer: GLOBAL_LAYER,
      evidence: [{ kind: "doctor-finding", findingId: "finding-2" }],
      riskClass: "C",
      summary: "C 类:校验阶段硬排除",
      edits: [],
    },
  ];

  const verdicts: Verdict[] = [
    {
      status: "ok",
      layer: WORKSPACE_LAYER,
      baseline: [
        {
          id: "check:missing-skill",
          source: "doctor",
          kind: "missing-skill",
          layer: WORKSPACE_LAYER,
          message: "e2e-test skill 未安装",
        },
        {
          id: "check:mcp-unauthorized",
          source: "sync",
          kind: "mcp-unauthorized",
          layer: GLOBAL_LAYER,
          message: "browser MCP 未授权",
        },
      ],
      candidate: [
        {
          id: "check:mcp-unauthorized",
          source: "sync",
          kind: "mcp-unauthorized",
          layer: GLOBAL_LAYER,
          message: "browser MCP 未授权",
        },
        {
          id: "check:new-drift",
          source: "secrets",
          kind: "secret-drift",
          layer: WORKSPACE_LAYER,
          message: "新出现的漂移",
        },
      ],
    },
    // 测量失败记 unknown,不得表示为零分或通过。
    {
      status: "unknown",
      layer: GLOBAL_LAYER,
      baseline: [],
      candidate: [],
    },
  ];

  const lessons: Lesson[] = [
    {
      id: "lesson-1",
      createdAt: 3_000,
      cue: "browser MCP 超时",
      body: "先升超时阈值,再查进程存活",
      evidence,
      confidence: 0.8,
      layer: WORKSPACE_LAYER,
    },
    {
      id: "lesson-2",
      createdAt: 3_100,
      cue: "skill 安装失败",
      body: "检查 SKILL.md 大小写",
      evidence: [{ kind: "run", runId: "run-3" }],
      layer: GLOBAL_LAYER,
    },
  ];

  return { signals, proposals, verdicts, lessons };
}

test("LEVELS 四级有序且派生 Level 单一事实源", () => {
  assert.deepEqual([...LEVELS], ["off", "observe", "propose", "auto-A"]);
});

test("Signal 完整 JSON 往返保留全部字段与层归属", () => {
  const { signals } = fixtures();
  for (const signal of signals) {
    assert.deepEqual(roundTrip(signal), signal);
    // 层归属显式断言:含具体 workspace root,逐字段保留。
    const layer = roundTrip(signal).layer;
    if (signal.layer.kind === "workspace") {
      assert.deepEqual(layer, { kind: "workspace", root: "/tmp/ws-alpha" });
    } else {
      assert.deepEqual(layer, { kind: "global" });
    }
  }
});

test("Proposal 完整 JSON 往返保留层归属与证据/编辑形状", () => {
  const { proposals } = fixtures();
  for (const proposal of proposals) {
    assert.deepEqual(roundTrip(proposal), proposal);
    if (proposal.layer.kind === "workspace") {
      assert.deepEqual(roundTrip(proposal).layer, {
        kind: "workspace",
        root: "/tmp/ws-alpha",
      });
    } else {
      assert.deepEqual(roundTrip(proposal).layer, { kind: "global" });
    }
  }
  // 编辑四形态与风险三类在往返后仍在。
  const restored = roundTrip(proposals[0]);
  assert.deepEqual(
    restored.edits.map((e) => e.op),
    ["write-file", "create-symlink", "repair-symlink", "remove-symlink"],
  );
  assert.deepEqual(
    proposals.map((p) => p.riskClass),
    ["A", "B", "C"],
  );
});

test("Verdict 完整 JSON 往返保留层归属与条目内嵌层", () => {
  const { verdicts } = fixtures();
  for (const verdict of verdicts) {
    assert.deepEqual(roundTrip(verdict), verdict);
    if (verdict.layer.kind === "workspace") {
      assert.deepEqual(roundTrip(verdict).layer, {
        kind: "workspace",
        root: "/tmp/ws-alpha",
      });
    } else {
      assert.deepEqual(roundTrip(verdict).layer, { kind: "global" });
    }
    // baseline/candidate 条目自带 layer,嵌套层也随行保留。
    for (const entry of [...verdict.baseline, ...verdict.candidate]) {
      const restoredEntry = roundTrip(entry);
      if (entry.layer.kind === "workspace") {
        assert.deepEqual(restoredEntry.layer, {
          kind: "workspace",
          root: "/tmp/ws-alpha",
        });
      } else {
        assert.deepEqual(restoredEntry.layer, { kind: "global" });
      }
    }
  }
});

test("Lesson 完整 JSON 往返保留层归属与可选 confidence", () => {
  const { lessons } = fixtures();
  for (const lesson of lessons) {
    assert.deepEqual(roundTrip(lesson), lesson);
    if (lesson.layer.kind === "workspace") {
      assert.deepEqual(roundTrip(lesson).layer, {
        kind: "workspace",
        root: "/tmp/ws-alpha",
      });
    } else {
      assert.deepEqual(roundTrip(lesson).layer, { kind: "global" });
    }
  }
  // 一有一无:可选字段缺席时往返后仍缺席。
  assert.equal(roundTrip(lessons[0]).confidence, 0.8);
  assert.equal("confidence" in roundTrip(lessons[1]), false);
});
