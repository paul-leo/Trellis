/**
 * 分级开启的级别策略(trellis-evolve 任务 10.2)。
 *
 * 级别配置是用户的显式选择,写入 canonical 的 `~/.trellis/evolve.yaml`
 * (与 scope.yaml / secrets.policy.yaml 同级的根级策略文件;与 `evolve/`
 * 运行状态目录刻意分开 —— 后者是只追加的运行记录,见任务 8.1)。格式、
 * 校验与解析归 host:canonical 配置的解析是托管的职责,且 doctor(托管
 * 命令)与自我进化消费者(`src/evolve/`,只允许 import `src/host/*`)必须
 * 对同一份格式与解析规则达成一致 —— `src/host/` 是二者之间唯一合法的
 * 共享缝(10.3 的边界)。卸载自我进化后本模块仍然自洽:文件不存在即
 * 全部为 `off`,doctor 不出现该段。
 *
 * 文件形态(snake_case,沿用 servers.yaml 惯例):
 *
 * ```yaml
 * default_level: observe
 * agents:
 *   claude-code: propose
 * workspaces:
 *   /abs/path/ws-a: off
 * ```
 *
 * 解析优先级(更具体覆盖更宽泛):workspace > agent > default_level > `off`。
 * 值白名单即 `LEVELS` 四级;present-but-invalid 一律硬错误,绝不静默误读。
 * 读取零副作用:本模块永不创建文件或目录;写入只经 `writeEvolveLevelPolicy`
 * (12.4 的 enable/disable 管理命令调用),从不静默开启。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeFileAtomicSync } from "../lib/fsAtomic.js";

/** 分级开启的四级,从关闭到最激进,有序(开启判定按此序)。 */
export const LEVELS = ["off", "observe", "propose", "auto-A"] as const;
export type Level = (typeof LEVELS)[number];

const LABEL = "evolve.yaml";

function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** 显式级别策略。缺省的键即"未设置",向更宽泛的粒度回退。 */
export interface EvolveLevelPolicy {
  /** 全局默认级别;未设置时回退为 `off`。 */
  readonly defaultLevel?: Level;
  /** per-agent 覆盖(agent 标识 → 级别)。 */
  readonly agents: Readonly<Record<string, Level>>;
  /** per-workspace 覆盖(绝对 workspace root 路径 → 级别)。 */
  readonly workspaces: Readonly<Record<string, Level>>;
  /** 触发/预算上限(trellis-evolve 任务 11.5,spec"可配置");缺省键
   * 由触发器回退到内置缺省值。全部为非负整数。 */
  readonly trigger?: EvolveTriggerLimits;
}

/** `evolve.yaml` 的 `trigger:` 段(单位见字段注释;缺省值见 evolve 侧
 * `DEFAULT_TRIGGER_LIMITS`)。 */
export interface EvolveTriggerLimits {
  /** 累计未消费信号数阈值,达到即考虑拉起作业。 */
  readonly signalThreshold?: number;
  /** 冷却期(分钟):上一作业结束后此时间内不再拉起。 */
  readonly cooldownMinutes?: number;
  /** 每日提案上限:当日提案数达到即跳过并记录原因。 */
  readonly dailyProposalCap?: number;
  /** 委派 editor 每日预算上限(调用次数)。 */
  readonly editorBudget?: number;
}

/**
 * 观测形态(trellis-evolve 任务 11.4):该 agent 的进化信号来源。
 * `events` = gateway 事件观察(runtime 交付);`doctor-only` = 只有
 * doctor/sync 信号(仅原生渲染,无事件面)。由调用方按 capability
 * delivery 计算,本模块不读 MCP 配置。
 */
export type EvolveObservation = "events" | "doctor-only";

/** doctor 展示形态:各 agent 的生效级别与观测形态 + 显式 workspace 覆盖。 */
export interface EvolveLevelSection {
  readonly defaultLevel?: Level;
  readonly agents: readonly { readonly agent: string; readonly level: Level; readonly observation: EvolveObservation }[];
  readonly workspaces: readonly { readonly root: string; readonly level: Level }[];
  readonly diagnostics: readonly string[];
}

export function evolveLevelPolicyPath(homeDir: string): string {
  return join(homeDir, ".trellis", LABEL);
}

const EMPTY_POLICY: EvolveLevelPolicy = { agents: {}, workspaces: {} };

/**
 * 读取级别策略。文件不存在 = 从未开启,返回空策略(全 `off`),且不
 * 创建任何文件。present-but-invalid(坏 YAML、未知键、非法级别)抛错
 * 带原因 —— 不静默降级成 `off`,否则用户的显式开启会被伪装成关闭。
 */
export function loadEvolveLevelPolicy(homeDir: string): EvolveLevelPolicy {
  let text: string;
  try {
    text = readFileSync(evolveLevelPolicyPath(homeDir), "utf-8");
  } catch {
    return EMPTY_POLICY;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new Error(`${LABEL}: invalid YAML — ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return EMPTY_POLICY;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${LABEL}: top level must be a mapping { default_level?, agents?, workspaces? }`);
  }
  const raw = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "default_level" && key !== "agents" && key !== "workspaces" && key !== "trigger") {
      throw new Error(`${LABEL}: unrecognized top-level key "${key}"`);
    }
  }

  let defaultLevel: Level | undefined;
  if (raw.default_level !== undefined) {
    if (!isLevel(raw.default_level)) {
      throw new Error(`${LABEL}: "default_level" must be one of ${LEVELS.join(" | ")} — got ${JSON.stringify(raw.default_level)}`);
    }
    defaultLevel = raw.default_level;
  }

  return {
    ...(defaultLevel !== undefined ? { defaultLevel } : {}),
    agents: parseLevelMap(raw.agents, "agents"),
    workspaces: parseLevelMap(raw.workspaces, "workspaces"),
    ...(raw.trigger !== undefined ? { trigger: parseTriggerLimits(raw.trigger) } : {}),
  };
}

