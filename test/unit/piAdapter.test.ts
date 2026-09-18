/**
 * pi adapter's MCP bridge symlink delivery (trellis-pi-mcp-bridge-p4) —
 * against a scratch $HOME, same testing philosophy as every other suite.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { PiAdapter } from "../../src/adapters/pi.js";
import { openBackupSession } from "../../src/lib/backup.js";
import { applyRollbackPlan, collectRollbackPlan, loadManifest } from "../../src/commands/rollback.js";

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-pi-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  return home;
}

function initCanonical(home: string): void {
  mkdirSync(join(home, ".trellis"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
}

test("pi adapter: plan includes exactly one extension item pointing at the real bridge file", async () => {
  const home = scratchHome();
  initCanonical(home);
  const canonical = (await import("../../src/core/canonical.js")).loadCanonicalSource(home);

  const adapter = new PiAdapter(home);
  const plan = await adapter.plan(canonical);
  const extensionItems = plan.filter((i) => i.kind === "extension");
  assert.equal(extensionItems.length, 1);
  assert.equal(extensionItems[0].action, "create");
  assert.ok(extensionItems[0].linkTarget?.includes("pi-bridge"));

  await adapter.apply(plan, openBackupSession(home, "test"));
  const symlinkPath = join(home, ".pi", "agent", "extensions", extensionItems[0].target.split("/").pop()!);
  assert.equal(existsSync(symlinkPath), true);
  assert.equal(readlinkSync(symlinkPath), extensionItems[0].linkTarget);
});

test("pi adapter: re-running against an already-synced home produces no extension create item (idempotent)", async () => {
  const home = scratchHome();
  initCanonical(home);
  const canonical = (await import("../../src/core/canonical.js")).loadCanonicalSource(home);

  const adapter = new PiAdapter(home);
  await adapter.apply(await adapter.plan(canonical), openBackupSession(home, "test"));

  const second = await adapter.plan(canonical);
  assert.deepEqual(
    second.filter((i) => i.kind === "extension" && i.action === "create"),
    [],
  );
});

test("pi adapter: adopts an equivalent bridge symlink from a previous installation root", async () => {
  const home = scratchHome();
  initCanonical(home);
  const canonical = (await import("../../src/core/canonical.js")).loadCanonicalSource(home);
  const adapter = new PiAdapter(home);
  const initial = await adapter.plan(canonical);
  const desired = initial.find((item) => item.kind === "extension")!;
  const symlinkPath = join(home, ".pi", "agent", "extensions", "trellis-mcp-bridge.js");
  const legacyBundle = join(home, "previous-agent-trellis", "dist", "pi-bridge", "bundle.js");
  mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
  mkdirSync(join(home, "previous-agent-trellis", "dist", "pi-bridge"), { recursive: true });
  writeFileSync(legacyBundle, readFileSync(desired.linkTarget!));
  symlinkSync(legacyBundle, symlinkPath);

  const plan = await adapter.plan(canonical);
  const repair = plan.find((item) => item.kind === "extension");
  assert.equal(repair?.action, "create");
  assert.equal(repair?.linkTarget, desired.linkTarget);

  const backup = openBackupSession(home, "test-pi-adoption");
  await adapter.apply(plan.filter((item) => item.kind === "extension"), backup);
  backup.finalize();
  assert.equal(readlinkSync(symlinkPath), desired.linkTarget);

  const backupRuns = readdirSync(join(home, ".trellis", "backups"));
  const manifest = JSON.parse(readFileSync(join(home, ".trellis", "backups", backupRuns[0], "manifest.json"), "utf8"));
  const bridgeOperation = manifest.operations.find((operation: { afterLinkTarget?: string }) => operation.afterLinkTarget === desired.linkTarget);
  assert.equal(bridgeOperation?.kind, "symlink-repair");
  assert.equal(bridgeOperation?.beforeLinkTarget, legacyBundle);
  assert.deepEqual((await adapter.plan(canonical)).filter((item) => item.kind === "extension"), []);

  const rollback = await collectRollbackPlan(home, backupRuns[0]);
  assert.equal(rollback.items.length, 1);
  assert.equal(rollback.items[0].action, "restore");
  await applyRollbackPlan(home, rollback.runId, loadManifest(home, rollback.runId), rollback.items);
  assert.equal(readlinkSync(symlinkPath), legacyBundle);
});

test("pi adapter: a changed bundle at the old installation shape remains a conflict", async () => {
  const home = scratchHome();
  initCanonical(home);
  const canonical = (await import("../../src/core/canonical.js")).loadCanonicalSource(home);
  const adapter = new PiAdapter(home);
  const symlinkPath = join(home, ".pi", "agent", "extensions", "trellis-mcp-bridge.js");
  const foreignBundle = join(home, "foreign", "dist", "pi-bridge", "bundle.js");
  mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
  mkdirSync(join(home, "foreign", "dist", "pi-bridge"), { recursive: true });
  writeFileSync(foreignBundle, "not the Trellis bridge\n");
  symlinkSync(foreignBundle, symlinkPath);

  const plan = await adapter.plan(canonical);
  const conflict = plan.find((item) => item.kind === "extension");
  assert.equal(conflict?.action, "conflict");
  assert.match(conflict?.description ?? "", /not owned by Trellis/);
  const backup = openBackupSession(home, "test-pi-foreign");
  await adapter.apply(plan.filter((item) => item.kind === "extension"), backup);
  backup.finalize();
  assert.equal(readlinkSync(symlinkPath), foreignBundle);
  assert.equal(existsSync(join(home, ".trellis", "backups")), false);
});

test("pi adapter: equivalent relative previous-installation link is repairable", async () => {
  const home = scratchHome();
  initCanonical(home);
  const canonical = (await import("../../src/core/canonical.js")).loadCanonicalSource(home);
  const adapter = new PiAdapter(home);
  const desired = (await adapter.plan(canonical)).find((item) => item.kind === "extension")!;
  const legacyBundle = join(home, "previous", "dist", "pi-bridge", "bundle.js");
  const symlinkPath = desired.target;
  mkdirSync(dirname(symlinkPath), { recursive: true });
  mkdirSync(dirname(legacyBundle), { recursive: true });
  writeFileSync(legacyBundle, readFileSync(desired.linkTarget!));
  symlinkSync(relative(dirname(symlinkPath), legacyBundle), symlinkPath);
  assert.equal((await adapter.plan(canonical)).find((item) => item.kind === "extension")?.action, "create");
});

for (const targetShape of ["bundle.js", "not-dist/pi-bridge/bundle.js", "missing/dist/pi-bridge/bundle.js"]) {
  test(`pi adapter: foreign bridge target ${targetShape} is never adopted`, async () => {
    const home = scratchHome();
    initCanonical(home);
    const canonical = (await import("../../src/core/canonical.js")).loadCanonicalSource(home);
    const adapter = new PiAdapter(home);
    const desired = (await adapter.plan(canonical)).find((item) => item.kind === "extension")!;
    const foreignBundle = join(home, "foreign", targetShape);
    mkdirSync(dirname(desired.target), { recursive: true });
    if (!targetShape.startsWith("missing/")) {
      mkdirSync(dirname(foreignBundle), { recursive: true });
      writeFileSync(foreignBundle, readFileSync(desired.linkTarget!));
    }
    symlinkSync(foreignBundle, desired.target);
    const extensionPlan = (await adapter.plan(canonical)).filter((item) => item.kind === "extension");
    assert.equal(extensionPlan.length, 1);
    assert.equal(extensionPlan[0].action, "conflict");
    const backup = openBackupSession(home, "test-pi-foreign-shape");
    await adapter.apply(extensionPlan, backup);
    backup.finalize();
    assert.equal(readlinkSync(desired.target), foreignBundle);
    assert.equal(existsSync(join(home, ".trellis", "backups")), false);
  });
}
