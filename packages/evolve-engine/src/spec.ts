// spec.ts — harness2/core/spec.py(277 行)的逐行移植。
// benchmark 接缝:benchmark 必须供给的一切,仅此而已。
// 三根轴保持分离:method(recursion/prompts/selection/library)、
// substrate(solver rollout 运行其上的 agent 框架)、benchmark(BenchSpec 值 + adapter)。
//
// 逐条对照:
//   ChannelSpec(frozen)          → readonly + makeChannelSpec 内 freeze;kind 校验文案保留
//   resolve_channel_model        → resolve_channel_model:kind/model 必须同时覆盖,
//                                  单独覆盖抛错;空 model 走 ChannelSpec(kind,"") 默认通道形态;
//                                  opencode 要求 provider 前缀("provider/model"),
//                                  claude_cli 要求裸 Anthropic id
//   BenchPrompts(frozen)         → readonly + freeze;prompt_pack ∈ {adapt, tts};
//                                  可见字段禁词校验(benchmark/evaluation/grader/rubric/score,
//                                  小写比较)——描述工作本身,不描述度量
//   BenchSpec(frozen)            → readonly + freeze;install_mode ∈ INSTALL_MODES;
//                                  channels 必须含 proposer/selector;obs_trunc >= 10000;
//                                  reserved_scripts 只收裸 .py 文件名
//   RunView(dataclass, 可变)     → 可变接口(不 freeze)
//   SubstrateLike / BenchmarkAdapter(Protocol) → TS 接口;方法异步化,Path → string
//   resolve_prompts              → resolve_prompts:adapter.prompts_for 可选钩子,
//                                  返回非 BenchPrompts 形态抛 TypeError
//
// 环境差异(已记录):Python 在模块导入时读 HARNESS2_* 环境变量(config.py);
// TS 在模块加载时读 process.env,语义等价于"进程启动后不再变化"。
// keepBaseInPool(base 留池偏差,D11 三处显式偏差之一;spec.py 无此字段):
// BenchSpec 上的纯数据开关,缺省 false = harness2 原样行为(base 排除出
// 候选池)。true 时 schedule 把 base rollouts 并入候选池(我们不能退化,
// 选择器可选中 base → 不采纳)。数据声明在此,池构造的并入在 schedule
// 调用侧——引擎其余逻辑不动。

import { pyListRepr, pyRepr, pyTupleRepr } from "./pyutil.js";
import type { SurfaceSpec } from "./tree.js";

export type ModelId = string;

export const CHANNELS = ["claude_cli", "opencode"] as const;
export type Channel = (typeof CHANNELS)[number];

// harness2/config.py:99/101/174/175 —— 模块加载期读取,与 Python 的 import-time 一致。
const SOLVER_MODEL_OC = process.env.HARNESS2_SOLVER_MODEL ?? "";
const IMPROVER_MODEL = process.env.HARNESS2_IMPROVER_MODEL ?? SOLVER_MODEL_OC;
export const DEFAULT_PROPOSER_CHANNEL: Channel = "opencode";
export const PROPOSER_MODEL_BY_CHANNEL: Record<Channel, string> = {
  opencode: IMPROVER_MODEL,
  claude_cli: IMPROVER_MODEL,
};

export interface ChannelSpec {
  readonly kind: string;
  readonly model: ModelId;
  readonly effort: string;
  readonly steps: number;
  readonly timeout: number;
}

export function makeChannelSpec(input: {
  kind: string;
  model: ModelId;
  effort?: string;
  steps?: number;
  timeout?: number;
}): ChannelSpec {
  if (!(CHANNELS as readonly string[]).includes(input.kind)) {
    throw new Error(
      `unknown channel ${pyRepr(input.kind)}; expected one of ${pyTupleRepr(CHANNELS)}`,
    );
  }
  return Object.freeze({
    kind: input.kind,
    model: input.model,
    effort: input.effort ?? "high",
    steps: input.steps ?? 120,
    timeout: input.timeout ?? 3600,
  });
}

