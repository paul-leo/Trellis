/**
 * 历史数据导入与幂等回填(trellis-evolve-run-backfill 任务 3.1/3.2)。
 *
 * 把用户**显式选定**的既有 session 数据回填为观察信号,供后续作业按
 * 既有水位线消费。设计(D4):
 *   - 适配器契约 `{ name, sniff, extract }`,首个适配器 `claude-code-jsonl`
 *     (Claude Code 会话 transcript JSONL);
 *   - 白名单元数据:timestamp / agent / 会话 / 工具名 / 耗时 / 结果类别 /
 *     层归属 —— 入参、结果载体与自由文本正文一律不入库(与 recorder 的
 *     字段白名单同一条线);所有字符串字段写入前经 `eraseSecrets`;
 *   - 台账幂等:`evolve/imports/<sha256(内容)>.json` 记源摘要与已导条目
 *     数,同一源重复导入为空操作;stableId `import:<digest 前 12 位>:<行号>`
 *     确定性(重复导入/重复消费不产生重复信号或重复提案);
 *   - 写入复用 recorder 的批量 append(0600/0700、并发安全);整批先
 *     extract 校验、后写入,任何源不可解析即非零退出且零写入。
 *
 * 字段缺省语义(格式缺字段时):ImportedEntry 对应字段记 null —— 耗时
 * 缺省 0(白名单无 unknown 态),结果类别缺省 "ok"(无错误指示),agent
 * 缺省适配器常量 "claude-code",会话缺省源文件名(D4"会话 id=文件名")。
 * 无工具名的记录(文本轮次等)不写为 tool-call 信号,计入 skippedNoTool。
 * 结果类别按记录自带 is_error 归类(每条记录独立映射);tool_use 与其
 * tool_result 在 transcript 中是不同记录,跨记录关联留待适配器后续细化。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SurfaceLayer } from "../host/index.js";
import { eraseSecrets } from "./erase.js";
import { appendSignalLines, signalFilePath } from "./recorder.js";
import { evolveStateDir } from "./stateDir.js";
import type { ToolCallSignal } from "./types.js";

/** 导入条目的白名单元数据(缺字段缺 null;写入侧按文档化缺省补全)。 */
export interface ImportedEntry {
  readonly timestampMs: number | null;
  readonly agent: string | null;
  readonly session: string | null;
  readonly tool: string | null;
  readonly durationMs: number | null;
  readonly result: "ok" | "error" | "timeout" | null;
}

export interface ExtractedEntry {
  /** 源文件物理行号(1 起):stableId 序号,确定性不受过滤影响。 */
  readonly lineNo: number;
  readonly entry: ImportedEntry;
}

export interface ExtractResult {
  readonly entries: readonly ExtractedEntry[];
  /** 无法解析的坏行数(跳过计数,与读取侧容错同源)。 */
  readonly badLines: number;
  /** 无工具名的记录数(文本轮次等,不写为 tool-call 信号)。 */
  readonly skippedNoTool: number;
}

/** 源适配器契约:sniff 判定形态,extract 抽白名单元数据(不写盘)。 */
export interface HistoryAdapter {
  readonly name: string;
  sniff(path: string): boolean;
  extract(path: string): ExtractResult;
}

/** 源不可解析(不存在/不可读/不匹配任何适配器):整批零写入收口。 */
export class ImportSourceError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`历史源 ${path} 无法导入:${reason}`);
    this.name = "ImportSourceError";
    this.path = path;
  }
}

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** 首个 tool_use 块的工具名(一条记录一元数据;多工具块取首个)。 */
function firstToolName(record: Record<string, unknown>): string | null {
  const message = record.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? record.content) as unknown;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") return b.name;
      if (b.type === "tool_result" && typeof b.name === "string") return b.name;
    }
  }
  if (typeof record.tool === "string") return record.tool;
  if (typeof record.tool_name === "string") return record.tool_name;
  return null;
}

/** 记录自带的错误指示(顶层或内容块的 is_error);无指示为 null。 */
function errorIndicator(record: Record<string, unknown>): boolean | null {
  let seen = typeof record.is_error === "boolean" ? record.is_error : null;
  const message = record.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? record.content) as unknown;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (typeof b.is_error === "boolean") seen = seen === true || b.is_error;
    }
  }
  return seen;
}

/** 首个适配器:Claude Code 会话 transcript(JSONL)。 */
export const claudeCodeJsonlAdapter: HistoryAdapter = {
  name: "claude-code-jsonl",
  sniff(path: string): boolean {
    if (!path.endsWith(".jsonl")) return false;
    try {
      const first = readFileSync(path, "utf-8")
        .split("\n")
        .find((line) => line.trim() !== "");
      if (first === undefined) return false;
      const record = JSON.parse(first) as Record<string, unknown>;
      return (
        typeof record === "object" &&
        record !== null &&
        ("type" in record || "sessionId" in record || "timestamp" in record || "uuid" in record)
      );
    } catch {
      return false;
    }
  },
  extract(path: string): ExtractResult {
    const text = readFileSync(path, "utf-8");
    const stem = basename(path).replace(/\.jsonl$/, "");
    const entries: ExtractedEntry[] = [];
    let badLines = 0;
    let skippedNoTool = 0;
    text.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        badLines += 1;
        return;
      }
      if (typeof record !== "object" || record === null) {
        badLines += 1;
        return;
      }
      const rec = record as Record<string, unknown>;
      const tool = firstToolName(rec);
      if (tool === null) {
        skippedNoTool += 1;
        return;
      }
      const isError = errorIndicator(rec);
      entries.push({
        lineNo: index + 1,
        entry: {
          timestampMs: parseTimestamp(rec.timestamp),
          agent: null,
          session: stem,
          tool,
          durationMs: null,
          result: isError === null ? null : isError ? "error" : "ok",
        },
      });
    });
    return { entries, badLines, skippedNoTool };
  },
};

