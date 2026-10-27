/**
 * 13.3 probe 工作区隔离 helper。
 *
 * 场景映射(tasks 13.3 验证锚文):
 *   - "mkdtemp 工作区、staging 渲染配置、重定向 agent 配置 HOME":隔离
 *     工作区为空白 mkdtemp;配置面渲染进 scratch home;spawn env 的 HOME
 *     指向隔离 home,真实 home 与 agent 原生配置逐字节不变;
 *   - "含'无绕过标志'断言的单元测试":probe 启动规格拒绝任何审批/沙盒
 *     绕过标志(与 7.2 引擎侧同一禁令)。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  assertNoBypassFlags,
  createProbeWorkspace,
  probeSpawnSpec,
} from "../../../src/evolve/probeWorkspace.js";
import { scratchHome } from "../../helpers/home.js";

const scratches: string[] = [];
function home(prefix: string): string {
  const dir = scratchHome(prefix);
  scratches.push(dir);
  return dir;
}
after(() => {
  while (scratches.length > 0) {
    const dir = scratches.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** fixture 源 home:一份 agent 原生配置 + canonical 目录 + 凭据/状态
 * 子树(均为明显假内容;凭据形态是占位符,不是真实值)。 */
function seedSourceHome(): string {
  const src = home("trellis-probe-src-");
  writeFileSync(join(src, ".claude.json"), '{"fixture":true}\n');
  mkdirSync(join(src, ".trellis", "skills", "s"), { recursive: true });
  writeFileSync(join(src, ".trellis", "skills", "s", "SKILL.md"), "# fixture skill\n");
  mkdirSync(join(src, ".trellis", "evolve"), { recursive: true });
  writeFileSync(join(src, ".trellis", "evolve", "x.json"), '{"level":"off"}\n');
  mkdirSync(join(src, ".trellis", "mcp", "oauth"), { recursive: true });
  writeFileSync(join(src, ".trellis", "mcp", "oauth", "fixture.json"), '{"token":"placeholder"}\n');
  return src;
}

describe("13.3 probe 工作区隔离", () => {
  it("mkdtemp 工作区 + staging 渲染配置 + 重定向 HOME;源 home 逐字节不变", () => {
    const src = seedSourceHome();
    const before = readFileSync(join(src, ".claude.json"), "utf-8");

    const probe = createProbeWorkspace({ homeDir: src });
    try {
      // 三件套:空白 mkdtemp 工作区(探针自己写文件)。
      assert.ok(existsSync(probe.workspaceDir));
      assert.ok(probe.workspaceDir.startsWith(probe.root));
      // staging 渲染配置:隔离 home 含 agent 原生配置与 canonical。
      assert.equal(
        readFileSync(join(probe.homeDir, ".claude.json"), "utf-8"),
        before,
      );
      // canonical 内容面(skills)进 staging;凭据存储与进化状态子树
      // 被排除——凭据不离开真实 home(作业崩在测量期也不残留 /tmp)。
      assert.ok(existsSync(join(probe.homeDir, ".trellis", "skills", "s", "SKILL.md")));
      assert.ok(!existsSync(join(probe.homeDir, ".trellis", "evolve")));
      assert.ok(!existsSync(join(probe.homeDir, ".trellis", "mcp", "oauth")));
      // 重定向 agent 配置 HOME:spawn env 指向隔离 home。
      assert.equal(probe.env.HOME, probe.homeDir);
      assert.equal(probe.env.XDG_CONFIG_HOME, join(probe.homeDir, ".config"));
      // 源 home 逐字节不变(渲染是复制,不是移动)。
      assert.equal(readFileSync(join(src, ".claude.json"), "utf-8"), before);
    } finally {
      probe.dispose();
    }
    // dispose 删整树。
    assert.ok(!existsSync(probe.root));
    // 源 home 仍在(隔离树的死活不影响真实配置)。
    assert.ok(existsSync(join(src, ".claude.json")));
  });
});

describe("13.3 无绕过标志断言", () => {
  it("probe 启动规格拒绝审批/沙盒绕过标志(含'无绕过标志'断言)", () => {
    const src = seedSourceHome();
    const probe = createProbeWorkspace({ homeDir: src });
    try {
      // 干净规格通过:构造成功且 env 重定向。
      const spec = probeSpawnSpec(["node", "probe.js", "--workspace", probe.workspaceDir], probe.homeDir);
      assert.deepEqual([...spec.argv], ["node", "probe.js", "--workspace", probe.workspaceDir]);
      assert.equal(spec.env.HOME, probe.homeDir);

      // 7.2 同款禁令:dangerous / bypass / skip-permissions / yolo 词面全拒。
      const banned = [
        ["claude", "--dangerously-bypass-approvals-and-sandbox"],
        ["claude", "--dangerously-skip-permissions"],
        ["agent", "--bypass-sandbox"],
        ["agent", "--yolo"],
      ];
      for (const argv of banned) {
        assert.throws(
          () => assertNoBypassFlags(argv),
          /绕过标志/,
          `应拒绝: ${argv.join(" ")}`,
        );
        assert.throws(() => probeSpawnSpec(argv, probe.homeDir), /绕过标志/);
      }
    } finally {
      probe.dispose();
    }
  });
});
