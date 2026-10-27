/**
 * gateway 进程内信号 recorder(trellis-evolve 任务 11.1)。
 *
 * 订阅托管事件总线(8.3),把事件元数据写入信号存储:
 *   - 字段白名单:事件对象本身只有 metadata(8.2 类型层强制),写入侧
 *     再按 Signal 信封逐字段拷贝,载荷载体永远不入库;
 *   - secrets 擦除:所有字符串字段写入前经 eraseSecrets;
 *   - 层归属:session_start 事件的 workspaceRoot 派生——该会话内全部
 *     信号归属该 workspace 层,无归属记全局层;
 *   - 按进程分文件、只追加:每个 gateway 进程一个
 *     `signals/<pid>-<startMs>.jsonl`,进程内并发会话写同一文件
 *     (Node 同步 append 逐行原子),跨进程各写各文件,无全局锁;
 *   - off 零副作用:`enabled()` 为 false 时连目录与文件都不创建。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostEvent, ToolResultCategory } from "../host/hostEvents.js";
import type { SurfaceLayer } from "../host/index.js";
import { eraseSecrets } from "./erase.js";
import { evolveStateDir } from "./stateDir.js";
import type { Signal } from "./types.js";

export interface SignalRecorderOptions {
  homeDir: string;
  /** 级别开关(off 或 workspace 覆盖为 off 时返回 false)。缺省恒开。 */
  enabled?: () => boolean;
  /** 采集时间源(测试注入固定时钟);缺省 Date.now。 */
  now?: () => number;
}

export interface SignalRecorder {
  /** 本进程的信号文件路径(首写前文件不存在)。 */
  readonly filePath: string;
  /** 事件总线订阅者形态;返回值忽略(写入是同步的)。 */
  handle(event: HostEvent): void;
}

/** 进化自身活动的 agent 标识(作业/探针会话以此自称)。 */
export const EVOLVE_SELF_AGENT = "trellis-evolve";

/** 进化自身活动的会话标识前缀(11.5 的作业会话命名约定)。 */
export const EVOLVE_SELF_SESSION_PREFIX = "evolve-job-";

/** 防自激(11.3):进化系统自身的调用/编辑不进信号——否则作业会把自己
 * 的活动记成信号、再触发下一轮作业。识别靠自身标识约定;编辑面本身不经
 * 事件总线,结构上就不产生信号。 */
export function isEvolveSelfActivity(event: HostEvent): boolean {
  return event.agent === EVOLVE_SELF_AGENT || event.session.startsWith(EVOLVE_SELF_SESSION_PREFIX);
}

export function createSignalRecorder(options: SignalRecorderOptions): SignalRecorder {
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? (() => true);
  const filePath = signalFilePath(options.homeDir, now());
  const layerBySession = new Map<string, SurfaceLayer>();

  function layerFor(event: HostEvent): SurfaceLayer {
    if (event.kind === "session_start") {
      const layer: SurfaceLayer =
        event.workspaceRoot === null ? { kind: "global" } : { kind: "workspace", root: event.workspaceRoot };
      layerBySession.set(event.session, layer);
      return layer;
    }
    return layerBySession.get(event.session) ?? { kind: "global" };
  }

  function toSignal(event: HostEvent): Signal {
    const common = {
      source: "gateway-event" as const,
      stableId: null,
      collectedAt: now(),
      layer: layerFor(event),
    };
    const identity = {
      ts: event.ts,
      agent: eraseSecrets(event.agent),
      session: eraseSecrets(event.session),
    };
    switch (event.kind) {
      case "tool_call":
        return {
          ...common,
          ...identity,
          kind: "tool-call",
          provider: eraseSecrets(event.provider),
          tool: eraseSecrets(event.tool),
          durationMs: event.durationMs,
          result: event.result as ToolResultCategory,
        };
      case "session_start":
        return { ...common, ...identity, kind: "session-start" };
      case "session_end":
        return { ...common, ...identity, kind: "session-end" };
    }
  }

  return {
    filePath,
    handle(event: HostEvent): void {
      if (!enabled()) return;
      if (isEvolveSelfActivity(event)) return;
      appendSignalLine(filePath, toSignal(event));
    },
  };
}

/** 本进程的信号文件路径(按进程分文件;首写前文件不存在)。 */
export function signalFilePath(homeDir: string, startMs: number): string {
  return join(evolveStateDir(homeDir), "signals", `${process.pid}-${startMs}.jsonl`);
}

/** 只追加一行信号(单行 JSON;JSON.stringify 转义字符串内换行,行边界
 * 天然成立;新建文件 0600——信号含 workspace 路径等机器信息,不收世界
 * 可读)。11.2 的用户纠正上报与 recorder 共用这一条写入路径。 */
export function appendSignalLine(filePath: string, signal: Signal): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  appendFileSync(filePath, JSON.stringify(signal) + "\n", { mode: 0o600 });
}

/**
 * 读回一个信号文件的全部记录(测试与作业评估用;文件不存在返回空)。
 * 容错:崩溃撕行(最后一次 append 只写了一部分)跳过该行继续——信号
 * 不是审计级数据(对照 archive 的严格带行号抛错),一行损坏不应瘫痪
 * 触发器/作业整条链。
 */
export function readSignals(filePath: string): Signal[] {
  if (!existsSync(filePath)) return [];
  const signals: Signal[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (line === "") continue;
    try {
      signals.push(JSON.parse(line) as Signal);
    } catch {
      // 坏行跳过(见头注释)。
    }
  }
  return signals;
}

/**
 * 合并读回全部进程信号文件里 `collectedAt > sinceMs`(null = 全部)的
 * 记录(11.5 作业评估用;与 `trigger` 的 countPendingSignals 同一目录
 * 遍历约定)。读取零副作用:不建目录、不排序语义(按文件名+行序)。
 */
export function readAllSignals(homeDir: string, sinceMs: number | null): Signal[] {
  const dir = join(evolveStateDir(homeDir), "signals");
  if (!existsSync(dir)) return [];
  const out: Signal[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    for (const signal of readSignals(join(dir, name))) {
      if (sinceMs === null || signal.collectedAt > sinceMs) out.push(signal);
    }
  }
  return out;
}
