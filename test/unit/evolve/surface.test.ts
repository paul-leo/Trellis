import assert from "node:assert/strict";
import { test } from "node:test";

import { is_allowed } from "@trellis/evolve-engine";
import { TRELLIS_SURFACE } from "../../../src/evolve/surface.js";

// 任务 9.1:surface() 的 Trellis 可编辑树 schema。
//   - schema 拒绝面:Class C 目标(凭据/auth、受管 agent 集合、进化自身
//     配置、用户手写文件)不可达 —— 引擎的 is_allowed 对它们一律 false;
//   - 可编辑面恰好四类:agents.md、skills/<name>/、mcp/routes.yaml、
//     memory/policy.yaml;
//   - 不可变语义:schema 是冻结单例。

test("可编辑面:四类目标都在 schema 内", () => {
  const allowed = [
    "agents.md",
    "mcp/routes.yaml",
    "memory/policy.yaml",
    "skills/code-review/SKILL.md",
    "skills/code-review/scripts/run.sh",
  ];
  for (const rel of allowed) {
    assert.ok(is_allowed(TRELLIS_SURFACE, rel), `${rel} should be on the editable surface`);
  }
});

test("schema 拒绝面:Class C 目标不可达", () => {
  const rejected = [
    // secret/凭据材料与 MCP auth 配置:server 定义整体不在 schema
    "mcp/servers.yaml",
    "mcp/extensions.yaml",
    // 受管 agent 集合与渲染规则(托管自有,不并入树 schema)
    "managed.yaml",
    "scope.yaml",
    // 自我进化自身配置
    "evolve/config.yaml",
    "evolve.yaml",
    // secrets 策略文件
    "secrets.policy.yaml",
    // 用户手写文件/越界路径
    "../outside.md",
    "/etc/passwd",
    "skills/../../../etc/passwd",
  ];
  for (const rel of rejected) {
    assert.ok(!is_allowed(TRELLIS_SURFACE, rel), `${rel} must NOT be on the editable surface`);
  }
});

test("静默失效模式已声明:skill 触发约定指向 agents.md", () => {
  // 模式 1:skill 无触发线即静默无效 —— 三个字段共同表达这个约定
  assert.equal(TRELLIS_SURFACE.autotrigger_file, "agents.md");
  assert.ok(TRELLIS_SURFACE.trigger_line.includes("{name}"));
  assert.ok(TRELLIS_SURFACE.trigger_hint.includes("agents.md"));
  assert.ok(TRELLIS_SURFACE.trigger_hint.includes("silently inert"));
  // 模式 2/3 的说明在 stub 里(mcp 路由 scope、memory 启用前提)
  const stubs = new Map(TRELLIS_SURFACE.stubs);
  assert.ok(stubs.get("mcp/README.md")?.includes("Class C"));
  assert.ok(stubs.get("memory/README.md")?.includes("only where memory"));
  assert.ok(stubs.get("skills/README.md")?.includes("Inert until"));
});

test("不可变语义:schema 是冻结对象且单例", () => {
  assert.ok(Object.isFrozen(TRELLIS_SURFACE));
  assert.throws(() => {
    // ESM 严格模式下写冻结对象抛 TypeError
    (TRELLIS_SURFACE as { name: string }).name = "mutated";
  }, TypeError);
  assert.equal(TRELLIS_SURFACE.name, "trellis");
});

test("schema 不含 Trellis 没有的 harness2 类目(hooks/plugin)", () => {
  assert.equal(TRELLIS_SURFACE.hooks_file, null);
  assert.equal(TRELLIS_SURFACE.plugin_dir, null);
  assert.equal(TRELLIS_SURFACE.hook_events.size, 0);
  assert.equal(TRELLIS_SURFACE.compile_skill_scripts, false);
  assert.ok(!is_allowed(TRELLIS_SURFACE, "hooks/hooks.yaml"));
  assert.ok(!is_allowed(TRELLIS_SURFACE, "plugin/foo.ts"));
});
