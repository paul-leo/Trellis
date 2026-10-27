// 任务 4.2 验证(部分):穷人沙盒语义——每次调用独立临时目录、失败清理、
// harvest 子路径完整、超时进程确实被杀。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditStem,
  copyTree,
  harvestSubpath,
  runWithTimeout,
  safeLabel,
  TimeoutExpiredError,
  withSessionWorkspace,
} from "../src/sandbox.js";

test("sandbox: 每次调用独立临时目录", async () => {
  const seen: string[] = [];
  await withSessionWorkspace(async (tmp1) => {
    seen.push(tmp1);
    assert.ok(!(await exists(join(tmp1, "context"))), "无 contextDir 时不拷 context");
    await withSessionWorkspace(async (tmp2) => {
      seen.push(tmp2);
      assert.notEqual(tmp1, tmp2, "嵌套调用也各自独立");
    });
  });
  const third = await withSessionWorkspace(async (tmp3) => {
    seen.push(tmp3);
    return tmp3;
  });
  assert.notEqual(third, seen[0]);
  assert.equal(new Set(seen).size, 3, "三个会话三个目录");
});

test("sandbox: 失败清理——fn 抛错后临时目录仍被删除", async () => {
  let captured = "";
  await assert.rejects(
    withSessionWorkspace(async (tmp) => {
      captured = tmp;
      await fs.writeFile(join(tmp, "junk.txt"), "x", "utf8");
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(captured, "拿到了 tmp 路径");
  assert.ok(!(await exists(captured)), `失败后 tmp 已清理: ${captured}`);
});

test("sandbox: contextDir 拷入 <tmp>/context(copytree dirs_exist_ok 语义)", async () => {
  const src = await fs.mkdtemp(join(tmpdir(), "ctx-src-"));
  await fs.mkdir(join(src, "harness", "scripts"), { recursive: true });
  await fs.writeFile(join(src, "harness", "a.md"), "A", "utf8");
  await fs.writeFile(join(src, "harness", "scripts", "s.py"), "print(1)", "utf8");
  try {
    await withSessionWorkspace(
      async (tmp) => {
        assert.equal(
          await fs.readFile(join(tmp, "context", "harness", "a.md"), "utf8"),
          "A",
        );
        assert.equal(
          await fs.readFile(join(tmp, "context", "harness", "scripts", "s.py"), "utf8"),
          "print(1)",
        );
      },
      { contextDir: src },
    );
  } finally {
    await fs.rm(src, { recursive: true, force: true });
  }
});

test("sandbox: harvest 子路径完整(嵌套结构全收,兄弟节点不收)", async () => {
  const audit = await fs.mkdtemp(join(tmpdir(), "audit-"));
  const dest = await withSessionWorkspace(
    async (tmp) => {
      await fs.mkdir(join(tmp, "context", "harness", "skills", "demo"), { recursive: true });
      await fs.writeFile(join(tmp, "context", "harness", "root.md"), "ROOT", "utf8");
      await fs.writeFile(
        join(tmp, "context", "harness", "skills", "demo", "SKILL.md"),
        "SK",
        "utf8",
      );
      await fs.mkdir(join(tmp, "context", "other"), { recursive: true });
      await fs.writeFile(join(tmp, "context", "other", "nope.md"), "NOPE", "utf8");
      return harvestSubpath(tmp, "context/harness", "ledger 1/agg1", {
        auditDir: audit,
        cacheKey: "abc",
      });
    },
  );
  try {
    assert.ok(dest, "harvest 有产物");
    assert.equal(
      dest,
      join(audit, "ledger_1_agg1.abc.workspace"),
      "safeLabel + cacheKey 命名",
    );
    assert.equal(await fs.readFile(join(dest!, "root.md"), "utf8"), "ROOT");
    assert.equal(
      await fs.readFile(join(dest!, "skills", "demo", "SKILL.md"), "utf8"),
      "SK",
    );
    assert.ok(!(await exists(join(dest!, "nope.md"))), "兄弟节点不随 harvest");
  } finally {
    await fs.rm(audit, { recursive: true, force: true });
  }
});

test("sandbox: harvest 对非目录子路径返回 null", async () => {
  await withSessionWorkspace(async (tmp) => {
    await fs.mkdir(join(tmp, "context"), { recursive: true });
    await fs.writeFile(join(tmp, "context", "file.txt"), "x", "utf8");
    assert.equal(await harvestSubpath(tmp, "context/file.txt", "lab"), null);
    assert.equal(await harvestSubpath(tmp, "context/missing", "lab"), null);
  });
});

test("sandbox: 超时进程确实被杀(runWithTimeout + TimeoutExpiredError)", async () => {
  const t0 = Date.now();
  await assert.rejects(
    runWithTimeout("sleep", ["30"], { wall: 1 }),
    (e: unknown) => {
      assert.ok(e instanceof TimeoutExpiredError, "错误类型可识别");
      assert.equal((e as TimeoutExpiredError).wall, 1);
      const pid = (e as TimeoutExpiredError).pid;
      assert.ok(typeof pid === "number" && pid > 0, "带 pid 供验证");
      // 进程已死:kill(pid, 0) 应报 ESRCH。
      const probe = spawnSync("kill", ["-0", String(pid)]);
      assert.notEqual(probe.status, 0, `pid=${pid} 已不存在`);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 5000, "超时在 wall 附近触发,而非等满 sleep");
});

test("sandbox: runWithTimeout 正常结束返回 stdout/stderr/退出码", async () => {
  const r = await runWithTimeout("sh", ["-c", "echo out; echo err 1>&2; exit 3"], {
    wall: 10,
  });
  assert.equal(r.stdout, "out\n");
  assert.equal(r.stderr, "err\n");
  assert.equal(r.code, 3);
});

test("sandbox: safeLabel / auditStem 与 Python re.sub 一致", () => {
  assert.equal(safeLabel("ledger 1/agg1"), "ledger_1_agg1");
  assert.equal(safeLabel("demo-oc-agg2/ledger-1/agg1"), "demo-oc-agg2_ledger-1_agg1");
  assert.equal(safeLabel("keep.this-name_1"), "keep.this-name_1");
  assert.equal(safeLabel("  spaces  "), "_spaces_");
  assert.equal(auditStem("a b", ""), "a_b");
  assert.equal(auditStem("a b", "k"), "a_b.k");
});

test("sandbox: copyTree 全量拷贝(dirs_exist_ok)", async () => {
  const src = await fs.mkdtemp(join(tmpdir(), "cp-src-"));
  const dst = await fs.mkdtemp(join(tmpdir(), "cp-dst-"));
  try {
    await fs.mkdir(join(src, "x"), { recursive: true });
    await fs.writeFile(join(src, "x", "1.txt"), "1", "utf8");
    await fs.writeFile(join(dst, "keep.txt"), "K", "utf8");
    await copyTree(src, dst);
    assert.equal(await fs.readFile(join(dst, "x", "1.txt"), "utf8"), "1");
    assert.equal(await fs.readFile(join(dst, "keep.txt"), "utf8"), "K", "目标已有内容保留");
  } finally {
    await fs.rm(src, { recursive: true, force: true });
    await fs.rm(dst, { recursive: true, force: true });
  }
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
