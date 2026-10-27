// 任务 4.2 验证(部分):context 移植——layout/mission 对 Python 原版 fixture 逐字节一致,
// build/绊线/pool harness.diff 行为测试。
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assert_no_grader_verdicts,
  assert_no_leak_paths,
  assert_tree_has_no_grader_verdicts,
  build,
  ContextTree,
  mission,
} from "../src/context.js";
import { makeBenchPrompts, makeBenchSpec, makeChannelSpec, makeRunView } from "../src/spec.js";
import type { BenchmarkAdapter, BenchSpec, RunView } from "../src/spec.js";
import { OPENCODE_SURFACE } from "./fixtures/open-code-surface.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "context");

const CHANS = {
  proposer: makeChannelSpec({ kind: "claude_cli", model: "claude-x" }),
  selector: makeChannelSpec({ kind: "claude_cli", model: "claude-x" }),
};

function benchSpec(overrides: Partial<Parameters<typeof makeBenchSpec>[0]> = {}): BenchSpec {
  return makeBenchSpec({
    name: "demo",
    runs_root: "/r",
    install_mode: "workspace_agents_md",
    prompts: makeBenchPrompts({ work: "Reconcile the ledger." }),
    channels: CHANS,
    ...overrides,
  });
}

interface FakeAdapterOpts {
  spec?: BenchSpec;
  taskPrompt?: string;
  taskFiles?: string | null;
  trajectory?: string | ((run_dir: string) => string);
  deliverableFiles?: Record<string, string>;
  deliverableText?: string;
  deliverableAssets?: string[];
  deliverableListing?: string[];
  deliverableImages?: string[];
}

function makeAdapter(opts: FakeAdapterOpts = {}): BenchmarkAdapter {
  const spec = opts.spec ?? benchSpec();
  return {
    spec,
    substrate: {
      name: "opencode",
      surface: () => OPENCODE_SURFACE,
    },
    tasks: async () => [],
    domain_of: () => "accounting",
    task_prompt: () => opts.taskPrompt ?? "Reconcile the ledger workbook.",
    task_files: async () => opts.taskFiles ?? null,
    execute: async () => "",
    delivered: async () => true,
    trajectory: async (run_dir: string) =>
      typeof opts.trajectory === "function" ? opts.trajectory(run_dir) : (opts.trajectory ?? "TRAJ\n"),
    deliverable_files: async () => opts.deliverableFiles ?? {},
    deliverable_text: async () => opts.deliverableText ?? "",
    ...(opts.deliverableAssets ? { deliverable_assets: async () => opts.deliverableAssets! } : {}),
    ...(opts.deliverableListing ? { deliverable_listing: async () => opts.deliverableListing! } : {}),
    ...(opts.deliverableImages ? { deliverable_images: async () => opts.deliverableImages! } : {}),
    base_harness: async () => "",
    validate_tree: async () => {},
    score: async () => ({}),
  } as BenchmarkAdapter;
}

function run(label: string): RunView {
  return makeRunView({ label, run_id: `r/${label}`, run_dir: `/runs/${label}`, ok: true, delivered: true });
}

// ---- layout / mission:与 Python 原版 fixture 逐字节一致 ----

function treeFrom(
  kw: Partial<{
    root: string;
    task_id: string;
    rollouts: string[];
    deliverables: string[];
    harness_files: number;
    library: boolean;
    pool: string[];
    failed: string[];
    deliverables_mode: string;
    source_files: number;
    decisions: number;
  }>,
): ContextTree {
  return new ContextTree({
    root: "context",
    task_id: "ledger-1",
    rollouts: [],
    deliverables: [],
    harness_files: 0,
    library: false,
    pool: [],
    ...kw,
  });
}

