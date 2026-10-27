/**
 * 13.1 L2 匿名前后对比记录协议(类型与档案写入器)。
 *
 * 场景映射(spec"匿名前后对比记录协议(L2)"):
 *   - "比较记录可序列化往返":含匿名臂映射与失败收口 verdict 的比较
 *     记录写入档案再读出,全部字段保留,匿名标识不泄露哪一臂是候选。
 * 另覆盖两种收口表达(选中 baseline ⟹ 不采纳;选择器失败 ⟹ invalid)
 * 与选择器视图的匿名面。选择器执行不在本期范围(13.3 起)。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";
import {
  L2_COMPARISON_ARCHIVE_KIND,
  anonArmId,
  appendL2Comparison,
  buildL2Comparison,
  presentL2Arms,
  readL2Comparisons,
} from "../../../src/evolve/l2.js";
import { readArchiveRecords } from "../../../src/evolve/archive.js";
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

/** 角色泄露词:匿名标识与选择器视图都不得出现这些指向性标记。 */
const ROLE_LEAK = /base|cand|control|treatment|winner|loser|new|old|prod/i;

const taskSeeds = [
  { task: "probe-skill-edit", seed: "s-42" },
  { task: "probe-mcp-route", seed: "s-7" },
];

describe("13.1 L2 比较记录序列化往返", () => {
  it("场景:含匿名臂映射与失败收口 verdict 的记录往返后全部字段保留,匿名标识不泄露角色", () => {
    const h = home("trellis-l2-roundtrip-");
    const record = buildL2Comparison({
      comparisonId: "cmp-1",
      createdAt: 1_700_000_000_000,
      taskSeeds,
      arms: [
        {
          runId: "run-base-11",
          role: "baseline",
          artifacts: [{ label: "surface.json", digest: "sha256:aaa111" }],
        },
        {
          runId: "run-cand-22",
          role: "candidate",
          artifacts: [{ label: "surface.json", digest: "sha256:bbb222" }],
        },
      ],
      // 选择器选中了 baseline 那一臂(通过它的匿名标识):收口"不采纳"。
      selector: { status: "selected", anonId: anonArmId(taskSeeds, "run-base-11") },
    });

    appendL2Comparison(h, record);
    const readBack = readL2Comparisons(h);
    assert.equal(readBack.length, 1);
    // 全部字段在往返后保留(JSON 档案,deepEqual 即字段级对照)。
    assert.deepEqual(readBack[0], record);

    // 档案 kind 正确落库。
    assert.ok(readArchiveRecords(h).some((e) => e.kind === L2_COMPARISON_ARCHIVE_KIND));

    // 匿名标识不泄露哪一臂是候选:值本身无角色词,且不与 runId 词面重合。
    for (const arm of readBack[0]!.arms) {
      assert.ok(!ROLE_LEAK.test(arm.anonId), `anonId ${arm.anonId} 含角色泄露词`);
      assert.ok(!arm.anonId.includes(arm.runId), "anonId 不得回显运行标识");
    }
    // base 保留在比较中(spec:base SHALL 保留在比较中)。
    assert.equal(readBack[0]!.arms.length, 2);
    assert.ok(readBack[0]!.arms.some((a) => a.role === "baseline"));
    assert.ok(readBack[0]!.arms.some((a) => a.role === "candidate"));
  });

  it("收口表达:选中 baseline ⟹ 不采纳;选择器失败 ⟹ invalid", () => {
    const baseAnon = anonArmId(taskSeeds, "run-base-11");
    const candAnon = anonArmId(taskSeeds, "run-cand-22");

    const notAdopted = buildL2Comparison({
      comparisonId: "cmp-b",
      createdAt: 1,
      taskSeeds,
      arms: [
        { runId: "run-base-11", role: "baseline", artifacts: [{ label: "a", digest: "d1" }] },
        { runId: "run-cand-22", role: "candidate", artifacts: [{ label: "a", digest: "d2" }] },
      ],
      selector: { status: "selected", anonId: baseAnon },
    });
    assert.deepEqual(notAdopted.verdict, { kind: "not-adopted-baseline", anonId: baseAnon });

    const invalid = buildL2Comparison({
      comparisonId: "cmp-f",
      createdAt: 2,
      taskSeeds,
      arms: [
        { runId: "run-base-11", role: "baseline", artifacts: [{ label: "a", digest: "d1" }] },
        { runId: "run-cand-22", role: "candidate", artifacts: [{ label: "a", digest: "d2" }] },
      ],
      selector: { status: "failed", reason: "selector timeout" },
    });
    assert.deepEqual(invalid.verdict, { kind: "invalid", reason: "selector timeout" });

    // 选中候选是另一条收口:仅进入风险分级门(adopt-candidate)。
    const adopt = buildL2Comparison({
      comparisonId: "cmp-a",
      createdAt: 3,
      taskSeeds,
      arms: [
        { runId: "run-base-11", role: "baseline", artifacts: [{ label: "a", digest: "d1" }] },
        { runId: "run-cand-22", role: "candidate", artifacts: [{ label: "a", digest: "d2" }] },
      ],
      selector: { status: "selected", anonId: candAnon },
    });
    assert.deepEqual(adopt.verdict, { kind: "adopt-candidate", anonId: candAnon });

    // 任一臂未交付同样走 invalid 收口(design:不采纳)。
    const undelivered = buildL2Comparison({
      comparisonId: "cmp-u",
      createdAt: 4,
      taskSeeds,
      arms: [
        { runId: "run-base-11", role: "baseline", artifacts: [{ label: "a", digest: "d1" }] },
        { runId: "run-cand-22", role: "candidate", artifacts: [] },
      ],
      selector: { status: "selected", anonId: baseAnon },
    });
    assert.deepEqual(undelivered.verdict, { kind: "invalid", reason: "arm-undelivered" });
  });
});

describe("13.1 匿名面与选择器视图", () => {
  it("选择器视图只给匿名标识与冻结交付物引用(无 role/runId)", () => {
    const record = buildL2Comparison({
      comparisonId: "cmp-view",
      createdAt: 5,
      taskSeeds,
      arms: [
        { runId: "run-base-11", role: "baseline", artifacts: [{ label: "surface.json", digest: "sha256:aaa111" }] },
        { runId: "run-cand-22", role: "candidate", artifacts: [{ label: "surface.json", digest: "sha256:bbb222" }] },
      ],
      selector: { status: "failed", reason: "no show" },
    });
    const view = presentL2Arms(record);
    assert.equal(view.length, 2);
    for (const arm of view) {
      assert.deepEqual(Object.keys(arm).sort(), ["anonId", "artifacts"]);
      assert.ok(!ROLE_LEAK.test(arm.anonId));
    }
  });

  it("匿名标识按任务种子 + 运行标识稳定派生,臂间可区分", () => {
    const a = anonArmId(taskSeeds, "run-base-11");
    const b = anonArmId(taskSeeds, "run-base-11");
    const c = anonArmId(taskSeeds, "run-cand-22");
    assert.equal(a, b, "同种子同运行标识派生稳定");
    assert.notEqual(a, c);
    // 换种子集:同一运行标识的匿名标识也变(按任务设种子)。
    const other = anonArmId([{ task: "probe-skill-edit", seed: "s-43" }], "run-base-11");
    assert.notEqual(a, other);
    assert.ok(!ROLE_LEAK.test(a) && !ROLE_LEAK.test(other));
  });
});
