/**
 * 原子文件写(tmp + rename):进程崩溃不留半截文件,读取方要么看到
 * 旧内容要么看到新内容。canonical 配置与 pending 记录的写路径统一走
 * 这里(对照:运行档案是只追加 JSONL,语义不同,不用本助手)。
 */

import { randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 原子写入整个文件(调用方负责确保目录存在)。 */
export function writeFileAtomicSync(path: string, content: string): void {
  const temporary = join(dirname(path), `.atomic-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temporary, content, "utf-8");
  renameSync(temporary, path);
}