/** 唯一的 channel→model 映射;kind 与 model 只覆盖其一即抛错。 */
export function resolve_channel_model(
  kind: string | null,
  model: string | null,
  opts: { effort?: string; steps?: number; timeout?: number } = {},
): ChannelSpec {
  const effort = opts.effort ?? "high";
  const steps = opts.steps ?? 120;
  const timeout = opts.timeout ?? 3600;
  const use_default = kind === null && model === null;
  if ((kind === null) !== (model === null)) {
    throw new Error(
      "channel and model must be overridden TOGETHER (a bare-id/provider-prefixed " +
        `mismatch fails silently downstream); got kind=${pyRepr(kind)}, model=${pyRepr(model)}`,
    );
  }
  let k = kind ?? DEFAULT_PROPOSER_CHANNEL;
  if (!(CHANNELS as readonly string[]).includes(k)) {
    throw new Error(`unknown channel ${pyRepr(k)}; expected one of ${pyTupleRepr(CHANNELS)}`);
  }
  let m = model ?? PROPOSER_MODEL_BY_CHANNEL[k as Channel];
  if (!m.trim()) {
    if (use_default) {
      return makeChannelSpec({ kind: k, model: "", effort, steps, timeout });
    }
    throw new Error("model override must not be empty");
  }
  if (k === "opencode" && !m.includes("/")) {
    throw new Error(
      "opencode channel needs a provider-prefixed model id " +
        `in HARNESS2_IMPROVER_MODEL or HARNESS2_SOLVER_MODEL, got ${pyRepr(m)}`,
    );
  }
  if (k === "claude_cli" && m.includes("/")) {
    throw new Error(
      "claude_cli channel takes a bare Anthropic id " +
        `(e.g. ${pyRepr(PROPOSER_MODEL_BY_CHANNEL.claude_cli)}), got ${pyRepr(m)}`,
    );
  }
  return makeChannelSpec({ kind: k, model: m, effort, steps, timeout });
}

export interface BenchPrompts {
  readonly work: string;
  readonly domain_word: string;
  readonly inv_levers: string;
  readonly dom_levers: string;
  readonly yardstick: string;
  readonly deliverable_word: string;
  readonly domain_guidance: string;
  readonly selection_checks: string;
  readonly selection_lead: string;
  readonly selection_conformance: string;
  readonly prompt_pack: string;
}

const PROMPT_PACKS = ["adapt", "tts"] as const;
const BANNED_WORDS = ["benchmark", "evaluation", "grader", "rubric", "score"] as const;

export function makeBenchPrompts(input: {
  work: string;
  domain_word?: string;
  inv_levers?: string;
  dom_levers?: string;
  yardstick?: string;
  deliverable_word?: string;
  domain_guidance?: string;
  selection_checks?: string;
  selection_lead?: string;
  selection_conformance?: string;
  prompt_pack?: string;
}): BenchPrompts {
  const prompt_pack = input.prompt_pack ?? "adapt";
  if (!(PROMPT_PACKS as readonly string[]).includes(prompt_pack)) {
    throw new Error(
      `BenchPrompts.prompt_pack must be 'adapt' or 'tts', got ${pyRepr(prompt_pack)}`,
    );
  }
  const prompts: BenchPrompts = {
    work: input.work,
    domain_word: input.domain_word ?? "domain",
    inv_levers: input.inv_levers ?? "",
    dom_levers: input.dom_levers ?? "",
    yardstick: input.yardstick ?? "",
    deliverable_word: input.deliverable_word ?? "deliverable",
    domain_guidance: input.domain_guidance ?? "",
    selection_checks: input.selection_checks ?? "",
    selection_lead: input.selection_lead ?? "",
    selection_conformance: input.selection_conformance ?? "full",
    prompt_pack,
  };
  const visible: Record<string, string> = {
    work: prompts.work,
    inv_levers: prompts.inv_levers,
    dom_levers: prompts.dom_levers,
    yardstick: prompts.yardstick,
    domain_guidance: prompts.domain_guidance,
    selection_checks: prompts.selection_checks,
  };
  for (const [field_name, value] of Object.entries(visible)) {
    const low = value.toLowerCase();
    for (const bad of BANNED_WORDS) {
      if (low.includes(bad)) {
        throw new Error(
          `BenchPrompts.${field_name} must describe the WORK, not its ` +
            `measurement (found ${pyRepr(bad)}). Say what the practitioner needs.`,
        );
      }
    }
  }
  return Object.freeze(prompts);
}

export const INSTALL_MODES = [
  "workspace_agents_md",
  "home_dir_jinja",
  "workspace_config",
  "codex_root",
] as const;

