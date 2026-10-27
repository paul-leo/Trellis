import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as host from "../../src/host/index.js";
import * as sdk from "../../src/sdk.js";
import { HostEditError, applyEdits, createStaging, readSurface, rollbackSession, runChecks } from "../../src/host/index.js";

// 任务 8.5:`src/host/` 窄门面。四组验证对应 spec 场景:
//   A. 导出面:运行时导出恰为允许清单;静态扫描证明不 re-export
//      adapters/commands(及任何 host 之外层);根入口 sdk 导出不变。
//   B. 多编辑在单备份会话内应用,rollbackSession 逐字节还原。
//   C. staging 复制 + 候选编辑 + 检查后,真实 canonical 与 workspace
//      逐字节不变;账号缓存形态的文件不进 scratch。
//   D. 两次检查按稳定标识可做集合差;workspace-toml-invalid 条目带
//      workspace 层归属;修复 staging 后该条目恰好消失且无新条目。

type TreeSnapshot = Record<string, { type: "file" | "dir" | "symlink"; content?: string; target?: string }>;

/** Byte-faithful recursive snapshot: file bytes, dir presence, symlink
 * targets. `exclude(rel)` skips subtrees (e.g. `.trellis/backups`, which
 * legitimately persists after a rollback). */
function snapshotTree(root: string, exclude?: (rel: string) => boolean): TreeSnapshot {
  const out: TreeSnapshot = {};
  const walk = (dir: string, rel: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (exclude?.(r)) continue;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        out[r] = { type: "symlink", target: readlinkSync(abs) };
      } else if (st.isDirectory()) {
        out[r] = { type: "dir" };
        walk(abs, r);
      } else {
        out[r] = { type: "file", content: readFileSync(abs, "utf-8") };
      }
    }
  };
  walk(root, "");
  return out;
}

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), "trellis-host-"));
}

/** The backup subsystem's own bookkeeping: the run manifests and snapshots
 * legitimately persist after a rollback (they ARE the audit trail), so
 * byte-exactness assertions exclude exactly this — and nothing else, so a
 * stray write elsewhere under `.trellis` would still fail the test. */
const notBackupBookkeeping = (rel: string): boolean =>
  rel === ".trellis" || rel === ".trellis/backups" || rel.startsWith(".trellis/backups/");

/** Minimal canonical: servers.yaml + agents.md + managed.yaml. */
function initCanonical(home: string, managed: string): void {
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "servers: {}\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), managed);
}

// ---------- A. 导出面 ----------

test("host 运行时导出恰为窄门面允许清单", () => {
  assert.deepEqual(Object.keys(host).sort(), [
    "HostEditError",
    "LEVELS",
    "NATIVE_CHECK_SURFACE",
    "applyEdits",
    "classifyManagedObservation",
    "createStaging",
    "describeEvolveLevels",
    "evolveLevelPolicyPath",
    "isMemoryDeliveryEnabled",
    "loadEvolveLevelPolicy",
    "readSurface",
    "resolveEvolveLevel",
    "rollbackSession",
    "runChecks",
    "triggerRenderSync",
    "writeEvolveLevelPolicy",
  ]);
});

