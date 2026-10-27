/**
 * agent 可调用的用户纠正上报入口(trellis-evolve 任务 11.2)。
 *
 * 内容级信号不从事件流捞(8.2 白名单的必然推论,见 design 9.4①):用户
 * 纠正文本一律走本入口显式上报。文本写入前过 secrets 擦除;原始文本不
 * 入库;层归属由调用方观察到的 workspace root 派生,root 本身不独立入库
 * (只随 layer 保留)。与 recorder 共用按进程分文件的只追加写入路径。
 */

import { eraseSecrets } from "./erase.js";
import { appendSignalLine, signalFilePath } from "./recorder.js";
import type { Signal, UserCorrectionSignal } from "./types.js";

/** 与 recorder 同款"按进程分文件":进程内所有上报进同一文件。 */
const PROCESS_START_MS = Date.now();

/** 本进程用户纠正上报所写的信号文件路径。 */
export function userCorrectionFilePath(homeDir: string): string {
  return signalFilePath(homeDir, PROCESS_START_MS);
}

export interface UserCorrectionReport {
  homeDir: string;
  agent: string;
  session: string;
  /** 用户纠正文本原文;写入前擦除,原始文本不入库。 */
  text: string;
  /** 会话观察到的 workspace root;null/缺省记全局层。 */
  workspaceRoot?: string | null;
  /** 级别开关(off 返回 null 且不写入)。缺省恒开。 */
  enabled?: () => boolean;
  /** 采集时间源(测试注入固定时钟);缺省 Date.now。 */
  now?: () => number;
}

/** 上报一条用户纠正;返回写入的信号,off 时返回 null。 */
export function reportUserCorrection(report: UserCorrectionReport): UserCorrectionSignal | null {
  if (report.enabled !== undefined && !report.enabled()) return null;
  const now = report.now ?? Date.now;
  const signal: UserCorrectionSignal = {
    kind: "user-correction",
    source: "agent-report",
    stableId: null,
    collectedAt: now(),
    layer:
      report.workspaceRoot == null
        ? { kind: "global" }
        : { kind: "workspace", root: report.workspaceRoot },
    ts: now(),
    agent: eraseSecrets(report.agent),
    session: eraseSecrets(report.session),
    text: eraseSecrets(report.text),
  };
  appendSignalLine(userCorrectionFilePath(report.homeDir), signal);
  return signal;
}
