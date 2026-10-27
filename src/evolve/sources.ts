/**
 * 可选信号源探测(trellis-evolve 任务 11.3)。
 *
 * agent-bridge 委托记录是可选信号源:缺席是合法状态,SHALL NOT 使运行
 * 失败——探测返回 `unavailable` 而非抛错,作业评估(11.5)以此继续并把
 * 状态记录下来。委托记录存储取 Trellis 真实落盘的 agent 间委托(task
 * store,`~/.trellis/tasks/tasks.json`);委托记录到信号的映射设计未定,
 * 本期只做源可用性探测,不派生信号内容。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type OptionalSourceStatus = "available" | "unavailable";

export interface OptionalSourceProbe {
  readonly source: "agent-bridge";
  readonly status: OptionalSourceStatus;
  /** 人类可读的状态说明(写入档案时直接采用)。 */
  readonly note: string;
}

export function agentBridgeRecordsPath(homeDir: string): string {
  return join(homeDir, ".trellis", "tasks", "tasks.json");
}

/** 探测 agent-bridge 委托记录是否可用;永不抛错。 */
export function probeAgentBridgeSource(homeDir: string): OptionalSourceProbe {
  if (existsSync(agentBridgeRecordsPath(homeDir))) {
    return {
      source: "agent-bridge",
      status: "available",
      note: "agent-bridge 委托记录存在",
    };
  }
  return {
    source: "agent-bridge",
    status: "unavailable",
    note: "无 agent-bridge 委托存储,运行以其余信号源继续",
  };
}