test("src/host 不 re-export 任何 host 之外层的符号(含 adapters/commands)", () => {
  const hostDir = new URL("../../src/host/", import.meta.url);
  const offenders: string[] = [];
  for (const name of readdirSync(hostDir)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(new URL(name, hostDir), "utf-8");
    for (const [index, line] of text.split("\n").entries()) {
      if (!/^\s*export\b/.test(line) || !/\bfrom\b/.test(line)) continue;
      const specifier = line.match(/from\s+["']([^"']+)["']/)?.[1];
      if (specifier && !specifier.startsWith("./")) {
        offenders.push(`${name}:${index + 1} re-exports ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("根入口 sdk 运行时导出与此前一致", () => {
  assert.deepEqual(Object.keys(sdk).sort(), ["ALL_AGENTS", "loadCanonicalSource", "resolveScope"]);
});

// ---------- B. 备份会话内应用 + 逐字节回滚 ----------

test("多编辑在单备份会话内应用,rollbackSession 逐字节还原", async () => {
  const home = scratchHome();
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(join(home, "links"), { recursive: true });
  mkdirSync(join(home, "targets"), { recursive: true });
  writeFileSync(join(home, "config", "existing.toml"), "before = true\n");
  writeFileSync(join(home, "targets", "a.txt"), "target a\n");
  writeFileSync(join(home, "targets", "b.txt"), "target b\n");
  symlinkSync(join(home, "targets", "a.txt"), join(home, "links", "repair-me"));
  symlinkSync(join(home, "targets", "a.txt"), join(home, "links", "remove-me"));

  const before = snapshotTree(home, notBackupBookkeeping);

  const result = await applyEdits({
    homeDir: home,
    edits: [
      { op: "write-file", path: join(home, "config", "new.toml"), content: "fresh = 1\n" },
      { op: "write-file", path: join(home, "config", "existing.toml"), content: "before = false\n" },
      { op: "create-symlink", path: join(home, "links", "created"), target: join(home, "targets", "a.txt") },
      { op: "repair-symlink", path: join(home, "links", "repair-me"), target: join(home, "targets", "b.txt") },
      { op: "remove-symlink", path: join(home, "links", "remove-me") },
    ],
  });
  assert.equal(result.applied, 5);

  const afterEdit = snapshotTree(home, notBackupBookkeeping);
  assert.notDeepEqual(afterEdit, before);
  // 备份会话确实落盘且可列
  assert.ok(existsSync(join(home, ".trellis", "backups", result.runId, "manifest.json")));

  const rolledBack = await rollbackSession({ homeDir: home, runId: result.runId });
  assert.equal(rolledBack.runId, result.runId);
  assert.ok(rolledBack.items.every((item) => item.action === "restore"), JSON.stringify(rolledBack.items, null, 2));

  const afterRollback = snapshotTree(home, notBackupBookkeeping);
  assert.deepEqual(afterRollback, before);
});

test("批量编辑中途失败:会话仍 finalize 成可回滚记录,错误携带 runId", async () => {
  const home = scratchHome();
  writeFileSync(join(home, "will-survive.txt"), "original\n");
  const before = snapshotTree(home, notBackupBookkeeping);

  let caught: unknown;
  try {
    await applyEdits({
      homeDir: home,
      edits: [
        { op: "write-file", path: join(home, "will-survive.txt"), content: "overwritten\n" },
        // 父目录不存在 → writeFileSync 抛 ENOENT,批量在此中断
        { op: "write-file", path: join(home, "missing-parent", "x.txt"), content: "never\n" },
      ],
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof HostEditError, `expected HostEditError, got ${String(caught)}`);
  const runId = (caught as HostEditError).runId;
  assert.ok(existsSync(join(home, ".trellis", "backups", runId, "manifest.json")), "partial batch must still be recorded");

  const rolledBack = await rollbackSession({ homeDir: home, runId });
  assert.ok(rolledBack.items.every((item) => item.action === "restore"));
  assert.deepEqual(snapshotTree(home, notBackupBookkeeping), before);
});

// ---------- C. staging 不触碰真实 canonical ----------

test("staging 复制 + 候选编辑 + 检查后,真实 home 与 workspace 逐字节不变", async () => {
  const home = scratchHome();
  initCanonical(home, "agents: [claude-code, codex]\n");
  writeFileSync(join(home, ".claude.json"), "{}");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "# fixture\n");
  // 账号缓存形态的文件:fixture 内容非凭据,仅用于证明它不进 scratch。
  writeFileSync(join(home, ".codex", "auth.json"), '{"note":"fixture placeholder"}\n');

  const workspace = mkdtempSync(join(tmpdir(), "trellis-host-ws-"));
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  writeFileSync(join(workspace, ".codex", "config.toml"), "# workspace fixture\n");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");

  const beforeHome = snapshotTree(home);
  const beforeWorkspace = snapshotTree(workspace);

  const staging = createStaging({ homeDir: home, workspaceRoot: workspace });
  try {
    // scratch 里有检查面,没有账号缓存
    assert.ok(existsSync(join(staging.homeDir, ".trellis", "managed.yaml")));
    assert.ok(existsSync(join(staging.homeDir, ".claude.json")));
    assert.ok(existsSync(join(staging.homeDir, ".codex", "config.toml")));
    assert.ok(!existsSync(join(staging.homeDir, ".codex", "auth.json")), "account cache must never enter staging");
    assert.ok(staging.workspaceRoot !== null);
    assert.ok(existsSync(join(staging.workspaceRoot, ".agents")));
    assert.ok(!existsSync(join(staging.workspaceRoot, ".git")), ".git stays out of staging");
    assert.equal(staging.logicalWorkspaceRoot, workspace);

    // 候选编辑与检查都只发生在 scratch
    await applyEdits({
      homeDir: staging.homeDir,
      edits: [{ op: "write-file", path: join(staging.homeDir, ".trellis", "mcp", "servers.yaml"), content: "servers:\n  candidate: {}\n" }],
    });
    const checks = await runChecks({
      homeDir: staging.homeDir,
      workspaceRoot: staging.workspaceRoot,
      logicalWorkspaceRoot: workspace,
    });
    assert.ok(Array.isArray(checks.entries));
  } finally {
    staging.dispose();
  }
  assert.ok(!existsSync(staging.root), "dispose removes the scratch tree");

  assert.deepEqual(snapshotTree(home), beforeHome);
  assert.deepEqual(snapshotTree(workspace), beforeWorkspace);
});

// ---------- D. 两次检查的集合差与层归属 ----------

test("两次检查按稳定标识可集合差:修复 staging 恰好移除 workspace-toml-invalid", async () => {
  const home = scratchHome();
  initCanonical(home, "agents: [claude-code, codex]\n");
  writeFileSync(join(home, ".claude.json"), "{}");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "# fixture\n");

  const workspace = mkdtempSync(join(tmpdir(), "trellis-host-ws-"));
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  mkdirSync(join(workspace, ".codex"), { recursive: true });
  // 无效 TOML → doctor 的 workspace-toml-invalid
  writeFileSync(join(workspace, ".codex", "config.toml"), "x = [unclosed\n");

  const ids = (result: { entries: Array<{ id: string }> }): string[] => result.entries.map((entry) => entry.id);

  const baseline = await runChecks({ homeDir: home, workspaceRoot: workspace });
  const invalid = baseline.entries.filter((entry) => entry.kind === "workspace-toml-invalid");
  assert.equal(invalid.length, 1, JSON.stringify(baseline.entries, null, 2));
  assert.deepEqual(invalid[0]!.layer, { kind: "workspace", root: workspace });
  // 每条都带层归属
  for (const entry of baseline.entries) {
    assert.ok(entry.layer.kind === "global" || entry.layer.kind === "workspace");
  }

  const staging = createStaging({ homeDir: home, workspaceRoot: workspace });
  try {
    // 未编辑的 staging 与 baseline 的 id 集一致(路径归一化生效)
    const staged = await runChecks({
      homeDir: staging.homeDir,
      workspaceRoot: staging.workspaceRoot,
      logicalWorkspaceRoot: workspace,
    });
    assert.deepEqual(ids(staged), ids(baseline));

    // 在 staging 内修复该 TOML
    assert.ok(staging.workspaceRoot !== null);
    await applyEdits({
      homeDir: staging.homeDir,
      edits: [{ op: "write-file", path: join(staging.workspaceRoot, ".codex", "config.toml"), content: "# fixed\n" }],
    });

    const fixed = await runChecks({
      homeDir: staging.homeDir,
      workspaceRoot: staging.workspaceRoot,
      logicalWorkspaceRoot: workspace,
    });
    const removed = ids(staged).filter((id) => !ids(fixed).includes(id));
    const added = ids(fixed).filter((id) => !ids(staged).includes(id));
    assert.deepEqual(removed, [invalid[0]!.id], "fixing the TOML removes exactly its finding");
    assert.deepEqual(added, [], "no new findings appear from the fix");

    // 真实 workspace 仍是坏的 —— staging 的修复没有泄漏
    assert.equal(readFileSync(join(workspace, ".codex", "config.toml"), "utf-8"), "x = [unclosed\n");
  } finally {
    staging.dispose();
  }
});

// ---------- 读表面 ----------

test("readSurface 只读返回指定层:global 与 workspace 两种形态", () => {
  const home = scratchHome();
  initCanonical(home, "agents: [claude-code]\n");

  const globalRead = readSurface({ homeDir: home });
  assert.deepEqual(globalRead.layer, { kind: "global" });
  assert.deepEqual(globalRead.source.managedAgents, ["claude-code"]);

  const workspace = mkdtempSync(join(tmpdir(), "trellis-host-ws-"));
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  const workspaceRead = readSurface({ homeDir: home, workspaceRoot: workspace });
  assert.deepEqual(workspaceRead.layer, { kind: "workspace", root: workspace });
  assert.equal(workspaceRead.source.workspace?.root, workspace);
});
