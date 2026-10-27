// 任务 3.1 验证:tree 模块的 golden 对照(同输入比输出)。
// 期望值由 Python 原版 harness2(commit 1cfe254)在同一 golden 输入上计算后嵌入。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  autotrigger,
  diff_summary,
  diversity,
  is_allowed,
  normalize_rel,
  read_tree,
  validate,
  write_tree,
} from "../src/tree.js";
import { OPENCODE_SURFACE } from "./fixtures/open-code-surface.js";

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "golden",
  "demo-k2-both",
);

test("golden: read_tree 读出的 base 树键集合与原版一致", async () => {
  const tree = await read_tree(OPENCODE_SURFACE, join(GOLDEN, "base"));
  assert.deepEqual(Object.keys(tree).sort(), [
    "LongTermMEMORY.md",
    "guardrails.md",
    "scripts/summarize.py",
    "systemprompt.md",
    "tool_descriptions/tool_guidance.md",
  ]);
});

test("golden: validate 的 census 与原版一致", async () => {
  const tree = await read_tree(OPENCODE_SURFACE, join(GOLDEN, "base"));
  const census = await validate(OPENCODE_SURFACE, tree);
  assert.deepEqual(census, {
    always_on_chars: 62,
    n_files: 5,
    skills: 0,
    sub_agents: 0,
    scripts: 1,
    plugins: 0,
  });
});

test("golden: 错误文案逐字符一致(三种 finding 的连接)", async () => {
  const tree = await read_tree(OPENCODE_SURFACE, join(GOLDEN, "base"));
  tree["systemprompt.md"] = "";
  tree["skills/foo/SKILL.md"] = "---\nname: bar\n---\nno description here\n";
  const err = await validate(OPENCODE_SURFACE, tree).then(
    () => null,
    (e: Error) => e.message,
  );
  assert.equal(
    err,
    "skills/foo/SKILL.md needs a `description:` in its frontmatter, or the skill is " +
      "dropped SILENTLY at load | skills/foo/SKILL.md needs frontmatter `name: foo` " +
      "matching its directory (a mismatch is dropped SILENTLY at load) | skill 'foo' is " +
      "never named in the always-on text, so the agent will not know to invoke it — an " +
      "untriggered skill is dead weight. Fix it by adding a trigger line naming `foo` to " +
      'systemprompt.md or guardrails.md, e.g. "When <the situation this skill handles>, ' +
      'load the `foo` skill."',
  );
});

test("golden: diversity(agg1, agg2) 与 summary.json 的 similarity 一致", async () => {
  const dir = join(GOLDEN, "runs", "demo-oc-agg2", "ledger-1", "harnesses");
  const agg1 = await read_tree(OPENCODE_SURFACE, join(dir, "agg1"));
  const agg2 = await read_tree(OPENCODE_SURFACE, join(dir, "agg2"));
  assert.deepEqual(diversity({ agg1, agg2 }), { n: 2, n_distinct: 1, mean_line_jaccard: 1.0 });
});

test("golden: diff_summary(base, agg1) 与原版一致", async () => {
  const base = await read_tree(OPENCODE_SURFACE, join(GOLDEN, "base"));
  const agg1 = await read_tree(
    OPENCODE_SURFACE,
    join(GOLDEN, "runs", "demo-oc-agg2", "ledger-1", "harnesses", "agg1"),
  );
  assert.deepEqual(diff_summary(OPENCODE_SURFACE, base, agg1), {
    added: [],
    removed: [],
    modified: ["scripts/summarize.py"],
    always_on_char_delta: 0,
  });
});

test("write_tree → read_tree 往返一致,always_on 空缺补空文件,stub 就位", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "tree-test-"));
  try {
    const tree = await read_tree(OPENCODE_SURFACE, join(GOLDEN, "base"));
    delete tree["guardrails.md"]; // always_on 之一缺失 → 写出空文件
    await write_tree(OPENCODE_SURFACE, tree, tmp);
    const back = await read_tree(OPENCODE_SURFACE, tmp);
    assert.equal(back["guardrails.md"], "");
    for (const [rel, content] of Object.entries(tree)) {
      assert.equal(back[rel], content, rel);
    }
    // stub 写入且 read_tree 排除 stub
    assert.equal(back["scripts/README.md"], undefined);
    // 二次写入:已从树中移除的 editable 旧文件被清除;已存在的 stub 不被覆盖
    delete tree["scripts/summarize.py"];
    await write_tree(OPENCODE_SURFACE, tree, tmp, { stubs: false });
    const again = await read_tree(OPENCODE_SURFACE, tmp);
    assert.equal(again["scripts/summarize.py"], undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("normalize_rel:拒绝逃逸、规整分隔符与前缀", () => {
  assert.equal(normalize_rel("a\\b\\c"), "a/b/c");
  assert.equal(normalize_rel("./a/b/"), "a/b");
  assert.throws(() => normalize_rel("../x"), /path escapes the harness: '\.\.\/x'/);
  assert.throws(() => normalize_rel("/abs"), /path escapes the harness/);
});

test("is_allowed:表面判定与 hooks_file", () => {
  assert.equal(is_allowed(OPENCODE_SURFACE, "systemprompt.md"), true);
  assert.equal(is_allowed(OPENCODE_SURFACE, "skills/foo/SKILL.md"), true);
  assert.equal(is_allowed(OPENCODE_SURFACE, "skills/foo/scripts/run.py"), true);
  assert.equal(is_allowed(OPENCODE_SURFACE, "sub_agents/helper/AGENT.md"), true);
  assert.equal(is_allowed(OPENCODE_SURFACE, "scripts/ok_1.py"), true);
  assert.equal(is_allowed(OPENCODE_SURFACE, "plugin/p1.ts"), true);
  assert.equal(is_allowed(OPENCODE_SURFACE, "README.md"), false);
  assert.equal(is_allowed(OPENCODE_SURFACE, "../evil"), false);
});

test("autotrigger:为未触发的 skill 追加触发行,超 cap 跳过", () => {
  const tree: Record<string, string> = {
    "systemprompt.md": "You are careful.",
    "guardrails.md": "Rules.",
    "skills/ledger/SKILL.md": "---\nname: ledger\ndescription: reconcile books.\n---\n",
  };
  const fixed = autotrigger(OPENCODE_SURFACE, tree);
  assert.deepEqual(fixed, ["ledger"]);
  assert.equal(
    tree["guardrails.md"],
    "Rules.\n- When reconcile books, load the `ledger` skill.\n",
  );
});
