/**
 * 采纳生效侧的窄门面(host-extension-points;trellis-evolve 12.5 的生产接线)。
 *
 * 两个问题的答案,都是托管知识、不是进化知识:
 *   - `triggerRenderSync`:现在触发一次渲染同步(原生渲染 agent 采纳后
 *     生效的唯一途径)。消费者边界(10.3)禁止 `src/evolve/` 引
 *     `commands/*`,而 12.5 的"采纳后触发同步"需要真实现——与 checks/
 *     同款:门面内部组合 commands 层,对外只出自己的形状。
 *   - `isMemoryDeliveryEnabled`:canonical 记忆管道是否已启用(记忆 MCP
 *     server 存在且配置了 `staticEnv.MEMORY_FILE_PATH`,与
 *     `commands/memory.ts` 的 `resolveMemoryServerGraphPath` 同判据)。
 *     12.6 的 lesson 由此决定"走记忆管道"还是"只留档案"。
 *
 * 只读(第二个)与显式触发写(第一个)分离;本模块不做任何静默写入。
 */

import { loadCanonicalSource } from "../core/canonical.js";
import { capabilityDeliveryForAgent, type AgentId } from "../core/types.js";
import { MEMORY_SERVER_NAME } from "../commands/memory.js";
import { runSync } from "../commands/sync.js";
import type { EvolveObservation } from "./levels.js";

/**
 * 触发一次渲染同步(skills + instructions),返回进程语义的退出码。
 * `homeDir` 缺省走真实 `~`(与 `runSync` 同款测试/sandbox 注入缝)。
 */
export async function triggerRenderSync(options: { homeDir?: string } = {}): Promise<{ exitCode: number }> {
  return await runSync(options.homeDir !== undefined ? { homeDir: options.homeDir } : {});
}

/**
 * 记忆管道是否已启用:memory MCP server 存在且带
 * `staticEnv.MEMORY_FILE_PATH`(判据与 `commands/memory.ts` 一致——认
 * 显式配置,不做启发式扫描)。canonical 缺失时按未启用处理。
 */
export function isMemoryDeliveryEnabled(homeDir: string): boolean {
  let server: { enabled?: boolean; staticEnv?: Record<string, string | undefined> } | undefined;
  try {
    server = loadCanonicalSource(homeDir).mcp.servers[MEMORY_SERVER_NAME] as typeof server;
  } catch {
    return false;
  }
  return Boolean(server && server.enabled !== false && server.staticEnv?.MEMORY_FILE_PATH);
}

/**
 * 托管 agent 的观测形态分类(11.4 的"capability delivery"判据,与
 * `commands/doctor.ts` 同源):runtime 交付("mcp"/"both")的 agent 走
 * gateway 事件观察("events");仅原生渲染("native"/未配置)只有
 * doctor/sync 信号("doctor-only")。canonical 缺失返回空列表。
 */
export function classifyManagedObservation(
  homeDir: string,
): { agent: AgentId; observation: EvolveObservation }[] {
  try {
    const canonical = loadCanonicalSource(homeDir);
    return canonical.managedAgents.map((agent) => ({
      agent,
      observation: capabilityDeliveryForAgent(agent, canonical.mcp) !== "native" ? "events" : "doctor-only",
    }));
  } catch {
    return [];
  }
}
