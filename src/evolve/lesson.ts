/**
 * lesson 记录(trellis-evolve 任务 12.6)。
 *
 * 被采纳的编辑产出一条 lesson(cue / 正文 / 证据链接 / 可选 confidence /
 * 层作用域,类型见 types.ts)。spec"lesson 记录与上下文呈现":
 *
 *   - canonical 记忆已启用 → 经现有记忆管道写入(缺省内置写入器把
 *     lesson 落成 canonical `memories/lesson-<id>.md`;调用方可注入
 *     自有管道);
 *   - 未启用 → 只留运行档案,运行不失败:返回 skipped 而非 failed;
 *   - 后续提案只呈现匹配上下文的 lesson:全局 lesson 处处可见,
 *     workspace lesson 只给该 workspace;对其他上下文仅作为升格审批
 *     的跨项目佐证(单独出口,不混入提案上下文)。
 *
 * "记忆已启用"是调用方判定后的显式参数(共享 Memory MCP 的 on/off
 * 属托管配置面,消费者不读 mcp 配置 —— 10.3 边界)。档案恒写:lesson
 * 的审计源是运行档案,记忆管道是投递产物。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SurfaceLayer } from "../host/index.js";
import { appendArchiveRecord, readArchiveRecords } from "./archive.js";
import type { Lesson } from "./types.js";

/** 运行档案 kind:一条 lesson。payload 即 Lesson 的 JSON 形态。 */
export const LESSON_ARCHIVE_KIND = "lesson";

export type LessonMemoryStatus = "written" | "skipped" | "failed";

export interface RecordLessonOptions {
  readonly homeDir: string;
  readonly lesson: Lesson;
  /** canonical 记忆是否已启用(调用方按托管配置判定)。 */
  readonly memoryEnabled: boolean;
  /** 记忆管道写入缝;缺省内置写入器落 `memories/lesson-<id>.md`。
   * 抛错按 failed 收口(仍留档案),不拖垮运行。 */
  readonly writeMemory?: (lesson: Lesson) => void;
}

export interface RecordLessonResult {
  readonly memoryStatus: LessonMemoryStatus;
  /** 内置写入器落盘的路径(注入自有管道时为 undefined)。 */
  readonly memoryPath?: string;
  /** 写入失败时的错误信息(仅 failed)。 */
  readonly error?: string;
}

function defaultWriteMemory(homeDir: string, lesson: Lesson): string {
  const dir = join(homeDir, ".trellis", "memories");
  mkdirSync(dir, { recursive: true });
  // lesson.id 已带 `lesson-` 前缀(产出方约定),文件名直接用 id。
  const path = join(dir, `${lesson.id}.md`);
  const evidenceLines = lesson.evidence.map((link) => {
    const ref =
      link.kind === "run" ? link.runId : link.kind === "doctor-finding" ? link.findingId : link.signalId;
    return `- ${link.kind}:${ref}`;
  });
  const confidenceLine = lesson.confidence !== undefined ? `confidence: ${lesson.confidence}\n` : "";
  const layerLine =
    lesson.layer.kind === "global"
      ? "layer: global"
      : `layer: workspace(${lesson.layer.root})`;
  writeFileSync(
    path,
    `# ${lesson.cue}\n\n${lesson.body}\n\n${layerLine}\n${confidenceLine}\nevidence:\n${evidenceLines.join("\n")}\n`,
    "utf-8",
  );
  return path;
}

/**
 * 记录一条 lesson:恒写运行档案;记忆已启用才走记忆管道(未启用
 * skipped;管道抛错 failed 但运行不中断)。
 */
export function recordLesson(options: RecordLessonOptions): RecordLessonResult {
  const { homeDir, lesson, memoryEnabled } = options;
  appendArchiveRecord(homeDir, { kind: LESSON_ARCHIVE_KIND, payload: lesson });

  if (!memoryEnabled) {
    return { memoryStatus: "skipped" };
  }
  try {
    if (options.writeMemory !== undefined) {
      options.writeMemory(lesson);
      return { memoryStatus: "written" };
    }
    const memoryPath = defaultWriteMemory(homeDir, lesson);
    return { memoryStatus: "written", memoryPath };
  } catch (err) {
    return { memoryStatus: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

function lessonLayerMatches(lesson: Lesson, workspaceRoot: string | undefined): boolean {
  const layer: SurfaceLayer = lesson.layer;
  if (layer.kind === "global") return true;
  return workspaceRoot !== undefined && layer.root === workspaceRoot;
}

/** 全部 lesson(档案读取;档案是 lesson 的审计源)。 */
export function readAllLessons(homeDir: string): Lesson[] {
  const lessons: Lesson[] = [];
  for (const entry of readArchiveRecords(homeDir)) {
    if (entry.kind !== LESSON_ARCHIVE_KIND) continue;
    lessons.push(entry.payload as Lesson);
  }
  return lessons;
}

/**
 * 提案上下文用:只呈现匹配上下文的 lesson——全局处处可见;workspace
 * lesson 只给同一 workspace root;其他 workspace 的 lesson 不进提案
 * 上下文(spec 场景:仓库 X 的 lesson 不原样进入 Y)。
 */
export function lessonsForContext(homeDir: string, workspaceRoot?: string): Lesson[] {
  return readAllLessons(homeDir).filter((lesson) => lessonLayerMatches(lesson, workspaceRoot));
}

/**
 * 升格审批的跨项目佐证:当前上下文之外的 workspace lesson(全局
 * lesson 不在此列——它们本就处处可见)。仅供升格审批参考,绝不混入
 * 提案生成上下文。
 */
export function lessonsAsCorroboration(homeDir: string, workspaceRoot?: string): Lesson[] {
  return readAllLessons(homeDir).filter((lesson) => {
    if (lesson.layer.kind === "global") return false;
    return workspaceRoot === undefined || lesson.layer.root !== workspaceRoot;
  });
}