test("golden: layout 六个配置与 Python 原版逐字节一致", async () => {
  const cases: Array<[string, ContextTree]> = [
    ["layout-minimal", treeFrom({})],
    ["layout-source-decisions", treeFrom({ source_files: 3, decisions: 2 })],
    [
      "layout-contents-full",
      treeFrom({
        rollouts: ["agg1", "agg2", "b1", "b2"],
        deliverables: ["agg1", "agg2", "b1", "b2"],
        harness_files: 5,
        library: true,
        pool: ["agg1", "agg2"],
        source_files: 2,
        decisions: 1,
        deliverables_mode: "contents",
      }),
    ],
    [
      "layout-names-mode",
      treeFrom({
        rollouts: ["c1", "c2"],
        deliverables: ["c1", "c2"],
        harness_files: 3,
        deliverables_mode: "names",
      }),
    ],
    [
      "layout-many-rollouts",
      treeFrom({
        rollouts: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"],
        deliverables: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"],
      }),
    ],
    [
      "layout-failed-extra",
      treeFrom({
        rollouts: ["ok1"],
        deliverables: ["ok1", "bad1"],
        failed: ["bad1: ValueError: x"],
        harness_files: 1,
      }),
    ],
  ];
  for (const [name, t] of cases) {
    const expected = await fs.readFile(join(FIXTURES, `${name}.txt`), "utf8");
    assert.equal(t.layout, expected, name);
  }
});

test("golden: mission 与 Python 原版逐字节一致(job 首尾空白被剥)", async () => {
  const t = treeFrom({
    rollouts: ["agg1", "agg2", "b1", "b2"],
    deliverables: ["agg1", "agg2", "b1", "b2"],
    harness_files: 5,
    library: true,
    pool: ["agg1", "agg2"],
    source_files: 2,
    decisions: 1,
  });
  const got = mission(t, {
    job: "   Find what regressed in agg2 and say which trajectory moment shows it.   ",
  });
  assert.equal(got, await fs.readFile(join(FIXTURES, "mission-contents-full.txt"), "utf8"));
});

// ---- build 行为 ----

test("build: task.md / 轨迹 / 无产出物回退文案", async () => {
  const dest = join(await fs.mkdtemp(join(tmpdir(), "ctx-")), "context");
  const adapter = makeAdapter({ taskPrompt: "Do the thing.", deliverableText: "" });
  const tree = await build(dest, adapter, "ledger-1", [run("agg1")], {});
  assert.equal(await fs.readFile(join(dest, "task.md"), "utf8"), "Do the thing.");
  assert.equal(await fs.readFile(join(dest, "rollouts", "agg1.md"), "utf8"), "TRAJ\n");
  assert.equal(
    await fs.readFile(join(dest, "deliverables", "agg1.md"), "utf8"),
    "(no deliverable produced)",
  );
  assert.deepEqual(tree.rollouts, ["agg1"]);
  assert.deepEqual(tree.failed, []);
  assert.equal(tree.harness_files, 0);
  assert.equal(tree.library, false);
  await fs.rm(dirname(dest), { recursive: true, force: true });
});

test("build: 源材料拷贝跳过 leak_globs(含 */pat 双形态)", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "ctx-"));
  const src = join(base, "src");
  await fs.mkdir(join(src, "docs"), { recursive: true });
  await fs.mkdir(join(src, "answers"), { recursive: true });
  await fs.writeFile(join(src, "docs", "guide.md"), "G", "utf8");
  await fs.writeFile(join(src, "answers", "key.md"), "SECRET", "utf8");
  const dest = join(base, "context");
  const adapter = makeAdapter({
    taskFiles: src,
    spec: benchSpec({ leak_globs: ["key.md"] }),
  });
  const tree = await build(dest, adapter, "ledger-1", [], {});
  assert.equal(tree.source_files, 1);
  assert.equal(await fs.readFile(join(dest, "source", "docs", "guide.md"), "utf8"), "G");
  await assert.rejects(fs.stat(join(dest, "source", "answers", "key.md")));
  await fs.rm(base, { recursive: true, force: true });
});

test("build: decisions 空笔记回退文案", async () => {
  const dest = join(await fs.mkdtemp(join(tmpdir(), "ctx-")), "context");
  const adapter = makeAdapter();
  const tree = await build(dest, adapter, "t", [], {
    decisions: { c1: "picked inv2", c2: "" },
  });
  assert.equal(await fs.readFile(join(dest, "decisions", "c1.md"), "utf8"), "picked inv2");
  assert.equal(
    await fs.readFile(join(dest, "decisions", "c2.md"), "utf8"),
    "No decision notes returned.",
  );
  assert.equal(tree.decisions, 2);
  await fs.rm(dirname(dest), { recursive: true, force: true });
});

