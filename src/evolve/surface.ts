/**
 * TrellisSubstrate 的 `surface()`(trellis-evolve 任务 9.1)。
 *
 * 声明 Trellis 的可编辑树 schema —— 引擎只认识这个 schema 内的路径,
 * 除此之外的目标(Class C:secret/凭据材料、MCP auth 配置、受管 agent
 * 集合、自我进化自身配置、用户手写文件)根本不在 schema 里,引擎的
 * `is_allowed` 对它们一律返回 false,不需要也不采信模型自报。
 *
 * 可编辑面恰好四类,与任务书一一对应:
 *
 *   - `agents.md`            —— 共享 instructions 段落
 *   - `skills/<name>/`       —— skill 条目(SKILL.md + scripts/*)
 *   - `mcp/routes.yaml`      —— MCP 路由(mode/每 agent 的 server 列表;
 *                              注意 `mcp/servers.yaml` 不在 schema 内 ——
 *                              server 定义与 auth 材料是 Class C)
 *   - `memory/policy.yaml`   —— memory 策略(启用/范围策略本身,
 *                              不是记忆内容)
 *
 * 静默失效模式(编辑"成功"但什么都不改变的形态,editor 契约必须知道):
 *
 *   1. 加了 skill 但没有触发线 —— Trellis 的 skill 按需加载,
 *      `agents.md` 里没有触发线时新条目静默无效(trigger_hint /
 *      autotrigger_file / trigger_line 三个字段就是为这个模式存在);
 *   2. routes.yaml 里给某 agent 的路由其 scope 不含该 agent —— 渲染面
 *      对该 agent 静默为空;
 *   3. memory/policy.yaml 的策略改动只在 memory 已启用的安装上生效。
 *
 * 故意不收进 schema 的 harness2 类目:sub_agents(BenchSpec 的
 * `allow_subagents` 默认 false,Trellis 探针任务不开)、plugin、hooks
 * (Trellis 没有这两个概念)。root `scripts/` 保留 harness2 原语义
 * (确定性辅助脚本),skill 脚本不编译(非 Python 约定)。
 */

import { makeSurfaceSpec, type SurfaceSpec } from "@trellis/evolve-engine";

export const TRELLIS_SURFACE: SurfaceSpec = makeSurfaceSpec({
  name: "trellis",
  always_on: ["agents.md", "mcp/routes.yaml", "memory/policy.yaml"],
  always_on_max: 48_000,
  always_on_cap_reason:
    "every always-on byte is injected into every managed agent's context on every session",
  skill_dir: "skills",
  skill_name_rule: "must_match",
  trigger_hint:
    "Fix it by adding a trigger line naming `{name}` to agents.md, e.g. " +
    '"When <the situation this skill handles>, load the `{name}` skill." ' +
    "A skill with no trigger line is silently inert: Trellis loads skills " +
    "on demand, so nothing references it.",
  autotrigger_file: "agents.md",
  trigger_line: "- When {desc}, load the `{name}` skill.\n",
  subagent_requires_mode: false,
  plugin_dir: null,
  hooks_file: null,
  stubs: [
    [
      "skills/README.md",
      "<!-- Reusable capability entries, delivered to managed agents per " +
        "scope. Add one as skills/<name>/SKILL.md with frontmatter `name:` " +
        "matching the directory and a `description:`; helper files live under " +
        "skills/<name>/scripts/. Inert until a trigger line in agents.md " +
        "references it. -->\n",
    ],
    [
      "mcp/README.md",
      "<!-- MCP routing policy lives in mcp/routes.yaml (per-agent mode and " +
        "server lists). Server definitions and auth material are NOT editable " +
        "here — they are protected (Class C) targets. -->\n",
    ],
    [
      "memory/README.md",
      "<!-- Memory policy lives in memory/policy.yaml (enable/scope policy " +
        "itself, not memory content). Changes take effect only where memory " +
        "is enabled. -->\n",
    ],
  ],
});
