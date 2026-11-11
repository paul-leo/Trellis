import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { probePiVersion } from "../../src/probes/pi.js";
import { scratchHome } from "../helpers/home.js";

function shimFixture() {
  const home = scratchHome("pi-probe-version");
  const shim = join(home, ".volta/bin/pi");
  mkdirSync(dirname(shim), {recursive: true});
  writeFileSync(shim, "fixture launcher, not executed\n");
  return {home, shim};
}

test("pi version probe finds the user's Volta launcher when a Node child lacks it on PATH", () => {
  const {home, shim} = shimFixture();
  const calls: string[] = [];
  const run = ((command: string) => {
    calls.push(command);
    if (command === "pi") throw Object.assign(new Error("not on child PATH"), {code: "ENOENT"});
    assert.equal(command, shim);
    return "1.5.2\n";
  }) as typeof execFileSync;
  assert.equal(probePiVersion(home, run), "1.5.2");
  assert.deepEqual(calls, ["pi", shim]);
});

test("pi version probe respects a working PATH installation instead of another managed version", () => {
  const {home} = shimFixture();
  const calls: string[] = [];
  const run = ((command: string) => {calls.push(command); return "1.6.0\n";}) as typeof execFileSync;
  assert.equal(probePiVersion(home, run), "1.6.0");
  assert.deepEqual(calls, ["pi"]);
});

test("pi version probe does not bypass a non-ENOENT failure in the selected executable", () => {
  const {home} = shimFixture();
  const calls: string[] = [];
  const run = ((command: string) => {calls.push(command); throw Object.assign(new Error("not executable"), {code: "EACCES"});}) as typeof execFileSync;
  assert.equal(probePiVersion(home, run), undefined);
  assert.deepEqual(calls, ["pi"]);
});