test("build: per-file 产出物 INDEX.md 精确格式(千分位/safe 名/.txt 后缀/raw 注)", async () => {
  const dest = join(await fs.mkdtemp(join(tmpdir(), "ctx-")), "context");
  const base = await fs.mkdtemp(join(tmpdir(), "assets-"));
  const img = join(base, "chart.png");
  await fs.writeFile(img, "PNG", "utf8");
  const adapter = makeAdapter({
    deliverableFiles: { "report.md": "x".repeat(1500), "sub/dir.txt": "hi" },
    deliverableImages: [img],
    deliverableAssets: [img],
  });
  await build(dest, adapter, "t", [run("agg1")], {});
  assert.equal(
    await fs.readFile(join(dest, "deliverables", "agg1", "report.md.txt"), "utf8"),
    "x".repeat(1500),
  );
  assert.equal(
    await fs.readFile(join(dest, "deliverables", "agg1", "sub__dir.txt"), "utf8"),
    "hi",
  );
  assert.equal(
    await fs.readFile(join(dest, "deliverables", "agg1", "images", "chart.png"), "utf8"),
    "PNG",
  );
  assert.equal(
    await fs.readFile(join(dest, "deliverables", "agg1", "raw", "chart.png"), "utf8"),
    "PNG",
  );
  const index = await fs.readFile(join(dest, "deliverables", "agg1", "INDEX.md"), "utf8");
  assert.equal(
    index,
    "# agg1 produced 2 file(s)\n" +
      "\n" +
      "- `report.md`  (1,500 chars extracted)\n" +
      "- `sub/dir.txt`  (2 chars extracted)\n" +
      "\n" +
      "Each `.txt` is the artifact converted to text by the SAME reader the " +
      "work\nis assessed through, so reason about correctness from these -- an " +
      "artifact\nthat does not survive that conversion is treated as unreadable " +
      "however good\nit looks. `images/` holds any images from the same set, which " +
      "are also part\nof how the work is read.\n" +
      "\n\n" +
      "`raw/` holds the binary originals of the artifacts above (same names). " +
      "The rendered\n`.txt` view is CANONICAL -- it reads each artifact the way the " +
      "grader does (a formula\nwith no cached value renders as the empty cell the " +
      "grader sees, even though the raw\nworkbook computes it on open). Open a raw " +
      "file only for detail the rendering flattened,\nnever to overrule it.\n",
  );
  await fs.rm(dirname(dest), { recursive: true, force: true });
  await fs.rm(base, { recursive: true, force: true });
});

test("build: names 模式只写 INDEX(含 pyListRepr 与 WITHHELD 注),不写内容", async () => {
  const dest = join(await fs.mkdtemp(join(tmpdir(), "ctx-")), "context");
  const adapter = makeAdapter({
    spec: benchSpec({ proposer_deliverables: "names" }),
    deliverableListing: ["report.md", "data.csv"],
    deliverableText: "SHOULD NOT APPEAR",
  });
  const tree = await build(dest, adapter, "t", [run("c1")], {});
  assert.equal(tree.deliverables_mode, "names");
  assert.equal(await fs.readFile(join(dest, "deliverables", "c1", "INDEX.md"), "utf8"),
    "# c1 produced 2 file(s)\n" +
      "\n" +
      "c1: ['report.md', 'data.csv']\n" +
      "\n" +
      "- `report.md`\n" +
      "- `data.csv`\n" +
      "\n" +
      "CONTENTS ARE WITHHELD ON THIS PATH, DELIBERATELY. You are shown WHICH files the rollout\n" +
      "produced and not what is inside them. This is not an oversight and not a size budget:\n" +
      "on this benchmark the extracted-deliverable tree lives inside the same trial directory as\n" +
      "the grader's own output, so serving file bodies here once served the grader's pass rate\n" +
      "and failed-check names along with them. Reason about the work from the TRAJECTORY -- what\n" +
      "was attempted, what was observed, what the run did with what it saw -- and from the file\n" +
      "set itself, which is evidence in its own right: the task names the artifacts it expects,\n" +
      "so a missing or misnamed file is a finding. Do not ask for the contents and do not infer\n" +
      "that an unlisted file is empty.\n",
  );
  await assert.rejects(fs.stat(join(dest, "deliverables", "c1.md")));
  await fs.rm(dirname(dest), { recursive: true, force: true });
});

