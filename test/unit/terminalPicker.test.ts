/**
 * Exercises the real key-parsing/render/state-machine loop against
 * plain `PassThrough` streams — no real TTY needed, since `PickerStreams`
 * is an injectable seam (trellis-onboard-interactive-picker design.md).
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { canUseInteractivePicker, nextIndex, runMultiSelectPicker, runSingleSelectPicker, toggled } from "../../src/lib/terminalPicker.js";

function discardOutput(): PassThrough {
  const out = new PassThrough();
  out.on("data", () => {});
  return out;
}

test("nextIndex: wraps forward past the end", () => {
  assert.equal(nextIndex(2, 1, 3), 0);
});

test("nextIndex: wraps backward past the start", () => {
  assert.equal(nextIndex(0, -1, 3), 2);
});

test("nextIndex: moves normally within bounds", () => {
  assert.equal(nextIndex(1, 1, 3), 2);
});

test("toggled: flips only the targeted index, doesn't mutate the input array", () => {
  const original = [false, false, false];
  const next = toggled(original, 1);
  assert.deepEqual(next, [false, true, false]);
  assert.deepEqual(original, [false, false, false]);
});

test("canUseInteractivePicker: false when input lacks setRawMode", () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  assert.equal(canUseInteractivePicker({ input, output }), false);
});

test("canUseInteractivePicker: true only when both streams are TTYs and input supports raw mode", () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  (input as unknown as { isTTY: boolean }).isTTY = true;
  (input as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (output as unknown as { isTTY: boolean }).isTTY = true;
  assert.equal(canUseInteractivePicker({ input, output }), true);
});

test("canUseInteractivePicker: false when output isn't a TTY, even if input is capable", () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  (input as unknown as { isTTY: boolean }).isTTY = true;
  (input as unknown as { setRawMode: () => void }).setRawMode = () => {};
  assert.equal(canUseInteractivePicker({ input, output }), false);
});

test("runSingleSelectPicker: Down then Enter resolves the next index", async () => {
  const input = new PassThrough();
  const resultPromise = runSingleSelectPicker(["a", "b", "c"], { input, output: discardOutput() });
  input.write("\u001b[B");
  input.write("\r");
  assert.equal(await resultPromise, 1);
});

test("runSingleSelectPicker: navigation wraps around both ends", async () => {
  const input = new PassThrough();
  const resultPromise = runSingleSelectPicker(["a", "b", "c"], { input, output: discardOutput() });
  input.write("\u001b[A"); // up from index 0 wraps to the last row
  input.write("\r");
  assert.equal(await resultPromise, 2);
});

test("runSingleSelectPicker: j/k are accepted the same as arrow keys", async () => {
  const input = new PassThrough();
  const resultPromise = runSingleSelectPicker(["a", "b", "c"], { input, output: discardOutput() });
  input.write("j");
  input.write("j");
  input.write("\n");
  assert.equal(await resultPromise, 2);
});

test("runSingleSelectPicker: Ctrl+C resolves null, distinct from any valid index", async () => {
  const input = new PassThrough();
  const resultPromise = runSingleSelectPicker(["a", "b"], { input, output: discardOutput() });
  input.write("\u0003");
  assert.equal(await resultPromise, null);
});

test("runMultiSelectPicker: toggling the highlighted row then confirming resolves that index", async () => {
  const input = new PassThrough();
  const resultPromise = runMultiSelectPicker(["a", "b"], [false, false], { input, output: discardOutput() });
  input.write(" ");
  input.write("\r");
  assert.deepEqual(await resultPromise, [0]);
});

test("runMultiSelectPicker: initial checked state survives an untouched confirm", async () => {
  const input = new PassThrough();
  const resultPromise = runMultiSelectPicker(["a", "b"], [true, false], { input, output: discardOutput() });
  input.write("\r");
  assert.deepEqual(await resultPromise, [0]);
});

test("runMultiSelectPicker: toggling twice returns to unchecked", async () => {
  const input = new PassThrough();
  const resultPromise = runMultiSelectPicker(["a", "b"], [false, false], { input, output: discardOutput() });
  input.write(" ");
  input.write(" ");
  input.write("\r");
  assert.deepEqual(await resultPromise, []);
});

test("runMultiSelectPicker: Ctrl+C resolves null, distinct from an empty selection", async () => {
  const input = new PassThrough();
  const resultPromise = runMultiSelectPicker(["a", "b"], [false, false], { input, output: discardOutput() });
  input.write("\u0003");
  assert.equal(await resultPromise, null);
});