/** 已注册适配器(按序 sniff;契约先行,更多源后置)。 */
export const HISTORY_ADAPTERS: readonly HistoryAdapter[] = [claudeCodeJsonlAdapter];

export interface ImportHistoryOptions {
  readonly homeDir: string;
  /** 显式选定的源路径(仅此处理;不扫描目录、不自动发现)。 */
  readonly paths: readonly string[];
  /** `--workspace` 层归属;缺省全局层。 */
  readonly workspaceRoot?: string;
  /** 时间源(毫秒);缺省 Date.now(采集时刻与台账打戳)。 */
  readonly now?: () => number;
}

export interface ImportedSourceResult {
  readonly path: string;
  readonly sourceDigest: string;
  /** 本次写入条目数(已记账源为 0)。 */
  readonly entries: number;
  readonly badLines: number;
  readonly skippedNoTool: number;
  /** 已记账源(重复导入为空操作)。 */
  readonly duplicate: boolean;
}

export interface ImportHistoryResult {
  readonly sources: readonly ImportedSourceResult[];
  readonly written: number;
  readonly signalFile: string | null;
}

/** 台账文件路径(按源内容摘要命名;内容变 = 新源)。 */
export function importLedgerPath(homeDir: string, digest: string): string {
  return join(evolveStateDir(homeDir), "imports", `${digest}.json`);
}

/**
 * 整批导入:先对全部源 sniff + extract 校验(任何源不可解析即抛
 * `ImportSourceError`,零写入),后一次性写信号与台账(台账最后记账,
 * 中断重跑安全:未记账则重导,提案去重兜底)。不触发任何作业。
 */
export function importHistory(options: ImportHistoryOptions): ImportHistoryResult {
  const now = options.now ?? Date.now;
  const layer: SurfaceLayer =
    options.workspaceRoot === undefined ? { kind: "global" } : { kind: "workspace", root: options.workspaceRoot };

  // ---- 阶段 1:校验与抽取(零写入) ----
  interface Prepared {
    readonly path: string;
    readonly digest: string;
    readonly extracted: ExtractResult;
  }
  const prepared: Prepared[] = [];
  const seenDigests = new Set<string>();
  const duplicates = new Map<string, ImportedSourceResult>();
  for (const path of options.paths) {
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch (err) {
      throw new ImportSourceError(path, `不可读(${err instanceof Error ? err.message : String(err)})`);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (seenDigests.has(digest) || existsSync(importLedgerPath(options.homeDir, digest))) {
      duplicates.set(path, {
        path,
        sourceDigest: digest,
        entries: 0,
        badLines: 0,
        skippedNoTool: 0,
        duplicate: true,
      });
      continue;
    }
    const adapter = HISTORY_ADAPTERS.find((candidate) => candidate.sniff(path));
    if (adapter === undefined) {
      throw new ImportSourceError(path, "不匹配任何已注册适配器(当前支持 Claude Code 会话 JSONL)");
    }
    seenDigests.add(digest);
    prepared.push({ path, digest, extracted: adapter.extract(path) });
  }

  // ---- 阶段 2:写入(信号批量 append,台账最后记账) ----
  const nowMs = now();
  const allSignals: ToolCallSignal[] = [];
  const sources: ImportedSourceResult[] = [];
  for (const item of prepared) {
    const signals: ToolCallSignal[] = [];
    for (const { lineNo, entry } of item.extracted.entries) {
      signals.push({
        kind: "tool-call",
        source: "history-import",
        stableId: `import:${item.digest.slice(0, 12)}:${lineNo}`,
        collectedAt: nowMs,
        layer,
        ts: entry.timestampMs ?? nowMs,
        agent: eraseSecrets(entry.agent ?? "claude-code"),
        session: eraseSecrets(entry.session ?? basename(item.path).replace(/\.jsonl$/, "")),
        provider: eraseSecrets("claude-code"),
        tool: eraseSecrets(entry.tool ?? "unknown"),
        durationMs: entry.durationMs ?? 0,
        result: entry.result ?? "ok",
      });
    }
    allSignals.push(...signals);
    sources.push({
      path: item.path,
      sourceDigest: item.digest,
      entries: signals.length,
      badLines: item.extracted.badLines,
      skippedNoTool: item.extracted.skippedNoTool,
      duplicate: false,
    });
  }

  let signalFile: string | null = null;
  if (allSignals.length > 0) {
    signalFile = signalFilePath(options.homeDir, nowMs);
    appendSignalLines(signalFile, allSignals);
  }
  for (const source of sources) {
    const ledgerPath = importLedgerPath(options.homeDir, source.sourceDigest);
    mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      ledgerPath,
      `${JSON.stringify(
        {
          sourceDigest: source.sourceDigest,
          entries: source.entries,
          importedAtMs: nowMs,
          layer,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  return {
    sources: [...sources, ...duplicates.values()],
    written: allSignals.length,
    signalFile,
  };
}
