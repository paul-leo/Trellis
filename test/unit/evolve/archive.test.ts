/**
 * 运行档案与状态目录测试(trellis-evolve 任务 10.4)。
 *
 * 覆盖:档案往返、只追加语义(不覆盖/不重排/不去重)、读取零副作用、
 * 坏行硬错误、状态目录骨架与 canonical 分离、.gitignore 如适用。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appendArchiveRecord, archiveRecordsPath, readArchiveRecords } from "../../../src/evolve/archive.js";
import {
  ensureEvolveStateDir,
  ensureStateGitignored,
  evolveStateDir,
  EVOLVE_STATE_SUBDIRS,
} from "../../../src/evolve/stateDir.js";
import { scratchHome } from "../../helpers/home.js";

test("档案往返:追加多条读回一致,顺序与层归属保留", () => {
  const home = scratchHome("archive-roundtrip");
  const fixedNow = () => new Date("2026-10-25T08:00:00.000Z");

  const records = [
    {
      kind: "proposal",
      payload: {
        id: "p-1",
        layer: { kind: "workspace", root: "/tmp/ws-alpha" },
        edits: [{ op: "write-file", path: "/tmp/ws-alpha/.codex/config.toml", content: "# fixed\n" }],
        riskClass: "B",
      },
    },
    {
      kind: "verdict",
      payload: {
        id: "v-1",
        layer: { kind: "global" },
        baseline: [{ id: "workspace-toml-invalid", layer: { kind: "workspace", root: "/tmp/ws-alpha" } }],
        candidate: [],
      },
    },
    {
      kind: "lesson",
      payload: { cue: "workspace-toml-invalid", body: "先看 .codex/config.toml 是否闭合", confidence: 0.8, layer: { kind: "global" } },
    },
  ];

  const written = records.map((record) => appendArchiveRecord(home, record, fixedNow));
  assert.deepEqual(
    written.map((entry) => entry.recordedAt),
    ["2026-10-25T08:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-25T08:00:00.000Z"],
  );

  assert.deepEqual(readArchiveRecords(home), written);
});

test("只追加:不覆盖、不重排、不去重", () => {
  const home = scratchHome("archive-append-only");
  const a = appendArchiveRecord(home, { kind: "probe", payload: { id: "run-1" } });
  const b = appendArchiveRecord(home, { kind: "probe", payload: { id: "run-2" } });
  // 与 a 同 kind 同 payload 仍是一条新记录。
  const a2 = appendArchiveRecord(home, { kind: "probe", payload: { id: "run-1" } });

  const entries = readArchiveRecords(home);
  assert.deepEqual(entries, [a, b, a2]);
  // 行数恰为 3(追加而非重写整个文件)。
  const lines = readFileSync(archiveRecordsPath(home), "utf-8").split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 3);
});

test("读取零副作用:无档案返回空且不建目录", () => {
  const home = scratchHome("archive-read-zero");
  assert.deepEqual(readArchiveRecords(home), []);
  assert.equal(existsSync(evolveStateDir(home)), false);
});

test("坏行硬错误:空行/非法 JSON/缺字段都带行号抛出", () => {
  const home = scratchHome("archive-corrupt");
  ensureEvolveStateDir(home);
  const path = archiveRecordsPath(home);
  writeFileSync(path, '{"kind":"ok","recordedAt":"2026-10-25T08:00:00.000Z","payload":{}}\nnot-json\n');
  assert.throws(() => readArchiveRecords(home), /第 2 行不是合法 JSON/);

  writeFileSync(path, '{"kind":"ok","recordedAt":"2026-10-25T08:00:00.000Z","payload":{}}\n\n');
  assert.throws(() => readArchiveRecords(home), /第 2 行为空行/);

  writeFileSync(path, '{"kind":"ok"}\n');
  assert.throws(() => readArchiveRecords(home), /第 1 行缺少/);
});

test("状态目录骨架幂等,且档案写入与 canonical 面分离", () => {
  const home = scratchHome("archive-separate");
  // canonical 面 marker:档案写入不得触碰。
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(join(home, ".trellis", "agents.md"), "# global\n");
  const beforeCanonical = {
    managed: readFileSync(join(home, ".trellis", "managed.yaml"), "utf-8"),
    agents: readFileSync(join(home, ".trellis", "agents.md"), "utf-8"),
  };

  const root = ensureEvolveStateDir(home);
  assert.equal(root, join(home, ".trellis", "evolve"));
  for (const name of EVOLVE_STATE_SUBDIRS) assert.equal(existsSync(join(root, name)), true);
  ensureEvolveStateDir(home); // 幂等
  assert.equal(existsSync(join(root, "signals")), true);

  appendArchiveRecord(home, { kind: "proposal", payload: { id: "p-1" } });
  assert.equal(existsSync(archiveRecordsPath(home)), true);
  // 档案只落在 evolve/ 下;canonical 逐字节不变。
  assert.equal(readFileSync(join(home, ".trellis", "managed.yaml"), "utf-8"), beforeCanonical.managed);
  assert.equal(readFileSync(join(home, ".trellis", "agents.md"), "utf-8"), beforeCanonical.agents);
});

test(".gitignore 如适用:在 git work tree 内写 evolve/ 且幂等,否则零副作用", () => {
  // 适用:状态根在 git work tree(dotfiles 仓库形态)。
  const inRepo = scratchHome("archive-gitignore-yes");
  mkdirSync(join(inRepo, ".trellis"), { recursive: true });
  mkdirSync(join(inRepo, ".git"), { recursive: true });
  assert.equal(ensureStateGitignored(inRepo), "added");
  assert.equal(readFileSync(join(inRepo, ".trellis", ".gitignore"), "utf-8"), "evolve/\n");
  assert.equal(ensureStateGitignored(inRepo), "present");
  assert.equal(readFileSync(join(inRepo, ".trellis", ".gitignore"), "utf-8"), "evolve/\n");

  // 不适用:不在任何 work tree —— 不创建 .gitignore。
  const plain = scratchHome("archive-gitignore-no");
  mkdirSync(join(plain, ".trellis"), { recursive: true });
  assert.equal(ensureStateGitignored(plain), "not-a-repo");
  assert.equal(existsSync(join(plain, ".trellis", ".gitignore")), false);
});