test("build: 部分轨迹失败进 failed,全部失败抛 no trajectory", async () => {
  const dest = join(await fs.mkdtemp(join(tmpdir(), "ctx-")), "context");
  const adapter = makeAdapter({
    trajectory: (dir) => {
      if (dir.includes("bad1")) throw new Error("render blew up");
      return "OK\n";
    },
    deliverableText: "body",
  });
  const tree = await build(dest, adapter, "t", [run("ok1"), run("bad1")], {});
  assert.deepEqual(tree.rollouts, ["ok1"]);
  assert.deepEqual(tree.deliverables, ["ok1", "bad1"]);
  assert.deepEqual(tree.failed, ["bad1: Error: render blew up"]);
  assert.equal(
    await fs.readFile(join(dest, "rollouts", "bad1.md"), "utf8"),
    "(trajectory unavailable: Error: render blew up)",
  );

  await assert.rejects(
    build(join(dirname(dest), "context2"), adapter, "t", [run("bad1")], {}),
    /no trajectory could be rendered for ANY rollout -- the proposer would be adapting on nothing: bad1: Error: render blew up/,
  );
  await fs.rm(dirname(dest), { recursive: true, force: true });
});

test("build: pool harness.diff 与 Python difflib 逐字节一致;相同树为空文件", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "ctx-"));
  const dest = join(base, "context");
  const harness = join(base, "base-harness");
  await fs.mkdir(harness, { recursive: true });
  await fs.writeFile(join(harness, "guardrails.md"), "A\nB\nC\n", "utf8");
  const candSame = join(base, "cand-same");
  await fs.mkdir(candSame, { recursive: true });
  await fs.writeFile(join(candSame, "guardrails.md"), "A\nB\nC\n", "utf8");
  const candDiff = join(base, "cand-diff");
  await fs.mkdir(candDiff, { recursive: true });
  await fs.writeFile(join(candDiff, "guardrails.md"), "A\nX\nC\n", "utf8");
  // 非 surface 文件:read_tree 过滤,不进 diff(与 Python 一致)。
  await fs.writeFile(join(candDiff, "extra.md"), "E\n", "utf8");

  const adapter = makeAdapter({ deliverableText: "produced" });
  const tree = await build(dest, adapter, "t", [run("agg1")], {
    harness_dir: harness,
    pool: [
      ["same", candSame, run("agg1")],
      ["diff", candDiff, null],
    ],
  });
  assert.deepEqual(tree.pool, ["same", "diff"]);
  assert.equal(tree.harness_files, 1);
  assert.equal(
    await fs.readFile(join(dest, "pool", "same", "harness.diff"), "utf8"),
    "",
    "相同树 → 空 diff",
  );
  assert.equal(
    await fs.readFile(join(dest, "pool", "diff", "harness.diff"), "utf8"),
    "--- current/guardrails.md\n" +
      "+++ diff/guardrails.md\n" +
      "@@ -1,3 +1,3 @@\n" +
      " A\n" +
      "-B\n" +
      "+X\n" +
      " C\n",
  );
  assert.equal(
    await fs.readFile(join(dest, "pool", "same", "rollout.md"), "utf8"),
    "TRAJ\n",
  );
  assert.equal(
    await fs.readFile(join(dest, "pool", "same", "produced.md"), "utf8"),
    "produced",
  );
  await fs.rm(base, { recursive: true, force: true });
});

test("build: 非空 library 目录整树拷入,空目录不拷", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "ctx-"));
  const lib = join(base, "library");
  await fs.mkdir(join(lib, "accounting"), { recursive: true });
  await fs.writeFile(join(lib, "accounting", "INDEX.md"), "# Library\n", "utf8");
  const dest = join(base, "context");
  const tree = await build(dest, makeAdapter(), "t", [], { library_dir: lib });
  assert.equal(tree.library, true);
  assert.equal(
    await fs.readFile(join(dest, "library", "accounting", "INDEX.md"), "utf8"),
    "# Library\n",
  );

  const emptyLib = join(base, "empty-lib");
  await fs.mkdir(emptyLib, { recursive: true });
  const tree2 = await build(join(base, "context2"), makeAdapter(), "t", [], {
    library_dir: emptyLib,
  });
  assert.equal(tree2.library, false);
  await fs.rm(base, { recursive: true, force: true });
});

