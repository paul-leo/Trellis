import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Install, RunRequest } from "@trellis/evolve-engine";
import { TrellisSubstrate } from "../../../src/evolve/trellisSubstrate.js";
import { renderSessionEvents } from "../../../src/evolve/trajectory.js";

// 任务 9.3:execute(委托 launcher body 拉起探针会话)与 read_trajectory
// (会话记录渲染为共享语法)。验证:轨迹渲染 golden fixture;execute 交给
// launcher 的 install 指向 scratch(materialise 的 staging),不含真实
// home/workspace 的任何路径 —— 探针工作区不含工作区之外的用户数据。
// 测试绝不 spawn 真实 agent CLI:launcher 一律用桩。

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-sub93-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# original\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(join(home, ".claude.json"), "{}");
  return home;
}

function fixtureTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-tree93-"));
  writeFileSync(join(dir, "agents.md"), "# evolved\n");
  return dir;
}

// ---------- read_trajectory ----------

test("轨迹渲染 golden fixture:捕获流转共享语法逐字节一致", async () => {
  const substrate = new TrellisSubstrate({ homeDir: fixtureHome() });
  const rendered = await substrate.read_trajectory(
    new URL("session-stream.jsonl", FIXTURES).pathname,
    { obs_trunc: 500, max_chars: 20000 },
  );
  const golden = readFileSync(new URL("session-trajectory.golden.md", FIXTURES), "utf-8");
  assert.equal(rendered, golden);
});

test("轨迹渲染截断语义:obs/args/max_chars 三级帽", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-traj-"));
  const stream = join(dir, "stream.jsonl");
  writeFileSync(stream, [
    JSON.stringify({ type: "text", text: "a".repeat(50) }),
    JSON.stringify({ type: "tool_call", name: "Write", input: { p: "b".repeat(40) }, status: "ok", output: "c".repeat(60) }),
  ].join("\n") + "\n");

  const rendered = renderSessionEvents(stream, { obsTrunc: 20, argsTrunc: 12, maxChars: 10000 });
  const lines = rendered.split("\n");
  assert.equal(lines[0], `[ASSISTANT] ${"a".repeat(20)}…(+30 chars — render truncation)`);
  // args: {"p":" + 40 个 b + "} = 48 字符,截到 12 后标记得 +36;
  // 末尾两个右括号:截断标记自己的 ) + ACTION 调用的 )
  assert.equal(lines[1], `[ACTION] Write({"p":"bbbbbb…(+36 chars — render truncation))`);
  assert.equal(lines[2], `[OBSERVATION] ${"c".repeat(20)}…(+40 chars — render truncation)`);

  const capped = renderSessionEvents(stream, { obsTrunc: 500, argsTrunc: 400, maxChars: 30 });
  assert.ok(capped.length > 30, "cap marker itself extends past the cap");
  assert.ok(capped.endsWith(" chars — render truncation)"));
});

test("轨迹渲染:空流与缺失文件的收口", () => {
  const dir = mkdtempSync(join(tmpdir(), "trellis-traj-"));
  const empty = join(dir, "empty.jsonl");
  writeFileSync(empty, "not json\n[1,2,3]\n\n");
  assert.equal(renderSessionEvents(empty, { obsTrunc: 10, maxChars: 100 }), "(no parseable events in trajectory)");
  assert.ok(renderSessionEvents(join(dir, "missing.jsonl"), { obsTrunc: 10, maxChars: 100 }).startsWith("(failed to read trajectory:"));
});

// ---------- execute ----------

test("execute:无 launcher 即报错,不存在隐式默认 runner", async () => {
  const substrate = new TrellisSubstrate({ homeDir: fixtureHome() });
  const install = await substrate.materialise(fixtureTree(), {}, {});
  try {
    await assert.rejects(
      () => substrate.execute("task-1", install, ["r1"], 30),
      /without a launcher body/,
    );
  } finally {
    substrate.releaseInstall(install);
  }
});

test("execute:请求逐字段委托 launcher(timeout 取整),返回 run_dir 透传", async () => {
  const seen: { req?: RunRequest; install?: Install } = {};
  const substrate = new TrellisSubstrate({
    homeDir: fixtureHome(),
    launcher: async (req, install) => {
      seen.req = req;
      seen.install = install;
      return req.run_ids.map((id) => join("/probe-runs", id));
    },
  });
  const install = await substrate.materialise(fixtureTree(), {}, {});
  try {
    const dirs = await substrate.execute("task-1", install, ["r1", "r2"], 30.7);
    assert.deepEqual(dirs, ["/probe-runs/r1", "/probe-runs/r2"]);
    assert.equal(seen.req!.task_ref, "task-1");
    assert.deepEqual(seen.req!.run_ids, ["r1", "r2"]);
    assert.equal(seen.req!.timeout, 30);
    assert.equal(seen.install, install);
  } finally {
    substrate.releaseInstall(install);
  }
});

test("execute 交给 launcher 的 install 指向 scratch,不含真实 home/workspace 路径", async () => {
  const home = fixtureHome();
  const workspace = mkdtempSync(join(tmpdir(), "trellis-sub93-ws-"));
  mkdirSync(join(workspace, ".agents"), { recursive: true });

  let seenInstall: Install | undefined;
  const substrate = new TrellisSubstrate({
    homeDir: home,
    workspaceRoot: workspace,
    launcher: async (_req, install) => {
      seenInstall = install;
      return [];
    },
  });
  const install = await substrate.materialise(fixtureTree(), {}, {});
  try {
    await substrate.execute("task-1", install, ["r1"], 30);
    const exposed = JSON.stringify(seenInstall);
    assert.ok(!exposed.includes(home), "real home must not leak into the install handed to the probe");
    assert.ok(!exposed.includes(workspace), "real workspace must not leak into the install");
    // staging_dir 罩住 home 与 workspace 两个 scratch
    assert.ok(seenInstall!.extras.home!.startsWith(seenInstall!.staging_dir));
    assert.ok(seenInstall!.extras.workspace!.startsWith(seenInstall!.staging_dir));
  } finally {
    substrate.releaseInstall(install);
  }
});
