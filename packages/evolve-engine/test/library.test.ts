// 任务 4.2 验证(部分):library 移植——EXPERIENCE/INDEX 与 Python 原版 golden 逐字节一致。
// golden 为 golden/demo-k2-both/library/k2/{agg,seq}/accounting;add() 输入从
// golden EXPERIENCE.md 反解(非循环:重建输出仍须逐字节匹配 golden)。
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { domain_dir, has_experience, Library, root_for, slug } from "../src/library.js";
import { read_tree } from "../src/tree.js";
import { OPENCODE_SURFACE } from "./fixtures/open-code-surface.js";

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "golden",
  "demo-k2-both",
  "library",
  "k2",
);

// ---- 从 golden EXPERIENCE.md 反解的 add() 输入 ----
const WHY = "The signed total matches the source ledger.";
const EDITS =
  "component: scripts/summarize.py\n" +
  "candidates: inv1\n" +
  "change: dropped the positive-only filter from the amount sum\n" +
  "observed: the probe total included the credits the base run omitted\n" +
  "verdict: helped";
const EXPERIENCE = {
  cue: "When a ledger includes credits and debits",
  lesson: "Include both signs when summing in scripts/summarize.py.",
  evidence:
    "The scripts/summarize.py row -- removing the positive-only filter changed " +
    "the probe total to include the credits omitted by the base trajectory.",
  confidence: "high for this observed arithmetic contrast",
  edits: EDITS,
};

interface EntryInput {
  task: string;
  label: string;
  run: string;
}

const VARIANTS: Array<{ variant: string; entries: EntryInput[] }> = [
  {
    variant: "agg",
    entries: [
      { task: "ledger-1", label: "agg1", run: "demo-oc-agg2/ledger-1/agg1" },
      { task: "ledger-2", label: "agg2", run: "demo-oc-agg2/ledger-2/agg2" },
    ],
  },
  {
    variant: "seq",
    entries: [
      { task: "ledger-1", label: "c1", run: "demo-oc-seq2/ledger-1/c1" },
      { task: "ledger-2", label: "c2", run: "demo-oc-seq2/ledger-2/c2" },
    ],
  },
];

