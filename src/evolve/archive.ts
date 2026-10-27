/**
 * 运行档案写入器(trellis-evolve 任务 10.4)。
 *
 * `archive/records.jsonl` 只追加 JSONL:提案/探针/verdict/备份会话标识/
 * L2 比较记录按发生顺序落行,永不覆盖、不重排、不去重。读取侧严格解析
 * ——档案是治理审计数据,坏行必须带行号抛出而不是静默跳过。
 *
 * 记录格式:`{ kind, recordedAt, payload }`。`kind` 开放(各任务逐步收
 * 敛:proposal/verdict/lesson/L2 比较等),`payload` 为 JSON 安全的具体
 * 记录;`recordedAt` 由写入器打戳(ISO 8601)。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evolveStateDir } from "./stateDir.js";

export interface ArchiveRecord {
  readonly kind: string;
  readonly payload: unknown;
}

export interface ArchiveEntry extends ArchiveRecord {
  readonly recordedAt: string;
}

export function archiveRecordsPath(homeDir: string): string {
  return join(evolveStateDir(homeDir), "archive", "records.jsonl");
}

/** 只追加一条记录,返回落盘后的完整条目(含打戳)。 */
export function appendArchiveRecord(
  homeDir: string,
  record: ArchiveRecord,
  now: () => Date = () => new Date(),
): ArchiveEntry {
  const entry: ArchiveEntry = { kind: record.kind, recordedAt: now().toISOString(), payload: record.payload };
  mkdirSync(join(evolveStateDir(homeDir), "archive"), { recursive: true, mode: 0o700 });
  // 单行约定:JSON.stringify 会把 payload 内的换行转义,行边界天然成立。
  // 新建 0600:档案含提案内容(配置文件片段),不收世界可读。
  appendFileSync(archiveRecordsPath(homeDir), JSON.stringify(entry) + "\n", { mode: 0o600 });
  return entry;
}

/** 读回全部档案条目;文件不存在返回 [](读取零副作用,不建目录)。 */
export function readArchiveRecords(homeDir: string): ArchiveEntry[] {
  const path = archiveRecordsPath(homeDir);
  if (!existsSync(path)) return [];
  const entries: ArchiveEntry[] = [];
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const [index, line] of lines.entries()) {
    // 末尾换行产生一条尾随空行,不算记录;中间空行是损坏。
    if (line === "" && index === lines.length - 1) continue;
    if (line.trim() === "") throw new Error(`archive: 第 ${index + 1} 行为空行(只追加档案不允许空行)`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`archive: 第 ${index + 1} 行不是合法 JSON`);
    }
    const entry = parsed as Partial<ArchiveEntry> | null;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.kind !== "string" ||
      typeof entry.recordedAt !== "string" ||
      !("payload" in entry)
    ) {
      throw new Error(`archive: 第 ${index + 1} 行缺少 kind/recordedAt/payload`);
    }
    entries.push(entry as ArchiveEntry);
  }
  return entries;
}