test("build: harness 拷贝跳过 __pycache__/.pyc 并计数", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "ctx-"));
  const harness = join(base, "h");
  await fs.mkdir(join(harness, "scripts", "__pycache__"), { recursive: true });
  await fs.writeFile(join(harness, "systemprompt.md"), "S", "utf8");
  await fs.writeFile(join(harness, "scripts", "a.py"), "print(1)", "utf8");
  await fs.writeFile(join(harness, "scripts", "__pycache__", "a.pyc"), "BIN", "utf8");
  const dest = join(base, "context");
  const tree = await build(dest, makeAdapter(), "t", [], { harness_dir: harness });
  assert.equal(tree.harness_files, 2);
  await assert.rejects(fs.stat(join(dest, "harness", "scripts", "__pycache__")));
  await fs.rm(base, { recursive: true, force: true });
});

// ---- 绊线 ----

test("assert_no_leak_paths: 命中即抛,列出命中路径", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "ctx-"));
  await fs.mkdir(join(base, "answers"), { recursive: true });
  await fs.writeFile(join(base, "answers", "key.md"), "K", "utf8");
  await fs.writeFile(join(base, "ok.md"), "ok", "utf8");
  assert.doesNotThrow(() => assert_no_leak_paths(base, ["nothing.md"]));
  assert.throws(
    () => assert_no_leak_paths(base, ["key.md"]),
    /answer-key path\(s\) would enter model context: answers\/key\.md/,
  );
  assert.throws(
    () => assert_no_leak_paths(base, ["answers/key.md"]),
    /answer-key path\(s\) would enter model context: answers\/key\.md/,
  );
  // lstrip("./") 字符集语义:../ 也被剥成裸名匹配。
  assert.throws(() => assert_no_leak_paths(base, ["../key.md"]), /answer-key/);
  assert.doesNotThrow(() => assert_no_leak_paths(join(base, "missing"), ["key.md"]));
  await fs.rm(base, { recursive: true, force: true });
});

test("assert_no_grader_verdicts: 文件名与内容双绊线,文案逐字", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "ctx-"));
  await fs.writeFile(join(base, "deterministic_eval_summary.json"), "{}", "utf8");
  assert.throws(
    () => assert_no_grader_verdicts(base),
    /grader verdict would enter model context: 'deterministic_eval_summary\.json' matched marker 'deterministic_eval_summary' in its NAME\. The tripwire in core\.context fired -- this is a leak, not a false positive to widen around\. Find the read path that produced it\./,
  );
  await fs.rm(join(base, "deterministic_eval_summary.json"), { force: true });

  await fs.writeFile(join(base, "notes.md"), 'x{"pass_rate": 0.5}y', "utf8");
  assert.throws(
    () => assert_no_grader_verdicts(base),
    (e: unknown) => {
      const msg = (e as Error).message;
      // 文案逐字 + markerSnippet(pyRepr 命中邻域;body 短于前窗时即全文)。
      assert.ok(
        msg.includes(
          `grader verdict would enter model context: 'notes.md' contains marker '"pass_rate"' at offset 2`,
        ),
        msg,
      );
      assert.ok(msg.includes(`('x{"pass_rate": 0.5}y')`), msg);
      return true;
    },
  );
  await fs.rm(join(base, "notes.md"), { force: true });
  // .bin 不在扫描后缀集内:内容含 marker 不炸。
  await fs.writeFile(join(base, "blob.bin"), '"pass_rate"', "utf8");
  assert.doesNotThrow(() => assert_no_grader_verdicts(base));
  await fs.rm(base, { recursive: true, force: true });
});

test("assert_tree_has_no_grader_verdicts: 名称/内容两分支", () => {
  assert.throws(
    () => assert_tree_has_no_grader_verdicts({ "a_deterministic_eval_result.md": "x" }),
    /harness file 'a_deterministic_eval_result\.md' has grader-verdict marker 'deterministic_eval_result' in its NAME; rename it -- files carrying these strings cannot be served as evidence to later tasks/,
  );
  assert.throws(
    () => assert_tree_has_no_grader_verdicts({ "ok.md": 'before "test_pass_rate": 1 after' }),
    /harness file 'ok\.md' contains grader-verdict marker '"test_pass_rate"' at offset 7/,
  );
  assert.throws(
    () =>
      assert_tree_has_no_grader_verdicts({
        "ok.md": "prefix Judge findings on the rendered result suffix",
      }),
    /contains grader-verdict marker 'Judge findings on the rendered result' at offset 7/,
  );
  assert.doesNotThrow(() => assert_tree_has_no_grader_verdicts({ "ok.md": "clean" }));
  assert.doesNotThrow(() =>
    assert_tree_has_no_grader_verdicts({ "blob.bin": '"pass_rate"' }),
  );
});
