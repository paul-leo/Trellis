// OPENCODE_SURFACE(harness2/substrate/opencode.py:42-86)的原样翻译。
// 供 tree / context / library 测试共享。
import { makeSurfaceSpec, type SurfaceSpec } from "../../src/tree.js";

export const OPENCODE_SURFACE: SurfaceSpec = makeSurfaceSpec({
  name: "opencode",
  always_on: [
    "systemprompt.md",
    "guardrails.md",
    "LongTermMEMORY.md",
    "tool_descriptions/tool_guidance.md",
  ],
  always_on_max: 24_000,
  always_on_cap_reason: "every token here competes with the agent's own output budget",
  skill_dir: "skills",
  skill_name_rule: "must_match",
  trigger_hint:
    "Fix it by adding a trigger line naming `{name}` to systemprompt.md or " +
    'guardrails.md, e.g. "When <the situation this skill handles>, load the ' +
    "`{name}` skill.\"",
  autotrigger_file: "guardrails.md",
  trigger_line: "- When {desc}, load the `{name}` skill.\n",
  subagent_requires_mode: true,
  plugin_dir: "plugin",
  hooks_file: null,
  stubs: [
    [
      "scripts/README.md",
      "<!-- c7: deterministic helpers, run as `python3 scripts/<name>.py`. " +
        "Add one by emitting scripts/<name>.py. -->\n",
    ],
    [
      "sub_agents/README.md",
      "<!-- c5: delegated subagents, invoked with the `task` tool in their OWN context. " +
        "Add one as sub_agents/<name>/AGENT.md with frontmatter `mode: subagent` and " +
        "`description:`. -->\n",
    ],
    [
      "plugin/README.md",
      "<!-- c8: OpenCode plugins. Acts INSIDE the tool loop -- the only lever that can " +
        "enforce something the model cannot skip. Add one as plugin/<name>.ts. -->\n",
    ],
    [
      "skills/README.md",
      "<!-- c6: reusable workflows loaded on demand via the `skill` tool. Add one as " +
        "skills/<name>/SKILL.md with frontmatter `name:` matching the directory and a " +
        "`description:`. -->\n",
    ],
  ],
});
