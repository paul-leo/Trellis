import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmAndInstall } from "../../src/lib/installAgent.js";

test("confirmAndInstall: agreeing runs the installer with the real package name, argv form", async () => {
  const calls: string[] = [];
  const result = await confirmAndInstall("pi", {
    confirm: async () => true,
    runInstall: (pkg) => calls.push(pkg),
  });
  assert.equal(result.installed, true);
  assert.equal(result.installable, true);
  assert.deepEqual(calls, ["@earendil-works/pi-coding-agent"]);
});

test("confirmAndInstall: declining never runs the installer", async () => {
  const calls: string[] = [];
  const result = await confirmAndInstall("codex", {
    confirm: async () => false,
    runInstall: (pkg) => calls.push(pkg),
  });
  assert.equal(result.installed, false);
  assert.equal(result.installable, true);
  assert.deepEqual(calls, []);
});

test("confirmAndInstall: claude-code resolves its real npm package", async () => {
  const calls: string[] = [];
  await confirmAndInstall("claude-code", { confirm: async () => true, runInstall: (pkg) => calls.push(pkg) });
  assert.deepEqual(calls, ["@anthropic-ai/claude-code"]);
});

test("confirmAndInstall: kiro is never installable, confirm/runInstall never called", async () => {
  let confirmCalled = false;
  let installCalled = false;
  const result = await confirmAndInstall("kiro", {
    confirm: async () => {
      confirmCalled = true;
      return true;
    },
    runInstall: () => {
      installCalled = true;
    },
  });
  assert.equal(result.installable, false);
  assert.equal(result.installed, false);
  assert.equal(confirmCalled, false);
  assert.equal(installCalled, false);
});
