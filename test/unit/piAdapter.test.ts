/**
 * pi adapter's MCP bridge symlink delivery (trellis-pi-mcp-bridge-p4) —
 * against a scratch $HOME, same testing philosophy as every other suite.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiAdapter } from "../../src/adapters/pi.js";

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

  await adapter.apply(plan);
  const symlinkPath = join(home, ".pi", "agent", "extensions", extensionItems[0].target.split("/").pop()!);
  assert.equal(existsSync(symlinkPath), true);
  assert.equal(readlinkSync(symlinkPath), extensionItems[0].linkTarget);
});

test("pi adapter: re-running against an already-synced home produces no extension create item (idempotent)", async () => {
  const home = scratchHome();
  initCanonical(home);
  const canonical = (await import("../../src/core/canonical.js")).loadCanonicalSource(home);

  const adapter = new PiAdapter(home);
  await adapter.apply(await adapter.plan(canonical));

  const second = await adapter.plan(canonical);
  assert.deepEqual(
    second.filter((i) => i.kind === "extension" && i.action === "create"),
    [],
  );
});
