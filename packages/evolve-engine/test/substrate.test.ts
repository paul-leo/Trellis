// 任务 2.2 验证:Substrate 协议的逐字段对照与 frozen → readonly 不可变语义。
import assert from "node:assert/strict";
import test from "node:test";

import {
  makeInstall,
  makeRunRequest,
  makeSurfaceSpec,
  type Install,
  type RunRequest,
  type SurfaceSpec,
} from "../src/index.js";

const baseSurface: SurfaceSpec = makeSurfaceSpec({
  name: "demo",
  always_on: ["systemprompt.md"],
  always_on_max: 1,
  always_on_cap_reason: "cap",
  skill_dir: "skills",
  skill_name_rule: "rule",
  trigger_hint: "hint",
  autotrigger_file: "auto",
  trigger_line: "line",
  subagent_requires_mode: false,
  plugin_dir: null,
  hooks_file: null,
});

test("Install/RunRequest 字段与默认值与 Python dataclass 一致", () => {
  const install = makeInstall({ staging_dir: "/tmp/s", fingerprint: "abc" });
  assert.equal(install.staging_dir, "/tmp/s");
  assert.equal(install.fingerprint, "abc");
  assert.deepEqual(install.extras, {}); // field(default_factory=dict)

  const req = makeRunRequest({ task_ref: "t", run_ids: ["r1", "r2"], timeout: 10 });
  assert.deepEqual([...req.run_ids], ["r1", "r2"]);
  assert.equal(req.timeout, 10);
});

test("SurfaceSpec 默认值与 Python 字段默认值一一对应", () => {
  assert.deepEqual(baseSurface.hook_events, new Set()); // frozenset()
  assert.equal(baseSurface.compile_skill_scripts, false);
  assert.equal(baseSurface.reject_empty_always_on, false);
  assert.deepEqual(baseSurface.stubs, []);
  assert.equal(baseSurface.plugin_dir, null);
});

test("frozen dataclass → readonly + freeze:运行期不可写", () => {
  const install = makeInstall({ staging_dir: "/tmp/s", fingerprint: "abc" });
  assert.equal(Object.isFrozen(install), true);
  assert.throws(() => {
    (install as { fingerprint: string }).fingerprint = "x";
  }, TypeError);
});

test("readonly 字段的编译期不可写", () => {
  // 编译期验证:typecheck 时 @ts-expect-error 必须各自吃掉一个 readonly 错误;
  // 函数体不执行(运行期不可写已由上一个测试覆盖)。
  const typeCheckOnly = () => {
    const install: Install = makeInstall({ staging_dir: "/tmp/s", fingerprint: "abc" });
    // @ts-expect-error readonly 字段不可赋值
    install.fingerprint = "x";
    // @ts-expect-error readonly 数组不可变更
    baseSurface.always_on.push("y");
    const req: RunRequest = makeRunRequest({ task_ref: "t", run_ids: [], timeout: 1 });
    // @ts-expect-error readonly 字段不可赋值
    req.timeout = 2;
    return [install, req];
  };
  assert.equal(typeof typeCheckOnly, "function");
});
