/**
 * 进化订阅者型扩展的 `activate` 包装(design 8.1 定案的装载契约;trees
 * 11.1/11.5 的生产接线)。
 *
 * 装载契约:模块导出 `activate(ctx)` 返回 `{ providers?, subscribers? }`,
 * 由 `~/.trellis/mcp/extensions.yaml` 的清单条目(进化启用命令写入)
 * 指向本模块;gateway 启动时动态 import 并装载。契约的结构形状与
 * `src/lib/hostExtensions.ts` 的 `HostExtension*` 一致——import 边界
 * (10.3)不允许 `src/evolve/` 引 `src/lib/*`,这里以结构类型对接,
 * 由装载集成测试证明形状兼容。
 *
 * 订阅者按级别(activate 时解析,本进程恒定——gateway 按会话拉起):
 *   - `off`:零订阅者(结构上零副作用;清单条目本应在置 off 时被移除,
 *     此处是防御)。
 *   - `observe` 及以上:recorder(事件 → 信号,enabled 恒真——级别已判)。
 *   - `propose`/`auto-A`:另有触发器订阅者(会话结束判定拉起作业、会话
 *     启动补偿判定)。observe 是"只采集信号",不拉起作业。
 */

import { fileURLToPath } from "node:url";
import type { HostEvent } from "../host/hostEvents.js";
import { loadEvolveLevelPolicy, resolveEvolveLevel, type Level } from "../host/levels.js";
import { createSignalRecorder } from "./recorder.js";
import { maybeLaunchOnSessionEnd, maybeLaunchOnSessionStart, type TryLaunchJobOptions } from "./trigger.js";

/** 清单条目 id(进化启用命令写入 `~/.trellis/mcp/extensions.yaml` 用)。 */
export const EVOLVE_EXTENSION_ID = "evolve";

/** 装载契约的结构形状(与 src/lib/hostExtensions.ts 同形,不 import)。 */
interface ActivateContext {
  readonly homeDir: string;
  readonly agent: string;
  readonly workspaceRoot: string | null;
}

interface Activation {
  readonly subscribers?: ReadonlyArray<(event: HostEvent) => void>;
}

function levelAt(context: ActivateContext): Level {
  const policy = loadEvolveLevelPolicy(context.homeDir);
  return resolveEvolveLevel(policy, {
    agent: context.agent,
    workspaceRoot: context.workspaceRoot,
  });
}

export function activate(context: ActivateContext): Activation {
  const level = levelAt(context);
  if (level === "off") return {};

  const recorder = createSignalRecorder({
    homeDir: context.homeDir,
    enabled: () => true,
  });
  const subscribers: Array<(event: HostEvent) => void> = [recorder.handle];

  if (level !== "observe") {
    const policy = loadEvolveLevelPolicy(context.homeDir);
    const options: TryLaunchJobOptions = {
      homeDir: context.homeDir,
      enabled: () => true,
      ...(policy.trigger !== undefined ? { limits: policy.trigger } : {}),
    };
    subscribers.push((event: HostEvent) => {
      if (event.kind === "session_end") maybeLaunchOnSessionEnd(options);
      else if (event.kind === "session_start") maybeLaunchOnSessionStart(options);
    });
  }

  return { subscribers };
}

/**
 * 清单条目的 `load` 模块说明符:本模块的绝对路径(dist 的 .js;经 tsx
 * 直跑源码时为 .ts,动态 import 都能吃)。进化启用命令写清单时取此值。
 */
export function evolveExtensionLoadSpecifier(): string {
  return fileURLToPath(import.meta.url);
}
