/**
 * 12.6 lesson 记录与上下文呈现。
 *
 * 场景映射(spec):
 *   - "记忆未启用时 lesson 留在档案":memoryStatus 报 skipped 而非
 *     failed,lesson 连同证据存在于档案;
 *   - "仓库 X 的 lesson 不原样进入 Y 的提案上下文":workspace 层
 *     lesson 按层作用域呈现,跨 workspace 只进升格佐证出口。
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  LESSON_ARCHIVE_KIND,
  lessonsAsCorroboration,
  lessonsForContext,
  readAllLessons,
  recordLesson,
} from "../../../src/evolve/lesson.js";
import { readArchiveRecords } from "../../../src/evolve/archive.js";
import type { Lesson } from "../../../src/evolve/types.js";
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

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: "l-1",
    createdAt: 1_700_000_000_000,
    cue: "workspace toml 报解析错误",
    body: "修复 toml 数组未闭合时,先查 workspace 层文件再看全局。",
    evidence: [{ kind: "doctor-finding", findingId: "doctor:workspace-toml-invalid:ws:path" }],
    confidence: 0.8,
    layer: { kind: "workspace", root: "/repo/x" },
    ...overrides,
  };
}

describe("12.6 lesson 记录", () => {
  it("场景:记忆未启用 → lesson 连同证据留在档案,报 skipped 而非 failed", () => {
    const h = home("trellis-lesson-skip-");
    const result = recordLesson({ homeDir: h, lesson: lesson(), memoryEnabled: false });
    assert.equal(result.memoryStatus, "skipped");
    assert.notEqual(result.memoryStatus, "failed");

    const lessons = readAllLessons(h);
    assert.equal(lessons.length, 1);
    assert.ok(readArchiveRecords(h).some((e) => e.kind === LESSON_ARCHIVE_KIND));
    const stored = lessons[0]!;
    assert.equal(stored.cue, "workspace toml 报解析错误");
    assert.equal(stored.evidence.length, 1);
    assert.equal(stored.evidence[0]!.kind, "doctor-finding");
    assert.equal(stored.confidence, 0.8);
    // 只留档案:不落记忆管道。
    assert.ok(!existsSync(join(h, ".trellis", "memories")));
  });

  it("记忆已启用 → 经记忆管道写入,档案同样保留", () => {
    const h = home("trellis-lesson-write-");
    const result = recordLesson({ homeDir: h, lesson: lesson({ id: "l-2" }), memoryEnabled: true });
    assert.equal(result.memoryStatus, "written");
    assert.ok(result.memoryPath !== undefined && existsSync(result.memoryPath));
    assert.equal(readAllLessons(h).length, 1);
    assert.equal(readdirSync(join(h, ".trellis", "memories")).length, 1);
  });

  it("管道写入失败报 failed 但运行不中断,档案仍在", () => {
    const h = home("trellis-lesson-fail-");
    const result = recordLesson({
      homeDir: h,
      lesson: lesson({ id: "l-3" }),
      memoryEnabled: true,
      writeMemory: () => {
        throw new Error("sink unavailable");
      },
    });
    assert.equal(result.memoryStatus, "failed");
    assert.match(result.error ?? "", /sink unavailable/);
    assert.equal(readAllLessons(h).length, 1);
  });
});

describe("12.6 lesson 上下文呈现", () => {
  it("场景:仓库 X 的 workspace lesson 不原样进入 Y 的提案上下文", () => {
    const h = home("trellis-lesson-scope-");
    recordLesson({
      homeDir: h,
      lesson: lesson({ id: "l-x", layer: { kind: "workspace", root: "/repo/x" } }),
      memoryEnabled: false,
    });
    recordLesson({
      homeDir: h,
      lesson: lesson({ id: "l-g", layer: { kind: "global" } }),
      memoryEnabled: false,
    });

    // Y 的提案上下文:只含全局 lesson,不含 X 的 workspace lesson。
    const forY = lessonsForContext(h, "/repo/y");
    assert.deepEqual(forY.map((l) => l.id), ["l-g"]);
    // X 自己可见 X + 全局。
    const forX = lessonsForContext(h, "/repo/x");
    assert.deepEqual(forX.map((l) => l.id).sort(), ["l-g", "l-x"]);
    // 未指定 workspace:只见全局。
    assert.deepEqual(lessonsForContext(h).map((l) => l.id), ["l-g"]);
  });

  it("跨 workspace lesson 只进升格佐证出口,不混入提案上下文", () => {
    const h = home("trellis-lesson-corrob-");
    recordLesson({
      homeDir: h,
      lesson: lesson({ id: "l-x2", layer: { kind: "workspace", root: "/repo/x" } }),
      memoryEnabled: false,
    });
    const corroboration = lessonsAsCorroboration(h, "/repo/y");
    assert.deepEqual(corroboration.map((l) => l.id), ["l-x2"]);
    // 佐证出口与提案上下文互斥。
    const contextIds = new Set(lessonsForContext(h, "/repo/y").map((l) => l.id));
    assert.ok(!contextIds.has("l-x2"));
  });
});
