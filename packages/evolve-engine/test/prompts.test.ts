// 任务 4.1 验证:prompts 移植与 Python 原版逐字节一致(生成 fixture 对照)。
// fixture 由 scripts/gen-prompt-fixtures.py 用 harness2/core/prompts.py 原版生成。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  aggregate,
  compose_round,
  experience,
  propose,
  select,
} from "../src/prompts.js";
import { makeBenchPrompts, type BenchPrompts } from "../src/spec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "prompts");

// 与 gen-prompt-fixtures.py 中的 BP_DEMO / BP_FULL / BP_TTS 同构。
const BP_DEMO: BenchPrompts = makeBenchPrompts({
  work: "Reconcile the ledger workbook and write a closing memo.",
  domain_word: "ledger",
  inv_levers: "- prefer a script for CSV normalisation",
  dom_levers: "- name the source of record",
  deliverable_word: "closing memo",
});

const BP_FULL: BenchPrompts = makeBenchPrompts({
  work: "Draft the engagement letter from the intake notes.",
  domain_word: "matter",
  inv_levers: "- check the file write before finishing",
  dom_levers: "- never invent a clause",
  yardstick: "A good run re-reads what it wrote.",
  deliverable_word: "letter",
  domain_guidance: "Engagement letters follow the firm's plain-language rule.",
  selection_checks: "Every party name matches the intake sheet.",
  selection_lead: "Requested sections all present, in the asked order.",
  selection_conformance: "value_only",
});

const BP_TTS: BenchPrompts = makeBenchPrompts({
  work: "Summarise the workshop transcript into action items.",
  domain_word: "workshop",
  inv_levers: "- keep always-on text tiny",
  dom_levers: "- quote the transcript, do not paraphrase commitments",
  deliverable_word: "action list",
  prompt_pack: "tts",
});

type Case = [string, () => string];

const CASES: Case[] = [
  ["propose-adapt-inv-k1", () => propose(BP_DEMO, "INV", "opencode")],
  ["propose-adapt-dom-k2", () => propose(BP_DEMO, "DOM", "opencode", { k: 2, index: 2 })],
  [
    "propose-adapt-inv-round2",
    () => propose(BP_DEMO, "INV", "opencode", { k: 2, index: 1, round_t: 2 }),
  ],
  ["propose-codex-dom-k1", () => propose(BP_DEMO, "DOM", "codex")],
  ["propose-full-dom-k1", () => propose(BP_FULL, "DOM", "opencode")],
  ["propose-tts-inv-k2", () => propose(BP_TTS, "INV", "opencode", { k: 2, index: 1 })],
  ["propose-tts-dom-k1", () => propose(BP_TTS, "DOM", "codex")],
  ["aggregate-adapt-k1", () => aggregate(BP_DEMO, "opencode")],
  ["aggregate-adapt-k2", () => aggregate(BP_FULL, "opencode", { k: 2 })],
  ["aggregate-tts-k2", () => aggregate(BP_TTS, "opencode", { k: 2, index: 2 })],
  ["compose-round-t1-of-3", () => compose_round(BP_DEMO, "opencode", { t: 1, k: 3 })],
  ["compose-round-t3-of-3", () => compose_round(BP_DEMO, "opencode", { t: 3, k: 3 })],
  ["select-mixed-full", () => select(BP_DEMO, 4, "mixed")],
  [
    "select-finals-value-only",
    () =>
      select(BP_FULL, 3, "finals", "\n    context/candidates/<id>.png  rendered preview\n"),
  ],
  ["select-tts-mixed", () => select(BP_TTS, 2, "mixed")],
  ["experience-demo", () => experience(BP_DEMO)],
];

test("fixture 目录恰好覆盖全部用例", async () => {
  const files = (await readdir(FIXTURES)).filter((f) => f.endsWith(".txt")).sort();
  assert.deepEqual(
    files,
    CASES.map(([name]) => `${name}.txt`).sort(),
  );
});

for (const [name, fn] of CASES) {
  test(`逐字节一致: ${name}`, async () => {
    const want = await readFile(join(FIXTURES, `${name}.txt`), "utf8");
    const got = fn();
    if (got !== want) {
      // 显示首个分歧点便于排障
      let i = 0;
      while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
      assert.fail(
        `与原版分歧于 offset ${i}:\n--- want ---\n${JSON.stringify(want.slice(i, i + 80))}\n--- got ---\n${JSON.stringify(got.slice(i, i + 80))}`,
      );
    }
    assert.equal(got, want);
  });
}

test("错误路径:未知维度、未知 surface、未知 pool_kind", () => {
  assert.throws(() => propose(BP_DEMO, "XYZ", "opencode"), /unknown proposal dimension 'XYZ'/);
  assert.throws(
    () => propose(BP_DEMO, "INV", "solaris"),
    /no prompt surface for 'solaris'; known: \['codex', 'opencode'\]/,
  );
  assert.throws(() => select(BP_DEMO, 2, "mixed-mixed"), /unknown pool_kind 'mixed-mixed'/);
});

test("BenchPrompts 禁词:描述工作而非度量", () => {
  assert.throws(
    () => makeBenchPrompts({ work: "Follow the scoring rubric." }),
    /found 'rubric'/,
  );
  assert.throws(
    () => makeBenchPrompts({ work: "Write the memo.", yardstick: "matches the benchmark" }),
    /found 'benchmark'/,
  );
});
