import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { TrellisSubstrate } from "../../../src/evolve/trellisSubstrate.js";
import { TRELLIS_SURFACE } from "../../../src/evolve/surface.js";

// 任务 9.2:materialise(经 host 门面 staging 渲染)与 preflight(doctor
// 级自检)。验证:staging 后真实 canonical 逐字节不变;preflight 故障注入
// (无 canonical / 有 doctor 发现时抛错带修复命令)。

type TreeSnapshot = Record<string, { type: "file" | "dir" | "symlink"; content?: string; target?: string }>;

function snapshotTree(root: string): TreeSnapshot {
  const out: TreeSnapshot = {};
  const walk = (dir: string, rel: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) out[r] = { type: "symlink", target: readlinkSync(abs) };
      else if (st.isDirectory()) { out[r] = { type: "dir" }; walk(abs, r); }
      else out[r] = { type: "file", content: readFileSync(abs, "utf-8") };
    }
  };
  walk(root, "");
  return out;
}

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-sub-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  mkdirSync(join(home, ".trellis", "skills", "existing"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# original\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    "servers:\n  sample:\n    transport: stdio\n    command: node\n",
  );
  writeFileSync(join(home, ".trellis", "scope.yaml"), "skills:\n  existing: [claude-code]\n");
  writeFileSync(join(home, ".trellis", "skills", "existing", "SKILL.md"), "---\nname: existing\ndescription: fixture\n---\n");
  writeFileSync(join(home, ".claude.json"), "{}");
  return home;
}

function fixtureTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "trellis-tree-"));
  writeFileSync(join(dir, "agents.md"), "# evolved\n");
  mkdirSync(join(dir, "skills", "newskill"), { recursive: true });
  writeFileSync(join(dir, "skills", "newskill", "SKILL.md"), "---\nname: newskill\ndescription: added\n---\n");
  mkdirSync(join(dir, "mcp"), { recursive: true });
  writeFileSync(join(dir, "mcp", "routes.yaml"), "claude-code:\n  mode: gateway\n");
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "memory", "policy.yaml"), "lesson-x: [claude-code]\n");
  return dir;
}

test("materialise 把候选树渲染进 staging,真实 canonical 逐字节不变", async () => {
  const home = fixtureHome();
  const before = snapshotTree(home);
  const substrate = new TrellisSubstrate({ homeDir: home });

  const install = await substrate.materialise(fixtureTree(), {}, {});
  try {
    assert.ok(existsSync(install.staging_dir));
    assert.ok(install.fingerprint.startsWith("sha256:"));
    const scratchHome = install.extras.home!;
    assert.ok(scratchHome !== home && existsSync(scratchHome));

    // agents.md 整文件替换
    assert.equal(readFileSync(join(scratchHome, ".trellis", "agents.md"), "utf-8"), "# evolved\n");
    // 新 skill 落盘,既有 skill 保留(staging 先复制再叠加)
    assert.ok(existsSync(join(scratchHome, ".trellis", "skills", "newskill", "SKILL.md")));
    assert.ok(existsSync(join(scratchHome, ".trellis", "skills", "existing", "SKILL.md")));
    // routes.yaml 节级 splice:servers 节原样保留,routes 新增
    const serversYaml = parseYaml(readFileSync(join(scratchHome, ".trellis", "mcp", "servers.yaml"), "utf-8"));
    assert.deepEqual(serversYaml.servers, { sample: { transport: "stdio", command: "node" } });
    assert.deepEqual(serversYaml.routes, { "claude-code": { mode: "gateway" } });
    // memory/policy.yaml → scope.yaml 的 memories 节,skills 节保留
    const scopeYaml = parseYaml(readFileSync(join(scratchHome, ".trellis", "scope.yaml"), "utf-8"));
    assert.deepEqual(scopeYaml.skills, { existing: ["claude-code"] });
    assert.deepEqual(scopeYaml.memories, { "lesson-x": ["claude-code"] });

    // 真实 canonical 逐字节不变
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    substrate.releaseInstall(install);
  }
  assert.ok(!existsSync(install.staging_dir), "releaseInstall disposes the scratch tree");
});

test("materialise 拒绝离 schema 的树路径(不静默丢弃)", async () => {
  const home = fixtureHome();
  const substrate = new TrellisSubstrate({ homeDir: home });
  const tree = fixtureTree();
  // mcp/servers.yaml 是 Class C —— 不在可编辑 schema 内
  writeFileSync(join(tree, "mcp", "servers.yaml"), "servers: {}\n");
  await assert.rejects(
    () => substrate.materialise(tree, {}, {}),
    /outside the editable surface.*mcp\/servers\.yaml/s,
  );
});

test("materialise 的 fingerprint 对同树确定、异树不同", async () => {
  const home = fixtureHome();
  const substrate = new TrellisSubstrate({ homeDir: home });
  const a = await substrate.materialise(fixtureTree(), {}, {});
  const b = await substrate.materialise(fixtureTree(), {}, {});
  assert.equal(a.fingerprint, b.fingerprint);
  substrate.releaseInstall(a);
  substrate.releaseInstall(b);

  const other = fixtureTree();
  writeFileSync(join(other, "agents.md"), "# evolved differently\n");
  const c = await substrate.materialise(other, {}, {});
  assert.notEqual(c.fingerprint, a.fingerprint);
  substrate.releaseInstall(c);
});

test("surface() 返回 9.1 的冻结 schema 单例", () => {
  const substrate = new TrellisSubstrate({ homeDir: fixtureHome() });
  assert.equal(substrate.surface(), TRELLIS_SURFACE);
  assert.equal(substrate.name, "trellis");
});

test("preflight:无 canonical 时抛错并指向 trellis init", async () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-sub-empty-"));
  const substrate = new TrellisSubstrate({ homeDir: home });
  await assert.rejects(() => substrate.preflight(), /trellis init/);
});

test("preflight:doctor 发现存在时抛错,消息带 finding 标识与修复命令", async () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-sub-doctor-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# x\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [codex]\n");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "# ok\n");
  const workspace = mkdtempSync(join(tmpdir(), "trellis-sub-ws-"));
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  writeFileSync(join(workspace, ".codex", "config.toml"), "x = [unclosed\n");

  const substrate = new TrellisSubstrate({ homeDir: home, workspaceRoot: workspace });
  await assert.rejects(
    () => substrate.preflight(),
    /trellis-evolve preflight: \d+ check finding[\s\S]*trellis doctor[\s\S]*workspace-toml-invalid/,
  );
});

test("preflight:干净表面通过;仅有 sync pending 不阻断", async () => {
  const home = fixtureHome();
  const substrate = new TrellisSubstrate({ homeDir: home });
  // fixture 的 canonical 有一个 skill 未渲染到 .claude —— sync --check 会
  // 报 create pending,但 preflight 的通过规则不把它当环境病。
  await substrate.preflight();
});
