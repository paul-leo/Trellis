// 任务 4.1 验证:spec 的字段/默认值/校验文案与 Python 原版一致。
import assert from "node:assert/strict";
import test from "node:test";

import {
  makeBenchPrompts,
  makeBenchSpec,
  makeChannelSpec,
  makeRunView,
  resolve_channel_model,
  resolve_prompts,
  type BenchmarkAdapter,
} from "../src/spec.js";

const bp = makeBenchPrompts({ work: "Do the work." });

test("ChannelSpec 默认值与 __post_init__ 校验", () => {
  const ch = makeChannelSpec({ kind: "claude_cli", model: "claude-opus-4-5" });
  assert.equal(ch.effort, "high");
  assert.equal(ch.steps, 120);
  assert.equal(ch.timeout, 3600);
  assert.equal(Object.isFrozen(ch), true);
  assert.throws(
    () => makeChannelSpec({ kind: "smoke", model: "x" }),
    /unknown channel 'smoke'; expected one of \('claude_cli', 'opencode'\)/,
  );
});

test("resolve_channel_model:必须同时覆盖,空 model、前缀规则", () => {
  assert.throws(
    () => resolve_channel_model("opencode", null),
    /must be overridden TOGETHER/,
  );
  assert.throws(
    () => resolve_channel_model(null, "some-model"),
    /must be overridden TOGETHER/,
  );
  // 双空(默认通道形态):model 空串是合法默认
  const d = resolve_channel_model(null, null);
  assert.equal(d.model, "");
  assert.throws(
    () => resolve_channel_model("opencode", "bare-model"),
    /opencode channel needs a provider-prefixed model id/,
  );
  assert.throws(
    () => resolve_channel_model("claude_cli", "prov/model"),
    /claude_cli channel takes a bare Anthropic id/,
  );
  assert.throws(() => resolve_channel_model("opencode", "  "), /model override must not be empty/);
  const ok = resolve_channel_model("opencode", "anthropic/claude-opus-4-5");
  assert.equal(ok.kind, "opencode");
});

test("BenchSpec 校验:install_mode、channels、obs_trunc、reserved_scripts", () => {
  const chans = {
    proposer: makeChannelSpec({ kind: "opencode", model: "a/b" }),
    selector: makeChannelSpec({ kind: "claude_cli", model: "m" }),
  };
  assert.throws(
    () => makeBenchSpec({ name: "x", runs_root: "/r", install_mode: "bad", prompts: bp, channels: chans }),
    /unknown install_mode 'bad'/,
  );
  assert.throws(
    () => makeBenchSpec({ name: "x", runs_root: "/r", install_mode: "workspace_agents_md", prompts: bp, channels: { proposer: chans.proposer } }),
    /must define 'selector'/,
  );
  assert.throws(
    () => makeBenchSpec({ name: "x", runs_root: "/r", install_mode: "workspace_agents_md", prompts: bp, channels: chans, obs_trunc: 500 }),
    /obs_trunc=500 is in the range that fabricates defects/,
  );
  assert.throws(
    () =>
      makeBenchSpec({
        name: "x", runs_root: "/r", install_mode: "workspace_agents_md", prompts: bp, channels: chans,
        reserved_scripts: new Set(["scripts/a.py"]),
      }),
    /reserved_scripts takes bare \.py BASENAMES, not paths: \['scripts\/a\.py'\]/,
  );
  const spec = makeBenchSpec({
    name: "demo", runs_root: "/r", install_mode: "workspace_agents_md", prompts: bp, channels: chans,
  });
  assert.equal(spec.obs_trunc, 50_000);
  assert.equal(spec.proposer_deliverables, "contents");
  assert.equal(Object.isFrozen(spec), true);
});

test("RunView 永不携带分数,默认值同 dataclass", () => {
  const v = makeRunView({ label: "base1", run_id: "r", run_dir: "/d", ok: true, delivered: true });
  assert.equal(v.cost_usd, 0.0);
  assert.equal(v.wall_s, 0.0);
  assert.equal(v.error, "");
  assert.ok(!("frac" in v) && !("score" in v) && !("n_passed" in v));
});

test("resolve_prompts:无钩子用 spec.prompts,有钩子用任务级,坏返回抛 TypeError", async () => {
  const spec = makeBenchSpec({
    name: "demo", runs_root: "/r", install_mode: "workspace_agents_md", prompts: bp, channels: {
      proposer: makeChannelSpec({ kind: "opencode", model: "a/b" }),
      selector: makeChannelSpec({ kind: "claude_cli", model: "m" }),
    },
  });
  const base = {
    spec,
    substrate: { name: "opencode", surface: () => { throw new Error("unused"); } },
    tasks: async () => [],
    domain_of: () => "d",
    task_prompt: () => "p",
    task_files: async () => null,
    execute: async () => "/r",
    delivered: async () => true,
    trajectory: async () => "",
    deliverable_files: async () => ({}),
    deliverable_text: async () => "",
    base_harness: async () => "/b",
    validate_tree: async () => {},
    score: async () => null,
  } satisfies BenchmarkAdapter;
  assert.equal(resolve_prompts(base, "t1"), bp);
  const specialized: BenchmarkAdapter = {
    ...base,
    prompts_for: (id) => makeBenchPrompts({ work: `Special for ${id}.` }),
  };
  assert.equal(resolve_prompts(specialized, "t9").work, "Special for t9.");
  const broken = { ...base, prompts_for: () => 42 } as unknown as BenchmarkAdapter;
  assert.throws(() => resolve_prompts(broken, "t1"), /expected BenchPrompts/);
});
