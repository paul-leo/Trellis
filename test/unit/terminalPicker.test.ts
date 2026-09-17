/**
 * Verifies the Trellis interaction seam around @clack/prompts. The tests
 * assert semantic results and stream behavior, not cursor frames or spinner
 * animation details owned by the prompt library.
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  canUseInteractivePicker,
  nextIndex,
  runMultiSelectPicker,
  runSingleSelectPicker,
  toggled,
} from "../../src/lib/terminalPicker.js";

function outputStream(): PassThrough {
  const output = new PassThrough();
  output.on("data", () => {});
  return output;
}

test("nextIndex: wraps in both directions", () => {
  assert.equal(nextIndex(2, 1, 3), 0);
  assert.equal(nextIndex(0, -1, 3), 2);
});

test("toggled: flips only the targeted index without mutation", () => {
  const original = [false, false, false];
  assert.deepEqual(toggled(original, 1), [false, true, false]);
  assert.deepEqual(original, [false, false, false]);
});

test("canUseInteractivePicker: requires TTY input, TTY output, and raw mode", () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  assert.equal(canUseInteractivePicker({ input, output }), false);

  (input as unknown as { isTTY: boolean }).isTTY = true;
  (input as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (output as unknown as { isTTY: boolean }).isTTY = true;
  assert.equal(canUseInteractivePicker({ input, output }), true);
});

test("runSingleSelectPicker: returns the selected index through injected streams", async () => {
  const input = new PassThrough();
  const resultPromise = runSingleSelectPicker(["claude-code", "codex"], { input, output: outputStream() });
  input.write("\u001b[B");
  input.write("\r");
  assert.equal(await resultPromise, 1);
});

test("runSingleSelectPicker: Ctrl+C returns null", async () => {
  const input = new PassThrough();
  const resultPromise = runSingleSelectPicker(["claude-code", "codex"], { input, output: outputStream() });
  input.write("\u0003");
  assert.equal(await resultPromise, null);
});

test("runMultiSelectPicker: respects initial values and toggles", async () => {
  const input = new PassThrough();
  const resultPromise = runMultiSelectPicker(["claude-code", "codex", "kiro"], [true, false, true], {
    input,
    output: outputStream(),
  });
  input.write(" ");
  input.write("\u001b[B");
  input.write(" ");
  input.write("\r");
  assert.deepEqual(await resultPromise, [1, 2]);
});

test("runMultiSelectPicker: Ctrl+C returns null", async () => {
  const input = new PassThrough();
  const resultPromise = runMultiSelectPicker(["claude-code", "codex"], [false, false], { input, output: outputStream() });
  input.write("\u0003");
  assert.equal(await resultPromise, null);
});
