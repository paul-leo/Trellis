/**
 * Minimal, dependency-free arrow-key/checkbox terminal picker
 * (trellis-onboard-interactive-picker design.md D1) — the interaction
 * surface `trellis onboard`'s two prompts need (at most four rows, no
 * search, no pagination) doesn't need a full prompt library; this
 * hand-rolls just enough raw-mode key handling and ANSI rendering for
 * that bounded case, matching the project's existing narrow-dependency
 * precedent (src/lib/envVarNames.ts, src/lib/secretEnv.ts).
 *
 * `input`/`output` are injectable (never a CLI flag) purely so tests can
 * drive the real key-parsing/render loop against a plain stream instead
 * of a real TTY — same seam pattern (`homeDir`, etc.) used everywhere
 * else in this project.
 */

import type { Readable, Writable } from "node:stream";

export interface PickerStreams {
  input: NodeJS.ReadStream | Readable;
  output: NodeJS.WriteStream | Writable;
}

function defaultStreams(): PickerStreams {
  return { input: process.stdin, output: process.stdout };
}

/**
 * True only when both streams are real, raw-mode-capable terminals — the
 * exact gate deciding picker vs. the pre-existing numbered-typing prompt
 * (design.md D2). A stream lacking `setRawMode` (piped input, some
 * minimal TTYs) always falls back, never hangs or guesses.
 */
export function canUseInteractivePicker(streams: PickerStreams = defaultStreams()): boolean {
  const input = streams.input as NodeJS.ReadStream;
  const output = streams.output as NodeJS.WriteStream;
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === "function");
}

/** Wrapping index navigation — pure, exported for direct unit testing. */
export function nextIndex(current: number, delta: number, length: number): number {
  return ((current + delta) % length + length) % length;
}

/** Pure single-index toggle — exported for direct unit testing. */
export function toggled(checked: readonly boolean[], index: number): boolean[] {
  const next = [...checked];
  next[index] = !next[index];
  return next;
}

const ESC = "\u001b";
const CTRL_C = "\u0003";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

type Key = "up" | "down" | "toggle" | "confirm" | "cancel" | null;

/** Parses one raw input chunk into a single logical key — arrow escape
 * sequences, j/k, space, enter, or Ctrl+C. Anything else is ignored. */
function parseKey(chunk: string): Key {
  if (chunk === CTRL_C) return "cancel";
  if (chunk === "\r" || chunk === "\n") return "confirm";
  if (chunk === " ") return "toggle";
  if (chunk === `${ESC}[A` || chunk === "k") return "up";
  if (chunk === `${ESC}[B` || chunk === "j") return "down";
  return null;
}

function withRawMode<T>(streams: PickerStreams, body: () => Promise<T>): Promise<T> {
  const input = streams.input as NodeJS.ReadStream;
  const output = streams.output as NodeJS.WriteStream;
  const canSetRawMode = typeof input.setRawMode === "function";

  if (canSetRawMode) input.setRawMode!(true);
  input.resume();
  input.setEncoding("utf-8");
  output.write(HIDE_CURSOR);

  const restore = () => {
    output.write(SHOW_CURSOR);
    if (canSetRawMode) input.setRawMode!(false);
    input.pause();
  };
  // Second-layer safety net (design.md D6): a thrown error the caller's
  // own try/finally doesn't get a chance to run for (process killed
  // externally) must still not leave the terminal in raw mode/cursor
  // hidden.
  process.once("exit", restore);

  return body().finally(() => {
    restore();
    process.removeListener("exit", restore);
  });
}

function moveCursorUp(output: NodeJS.WriteStream | Writable, lines: number): void {
  if (lines > 0) output.write(`${ESC}[${lines}A`);
}

function clearLines(output: NodeJS.WriteStream | Writable, lines: number): void {
  for (let i = 0; i < lines; i++) {
    output.write(`${ESC}[2K`);
    if (i < lines - 1) output.write(`${ESC}[1B`);
  }
  moveCursorUp(output, lines - 1);
}

function renderRows(output: NodeJS.WriteStream | Writable, rows: string[], previousRowCount: number): void {
  if (previousRowCount > 0) {
    clearLines(output, previousRowCount);
  }
  for (const row of rows) {
    output.write(`${row}\n`);
  }
}

function highlightRow(text: string, isHighlighted: boolean): string {
  return isHighlighted ? `> ${ESC}[7m${text}${ESC}[0m` : `  ${text}`;
}

/**
 * Single-select: Up/Down/j/k moves the highlight, Enter confirms. Resolves
 * the confirmed index, or `null` on Ctrl+C cancel. Caller (onboard.ts)
 * must have already confirmed `canUseInteractivePicker()` — this function
 * does not re-check, and assumes `streams.input` genuinely supports raw
 * mode.
 */
export async function runSingleSelectPicker(items: string[], streams: PickerStreams = defaultStreams()): Promise<number | null> {
  const { input, output } = streams;
  return withRawMode(streams, () => {
    return new Promise<number | null>((resolve) => {
      let highlighted = 0;
      let rowCount = 0;

      const draw = () => {
        const rows = items.map((label, i) => highlightRow(label, i === highlighted));
        renderRows(output, rows, rowCount);
        rowCount = rows.length;
      };
      draw();

      const onData = (chunk: Buffer | string) => {
        const key = parseKey(chunk.toString("utf-8"));
        if (key === "up") {
          highlighted = nextIndex(highlighted, -1, items.length);
          draw();
        } else if (key === "down") {
          highlighted = nextIndex(highlighted, 1, items.length);
          draw();
        } else if (key === "confirm") {
          input.removeListener("data", onData);
          resolve(highlighted);
        } else if (key === "cancel") {
          input.removeListener("data", onData);
          resolve(null);
        }
      };
      input.on("data", onData);
    });
  });
}

/**
 * Multi-select (checkbox): Up/Down/j/k moves the highlight, Space toggles
 * the current row, Enter confirms. Resolves the checked indices at
 * confirm time, or `null` on Ctrl+C cancel. Same precondition as
 * `runSingleSelectPicker`.
 */
export async function runMultiSelectPicker(
  items: string[],
  initiallyChecked: readonly boolean[],
  streams: PickerStreams = defaultStreams(),
): Promise<number[] | null> {
  const { input, output } = streams;
  return withRawMode(streams, () => {
    return new Promise<number[] | null>((resolve) => {
      let highlighted = 0;
      let checked = [...initiallyChecked];
      let rowCount = 0;

      const draw = () => {
        const rows = items.map((label, i) => highlightRow(`[${checked[i] ? "x" : " "}] ${label}`, i === highlighted));
        renderRows(output, rows, rowCount);
        rowCount = rows.length;
      };
      draw();

      const onData = (chunk: Buffer | string) => {
        const key = parseKey(chunk.toString("utf-8"));
        if (key === "up") {
          highlighted = nextIndex(highlighted, -1, items.length);
          draw();
        } else if (key === "down") {
          highlighted = nextIndex(highlighted, 1, items.length);
          draw();
        } else if (key === "toggle") {
          checked = toggled(checked, highlighted);
          draw();
        } else if (key === "confirm") {
          input.removeListener("data", onData);
          resolve(checked.flatMap((isChecked, i) => (isChecked ? [i] : [])));
        } else if (key === "cancel") {
          input.removeListener("data", onData);
          resolve(null);
        }
      };
      input.on("data", onData);
    });
  });
}
