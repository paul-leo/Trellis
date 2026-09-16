/**
 * Exercises the real key-parsing/render/state-machine loop against
 * plain `PassThrough` streams — no real TTY needed, since `PickerStreams`
 * is an injectable seam (trellis-onboard-interactive-picker design.md).
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  canUseInteractivePicker,
  nextIndex,
  physicalLineCount,
  runMultiSelectPicker,
  runSingleSelectPicker,
  toggled,
  totalPhysicalLines,
  visibleWidth,
} from "../../src/lib/terminalPicker.js";

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

test("visibleWidth: strips color codes, counts only the printable text", () => {
  assert.equal(visibleWidth("plain text"), 10);
  assert.equal(visibleWidth("[1;36mcolored[0m"), 7);
  assert.equal(visibleWidth("> [1;36mhighlighted[0m"), 13);
});

test("physicalLineCount: a row shorter than the terminal is exactly one line", () => {
  assert.equal(physicalLineCount("short", 80), 1);
  assert.equal(physicalLineCount("", 80), 1);
});

test("physicalLineCount: a row wider than the terminal wraps to the ceiling of visibleWidth/columns (regression — the real bug: undercounting a wrapped row's on-screen height)", () => {
  assert.equal(physicalLineCount("x".repeat(80), 80), 1);
  assert.equal(physicalLineCount("x".repeat(81), 80), 2);
  assert.equal(physicalLineCount("x".repeat(160), 80), 2);
  assert.equal(physicalLineCount("x".repeat(161), 80), 3);
});

test("physicalLineCount: color codes around a long row don't inflate its wrapped height", () => {
  const colored = `> [1;36m${"x".repeat(85)}[0m`;
  // visible width is 87 (2-char marker + 85 x's), not the much longer raw string length
  assert.equal(physicalLineCount(colored, 80), 2);
});

test("totalPhysicalLines: sums each row's own wrapped height, not the row count", () => {
  assert.equal(totalPhysicalLines(["x".repeat(85), "short"], 80), 3);
  assert.equal(totalPhysicalLines(["a", "b", "c"], 80), 3);
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

test("runSingleSelectPicker: a redraw clears the previous frame's true wrapped height, not its logical row count (regression — a real mirasim session left stale wrapped lines behind on every redraw)", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk) => chunks.push(chunk.toString("utf-8")));

  // No `.columns` on this plain stream — falls back to the 80-column
  // default (columnsOf), so this wraps deterministically: 87 visible
  // chars (2-char ">"/"  " marker + 85 x's) -> ceil(87/80) = 2 lines.
  const longLabel = "x".repeat(85);
  const resultPromise = runSingleSelectPicker([longLabel, "short"], { input, output });

  chunks.length = 0; // discard the initial draw; only the redraw's clear matters here
  input.write(String.fromCharCode(0x1b) + "[B"); // Down -- triggers a second draw()
  input.write("\r");
  await resultPromise;

  const written = chunks.join("");
  const clearLineCount = (written.match(new RegExp(String.fromCharCode(0x1b) + "\\[2K", "g")) ?? []).length;
  // Pre-fix, this counted items.length (2) instead of the true wrapped
  // height (2 for the long row + 1 for "short" = 3), leaving one
  // physical line of the previous frame uncleared.
  assert.equal(clearLineCount, 3);
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
