/**
 * `evolve enable|disable` 与扩展清单同步(design 8.1 的生产接线):
 * 级别升至 observe 及以上时写入 `~/.trellis/mcp/extensions.yaml` 条目,
 * 置回 off 时移除;粒度覆盖(any-of)下条目保留。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { runEvolveCommand } from "../../../src/commands/evolve.js";
import { EVOLVE_EXTENSION_ID, evolveExtensionLoadSpecifier } from "../../../src/evolve/extension.js";
import { writeEvolveLevelPolicy, loadEvolveLevelPolicy } from "../../../src/host/index.js";
import { extensionsManifestPath, upsertExtensionEntry } from "../../../src/lib/hostExtensions.js";
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

function manifestText(h: string): string {
  const path = extensionsManifestPath(h);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

test("enable 写入级别策略 + 清单条目;disable 双双收回(8.1)", async () => {
  const h = home("enable-manifest");
  const enabled = await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
  assert.equal(enabled.exitCode, 0);

  const text = manifestText(h);
  assert.match(text, new RegExp(`id: ${EVOLVE_EXTENSION_ID}`), "enable 写入清单条目");
  assert.match(text, /load: /, "条目带 load 说明符");
  assert.ok(text.includes(evolveExtensionLoadSpecifier()), "load 指向 activate 模块");

  const disabled = await runEvolveCommand(["disable"], { homeDir: h, isTTY: true });
  assert.equal(disabled.exitCode, 0);
  assert.doesNotMatch(manifestText(h), new RegExp(`id: ${EVOLVE_EXTENSION_ID}`), "disable 移除条目");
});

test("粒度:default off 但 workspace observe → 条目保留(any-of 规则)", async () => {
  const h = home("enable-manifest-granular");
  // 手工设 workspace 覆盖(命令面只动 default;粒度覆盖是策略既有能力)。
  writeEvolveLevelPolicy(h, {
    defaultLevel: undefined,
    agents: {},
    workspaces: { [join("/tmp", "ws-observe")]: "observe" },
  });
  const disabled = await runEvolveCommand(["disable"], { homeDir: h, isTTY: true });
  assert.equal(disabled.exitCode, 0);
  assert.match(manifestText(h), new RegExp(`id: ${EVOLVE_EXTENSION_ID}`), "仍有 observe 覆盖 → 条目保留");
});

test("enable 两次 upsert 幂等:同 id 单条目", async () => {
  const h = home("enable-manifest-idempotent");
  await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
  await runEvolveCommand(["enable", "--level", "propose"], { homeDir: h, isTTY: true });
  const text = manifestText(h);
  assert.equal((text.match(/id:/g) ?? []).length, 1, "同 id 不重复");
  assert.equal(loadEvolveLevelPolicy(h).defaultLevel, "propose");
});

test("清单内其他条目不被 enable/disable 触碰", async () => {
  const h = home("enable-manifest-others");
  upsertExtensionEntry(h, { id: "third-party", load: "/tmp/third.js" });
  await runEvolveCommand(["enable"], { homeDir: h, isTTY: true });
  await runEvolveCommand(["disable"], { homeDir: h, isTTY: true });
  const text = manifestText(h);
  assert.match(text, /id: third-party/, "他条目保留");
  assert.doesNotMatch(text, new RegExp(`id: ${EVOLVE_EXTENSION_ID}`));
});