const TRIGGER_KEYS: Record<string, keyof EvolveTriggerLimits> = {
  signal_threshold: "signalThreshold",
  cooldown_minutes: "cooldownMinutes",
  daily_proposal_cap: "dailyProposalCap",
  editor_budget: "editorBudget",
};

function parseTriggerLimits(value: unknown): EvolveTriggerLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${LABEL}: "trigger" must be a mapping of ${Object.keys(TRIGGER_KEYS).join(" | ")}`);
  }
  const limits: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const camel = TRIGGER_KEYS[key];
    if (camel === undefined) {
      throw new Error(`${LABEL}: "trigger" has unrecognized key "${key}" — expected one of ${Object.keys(TRIGGER_KEYS).join(" | ")}`);
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw new Error(`${LABEL}: "trigger.${key}" must be a non-negative integer — got ${JSON.stringify(raw)}`);
    }
    limits[camel] = raw;
  }
  // 缺省键不出现(由触发器回退到内置缺省值)。
  return limits as EvolveTriggerLimits;
}

function parseLevelMap(value: unknown, field: string): Record<string, Level> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${LABEL}: "${field}" must be a mapping of key → level`);
  }
  const out: Record<string, Level> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0) {
      throw new Error(`${LABEL}: "${field}" keys must be non-empty strings`);
    }
    if (!isLevel(raw)) {
      throw new Error(`${LABEL}: "${field}.${key}" must be one of ${LEVELS.join(" | ")} — got ${JSON.stringify(raw)}`);
    }
    out[key] = raw;
  }
  return out;
}

/**
 * 显式写入级别策略(用户选择的唯一入库通道;12.4 的 enable/disable
 * 命令调用)。幂等:相同策略重写产生相同文件。
 */
export function writeEvolveLevelPolicy(homeDir: string, policy: EvolveLevelPolicy): void {
  const doc: Record<string, unknown> = {};
  if (policy.defaultLevel !== undefined) doc.default_level = policy.defaultLevel;
  if (Object.keys(policy.agents).length > 0) doc.agents = policy.agents;
  if (Object.keys(policy.workspaces).length > 0) doc.workspaces = policy.workspaces;
  if (policy.trigger !== undefined && Object.keys(policy.trigger).length > 0) {
    const trigger: Record<string, number> = {};
    if (policy.trigger.signalThreshold !== undefined) trigger.signal_threshold = policy.trigger.signalThreshold;
    if (policy.trigger.cooldownMinutes !== undefined) trigger.cooldown_minutes = policy.trigger.cooldownMinutes;
    if (policy.trigger.dailyProposalCap !== undefined) trigger.daily_proposal_cap = policy.trigger.dailyProposalCap;
    if (policy.trigger.editorBudget !== undefined) trigger.editor_budget = policy.trigger.editorBudget;
    doc.trigger = trigger;
  }
  const path = evolveLevelPolicyPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  // 原子写:崩溃不留半截 YAML——present-but-invalid 会硬抛,半写文件
  // 会让 doctor/recorder 等全部读取面报错。
  writeFileAtomicSync(path, stringifyYaml(doc));
}

/**
 * 生效级别:更具体覆盖更宽泛 —— workspace 覆盖 > agent 覆盖 > 全局
 * 默认 > `off`。会话在固定 (agent, workspace) 上下文中取值;任一粒度
 * 未设置即向更宽泛粒度回退。
 */
export function resolveEvolveLevel(
  policy: EvolveLevelPolicy,
  context: { agent?: string; workspaceRoot?: string | null },
): Level {
  const root = context.workspaceRoot;
  if (root != null) {
    const workspaceLevel = policy.workspaces[root];
    if (workspaceLevel !== undefined) return workspaceLevel;
  }
  if (context.agent !== undefined) {
    const agentLevel = policy.agents[context.agent];
    if (agentLevel !== undefined) return agentLevel;
  }
  return policy.defaultLevel ?? "off";
}

/**
 * doctor 展示数据:托管的每个 agent 一行生效级别与观测形态(取 agent
 * 覆盖或全局默认;workspace 覆盖单独成行)。观测形态由调用方按 capability
 * delivery 计算后随条目传入;`agents` 之外的显式 agent 覆盖也列出(用户
 * 设置了就可见),它们没有 runtime 交付配置,观测形态按 `doctor-only`。
 */
export function describeEvolveLevels(
  policy: EvolveLevelPolicy,
  managedAgents: readonly { readonly agent: string; readonly observation: EvolveObservation }[],
): EvolveLevelSection {
  const seen = new Set<string>();
  const agents: { agent: string; level: Level; observation: EvolveObservation }[] = [];
  for (const entry of managedAgents) {
    if (seen.has(entry.agent)) continue;
    seen.add(entry.agent);
    agents.push({ agent: entry.agent, level: resolveEvolveLevel(policy, { agent: entry.agent }), observation: entry.observation });
  }
  for (const agent of Object.keys(policy.agents)) {
    if (seen.has(agent)) continue;
    seen.add(agent);
    agents.push({ agent, level: resolveEvolveLevel(policy, { agent }), observation: "doctor-only" });
  }
  const workspaces = Object.entries(policy.workspaces).map(([root, level]) => ({ root, level }));
  return {
    ...(policy.defaultLevel !== undefined ? { defaultLevel: policy.defaultLevel } : {}),
    agents,
    workspaces,
    diagnostics: [],
  };
}