export interface BenchSpec {
  readonly name: string;
  readonly runs_root: string;
  readonly install_mode: string;
  readonly prompts: BenchPrompts;
  readonly channels: Readonly<Record<string, ChannelSpec>>;
  readonly domain_word: string;
  readonly leak_globs: readonly string[];
  readonly allow_subagents: boolean;
  readonly reserved_scripts: ReadonlySet<string>;
  readonly proposer_deliverables: string;
  readonly state_deliverable: boolean;
  readonly obs_trunc: number;
  /** D11 base 留池偏差的数据开关(缺省 false = harness2 原样;见头注释)。 */
  readonly keepBaseInPool: boolean;
}

export function makeBenchSpec(input: {
  name: string;
  runs_root: string;
  install_mode: string;
  prompts: BenchPrompts;
  channels: Record<string, ChannelSpec>;
  domain_word?: string;
  leak_globs?: readonly string[];
  allow_subagents?: boolean;
  reserved_scripts?: ReadonlySet<string>;
  proposer_deliverables?: string;
  state_deliverable?: boolean;
  obs_trunc?: number;
  keepBaseInPool?: boolean;
}): BenchSpec {
  if (!(INSTALL_MODES as readonly string[]).includes(input.install_mode)) {
    throw new Error(
      `unknown install_mode ${pyRepr(input.install_mode)}; expected one of ${pyTupleRepr(INSTALL_MODES)}`,
    );
  }
  const proposer_deliverables = input.proposer_deliverables ?? "contents";
  if (proposer_deliverables !== "contents" && proposer_deliverables !== "names") {
    throw new Error(
      `BenchSpec.proposer_deliverables must be 'contents' or 'names', got ` +
        `${pyRepr(proposer_deliverables)}`,
    );
  }
  for (const role of ["proposer", "selector"]) {
    if (!(role in input.channels)) {
      throw new Error(`BenchSpec.channels must define ${pyRepr(role)}`);
    }
  }
  const obs_trunc = input.obs_trunc ?? 50_000;
  if (obs_trunc < 10_000) {
    throw new Error(
      `obs_trunc=${obs_trunc} is in the range that fabricates defects; ` +
        `use >= 10_000 (default 50_000)`,
    );
  }
  const reserved_scripts = input.reserved_scripts ?? new Set<string>();
  const bad = [...reserved_scripts].filter((s) => s.includes("/") || !s.endsWith(".py")).sort();
  if (bad.length > 0) {
    throw new Error(
      `BenchSpec.reserved_scripts takes bare .py BASENAMES, not paths: ${pyListRepr(bad)}`,
    );
  }
  return Object.freeze({
    name: input.name,
    runs_root: input.runs_root,
    install_mode: input.install_mode,
    prompts: input.prompts,
    channels: Object.freeze({ ...input.channels }),
    domain_word: input.domain_word ?? "domain",
    leak_globs: Object.freeze([...(input.leak_globs ?? [])]),
    allow_subagents: input.allow_subagents ?? false,
    reserved_scripts,
    proposer_deliverables,
    state_deliverable: input.state_deliverable ?? false,
    obs_trunc,
    keepBaseInPool: input.keepBaseInPool ?? false,
  });
}

/** method 对一次已完成 rollout 的全部认知。永不携带分数。 */
export interface RunView {
  label: string;
  run_id: string;
  run_dir: string;
  ok: boolean;
  delivered: boolean;
  cost_usd: number;
  wall_s: number;
  error: string;
}

export function makeRunView(input: {
  label: string;
  run_id: string;
  run_dir: string;
  ok: boolean;
  delivered: boolean;
  cost_usd?: number;
  wall_s?: number;
  error?: string;
}): RunView {
  return {
    label: input.label,
    run_id: input.run_id,
    run_dir: input.run_dir,
    ok: input.ok,
    delivered: input.delivered,
    cost_usd: input.cost_usd ?? 0.0,
    wall_s: input.wall_s ?? 0.0,
    error: input.error ?? "",
  };
}

/** core 对 substrate 的全部需求;adapter 把满足它的对象交给 core。 */
export interface SubstrateLike {
  readonly name: string;
  surface(): SurfaceSpec;
}