for (const { variant, entries } of VARIANTS) {
  test(`golden: library add 重建 EXPERIENCE/INDEX 与 Python 原版逐字节一致(${variant})`, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lib-"));
    try {
      const lib = new Library(root, "accounting", OPENCODE_SURFACE);
      for (const { task, label, run } of entries) {
        const goldenHarness = join(
          GOLDEN,
          variant,
          "accounting",
          "harnesses",
          task,
          "harness",
        );
        const harness = await read_tree(OPENCODE_SURFACE, goldenHarness);
        assert.ok(Object.keys(harness).length > 0, `golden 树非空 ${variant}/${task}`);
        const got = await lib.add(task, harness, {
          why: WHY,
          label,
          run_id: run,
          experience: EXPERIENCE,
        });
        assert.equal(got, lib.entry_dir(task));
        // 树原样落盘(stubs: false),tree_of 往返一致。
        assert.deepEqual(await lib.tree_of(task), harness);
      }
      for (const { task } of entries) {
        assert.equal(
          await fs.readFile(join(lib.entry_dir(task), "EXPERIENCE.md"), "utf8"),
          await fs.readFile(
            join(GOLDEN, variant, "accounting", "harnesses", task, "EXPERIENCE.md"),
            "utf8",
          ),
          `EXPERIENCE.md ${variant}/${task}`,
        );
      }
      assert.equal(
        await fs.readFile(lib.index, "utf8"),
        await fs.readFile(join(GOLDEN, variant, "accounting", "INDEX.md"), "utf8"),
        `INDEX.md ${variant}`,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("slug / domain_dir / has_experience / root_for 单元", () => {
  assert.equal(slug("demo-oc-agg2/ledger-1/agg1"), "demo-oc-agg2__ledger-1__agg1");
  assert.equal(slug("plain"), "plain");

  assert.equal(domain_dir("accounting"), "accounting");
  // Python domain.replace 的形态:分隔符及两侧空白折叠为 __,再 trim;空 → unknown。
  assert.equal(domain_dir("a / b\\c"), "a__b__c");
  assert.equal(domain_dir("  "), "unknown");
  assert.equal(domain_dir(""), "unknown");

  assert.equal(has_experience({ cue: "c", lesson: "l", evidence: "e" }), true);
  assert.equal(has_experience(EXPERIENCE), true);
  assert.equal(has_experience({ cue: "c", lesson: "l" }), false);
  assert.equal(has_experience({ cue: "c", lesson: "l", evidence: "  " }), false);
  assert.equal(has_experience(null), false);
  assert.equal(has_experience(["cue"]), false);
  assert.equal(has_experience("cue"), false);

  assert.equal(root_for("/b", { benchmark: "demo", k: 2 }), join("/b", "demo", "k2"));
  assert.equal(
    root_for("/b", { benchmark: "demo", k: 2, variant: "agg" }),
    join("/b", "demo", "k2-agg"),
  );
  // 显式 tag 跨 run 共享一个库。
  assert.equal(
    root_for("/b", { benchmark: "demo", k: 2, variant: "agg", tag: "shared" }),
    join("/b", "demo", "shared"),
  );
});

test("add: 无有效 experience 返回 null 且不落盘", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lib-"));
  try {
    const lib = new Library(root, "accounting", OPENCODE_SURFACE);
    assert.equal(await lib.add("t", { "guardrails.md": "x" }, { why: "w", label: "l" }), null);
    assert.equal(await lib.exists(), false);
    assert.equal(await lib.context_dir(), null);
    assert.deepEqual(await lib.entries(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("context_dir: 空域 null,有 EXPERIENCE 返回域目录", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lib-"));
  try {
    const lib = new Library(root, "accounting", OPENCODE_SURFACE);
    // INDEX 存在但整个域内没有任何 EXPERIENCE.md → null(不是"有 INDEX 就有库")。
    await lib.rebuild_index();
    assert.equal(await lib.exists(), true);
    assert.equal(await lib.context_dir(), null);

    await lib.add("t", await goldenHarness("agg", "ledger-1"), {
      why: WHY,
      label: "agg1",
      run_id: "r/agg1",
      experience: EXPERIENCE,
    });
    assert.equal(await lib.context_dir(), lib.dir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("field: cue 值内再有冒号不被截断(经 INDEX 重建观察)", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lib-"));
  try {
    const lib = new Library(root, "accounting", OPENCODE_SURFACE);
    await lib.add("t", await goldenHarness("agg", "ledger-1"), {
      why: "W",
      label: "L",
      run_id: "r/L",
      experience: {
        cue: "When x: do y: really",
        lesson: "L2",
        evidence: "E",
        edits: EDITS,
      },
    });
    const index = await fs.readFile(lib.index, "utf8");
    assert.ok(index.includes("- cue:     When x: do y: really"), index);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("forget / retain: 删条目并重建 INDEX,未知任务忽略", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lib-"));
  try {
    const lib = new Library(root, "accounting", OPENCODE_SURFACE);
    for (const { task, label, run } of VARIANTS[0].entries) {
      await lib.add(task, await goldenHarness("agg", task), {
        why: WHY,
        label,
        run_id: run,
        experience: EXPERIENCE,
      });
    }
    assert.deepEqual(await lib.entries(), ["ledger-1", "ledger-2"]);

    // 未知任务被忽略(不改 INDEX、不炸)。
    await lib.forget(["nope"]);
    assert.deepEqual(await lib.entries(), ["ledger-1", "ledger-2"]);

    await lib.forget(["ledger-1"]);
    assert.deepEqual(await lib.entries(), ["ledger-2"]);
    const index = await fs.readFile(lib.index, "utf8");
    assert.ok(!index.includes("harnesses/ledger-1/"), index);
    assert.ok(index.includes("harnesses/ledger-2/"), index);

    // retain 只留指定条目。
    await lib.add("ledger-1", await goldenHarness("agg", "ledger-1"), {
      why: WHY,
      label: "agg1",
      run_id: "r/agg1",
      experience: EXPERIENCE,
    });
    assert.deepEqual(await lib.entries(), ["ledger-1", "ledger-2"]);
    await lib.retain(["ledger-1"]);
    assert.deepEqual(await lib.entries(), ["ledger-1"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function goldenHarness(variant: string, task: string) {
  return read_tree(
    OPENCODE_SURFACE,
    join(GOLDEN, variant, "accounting", "harnesses", task, "harness"),
  );
}