/** 实现这些方法,整套方法即可工作。此处没有任何 method 逻辑。 */
export interface BenchmarkAdapter {
  readonly spec: BenchSpec;
  readonly substrate: SubstrateLike;
  /** 某 split 的任务 id。顺序稳定 —— library 状态必须可复现。 */
  tasks(split?: string): Promise<string[]>;
  /** 分组单元:practice area / occupation / role / sector。 */
  domain_of(task_id: string): string;
  /** agent 收到的任务原文,已剥离 criteria 与期望产出。 */
  task_prompt(task_id: string): string;
  /** 可选。工作所依据的源材料,或 null。 */
  task_files(task_id: string): Promise<string | null>;
  /** 跑一次 rollout 并返回其 run 目录,按 run_id 幂等。harness_dir=null 即未修改的 base。 */
  execute(task_id: string, harness_dir: string | null, run_id: string, opts?: { timeout?: number | null }): Promise<string>;
  /** 这次 rollout 产出了任务要求的 artifact 吗? */
  delivered(run_dir: string): Promise<boolean>;
  /** 共享 [ACTION]/[OBSERVATION]/[ERROR] 语法的可读轨迹。 */
  trajectory(run_dir: string, opts: { obs_trunc: number }): Promise<string>;
  /** 可选。filename → 提取出的可读文本,每个产出 artifact 一条。 */
  deliverable_files(run_dir: string): Promise<Record<string, string>>;
  /** artifact 的文本形态,仅从 agent 产出的字节中提取。 */
  deliverable_text(run_dir: string): Promise<string>;
  /** 可选。产出 artifact 的二进制原件路径(names 模式下的 raw/ 目录)。 */
  deliverable_assets?(run_dir: string): Promise<string[]>;
  /** 可选。names 模式下的产出文件名列表(不给内容)。 */
  deliverable_listing?(run_dir: string): Promise<string[]>;
  /** 可选。产出集中的图片路径(context 只拷前 8 张)。 */
  deliverable_images?(run_dir: string): Promise<string[]>;
  /** 可选钩子:候选文件头的 assets 说明({anon} 占位,全量替换)。 */
  deliverable_assets_note?(names: string[]): string;
  /** 可选钩子:证据清单里的一行 asset 措辞({shown} 占位)。 */
  deliverable_assets_line?(shown: string): string;
  /** 可选:assets 是 raw 原件而非渲染证据(改变证据清单措辞,不改变拷贝行为)。 */
  deliverable_assets_reference_only?: boolean;
  /** 存放未修改 c1..c8 树的目录,benchmark 从这里出发。 */
  base_harness(): Promise<string>;
  /** benchmark 专属 harness 不变量。抛 Error 列出全部问题,文案逐字作为重试反馈。 */
  validate_tree(tree: Record<string, string>): Promise<void>;
  /** 度量一次运行。null = judge 失败,不是 0,也永不作为 0 缓存。仅 core.judge 在选择提交后调用。 */
  score(run_dir: string, task_id: string): Promise<Record<string, unknown> | null>;
  /** 可选钩子:按任务返回特定 prompt profile。 */
  prompts_for?(task_id: string): BenchPrompts;
  /**
   * 可选钩子(Python duck-typing `getattr(adapter, "artifacts_intact", None)`):
   * 这次 run 目录的执行产物在 score 之后是否仍然原样。resume 校验链用它拒绝
   * 被改动过的缓存 run。缺省即不检查。
   */
  artifacts_intact?(run_dir: string): Promise<boolean> | boolean;
  /**
   * 可选钩子(Python duck-typing `getattr(adapter, "execute_many", None)`):
   * 一次批量执行多个 run_id,返回与输入等长的 run 目录数组(下标对齐)。
   * schedule._roll_bases 在 len>1 时优先走它;缺省逐条 execute。
   */
  execute_many?(
    task_id: string,
    harness_dir: string | null,
    run_ids: readonly string[],
  ): Promise<string[]>;
}

/** adapter 提供 prompts_for 时返回任务级 prompt profile,否则用 spec.prompts。 */
export function resolve_prompts(adapter: BenchmarkAdapter, task_id: string): BenchPrompts {
  const fn = adapter.prompts_for;
  const prompts = typeof fn === "function" ? fn.call(adapter, task_id) : adapter.spec.prompts;
  // isinstance(prompts, BenchPrompts) → 结构检查:必需字段齐全且为 string。
  const ok =
    typeof prompts === "object" &&
    prompts !== null &&
    typeof (prompts as BenchPrompts).work === "string" &&
    typeof (prompts as BenchPrompts).prompt_pack === "string";
  if (!ok) {
    const adapterName = (adapter as object)?.constructor?.name ?? "Object";
    const gotName = (prompts as object)?.constructor?.name ?? typeof prompts;
    throw new TypeError(
      `${adapterName}.prompts_for(${pyRepr(task_id)}) returned ${gotName}, expected BenchPrompts`,
    );
  }
  return prompts;
}
