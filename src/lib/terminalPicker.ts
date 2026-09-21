/**
 * Styled interactive prompts used by `trellis onboard`.
 *
 * The onboarding orchestration depends on semantic values (an index or a set
 * of indices), not on a particular terminal renderer. Clack owns raw-mode
 * handling, color, wrapping, cursor cleanup, and cancellation; the injected
 * streams keep the prompt loop testable without a real terminal.
 */

import type { Readable, Writable } from "node:stream";

/**
 * `@clack/prompts` (and its `@clack/core` dependency) is loaded lazily,
 * inside each picker function below, rather than via a top-level
 * `import` — deliberately, not an oversight. A top-level import runs the
 * moment ANY module that transitively imports this file is evaluated,
 * which for `trellis-gui`'s sidecar means every process start, since
 * `onboard.ts` (imported unconditionally by the sidecar's `/plan/onboard`
 * route) imports these functions even though the sidecar's `json: true`
 * contract (see `planApply.ts`'s `OnboardWizardInput` doc comment)
 * guarantees they are never actually called. Compiling the sidecar to a
 * single-file binary (tasks.md 5.1) surfaced a real, current limitation
 * in `@yao-pkg/pkg`'s ESM support: `@clack/prompts`' `exports`-map
 * `.mjs` entry fails to resolve inside pkg's snapshot filesystem
 * (`Cannot find module '.../@clack/prompts/dist/index.mjs'`), which
 * previously crashed the packaged sidecar at startup even though its own
 * code never uses the interactive picker at all. A dynamic `import()`
 * only resolves at the point it actually runs, so the sidecar (whose
 * `!opts.json` gates keep every real call site below unreached) never
 * triggers that resolution attempt — while a real, interactive CLI run
 * (`tsx`/`node`, not a pkg snapshot) resolves the dynamic import exactly
 * as it would a static one, so this is behavior-preserving for the CLI.
 */
async function clack() {
  return import("@clack/prompts");
}

export interface PickerStreams {
  input: NodeJS.ReadStream | Readable;
  output: NodeJS.WriteStream | Writable;
}

export interface PickerOption {
  label: string;
  disabled?: boolean;
}

function defaultStreams(): PickerStreams {
  return { input: process.stdin, output: process.stderr };
}

/**
 * Clack is only started for a real interactive terminal. Piped input keeps
 * the existing numbered fallback in onboard instead of hanging in raw mode.
 */
export function canUseInteractivePicker(streams: PickerStreams = defaultStreams()): boolean {
  const input = streams.input as NodeJS.ReadStream;
  const output = streams.output as NodeJS.WriteStream;
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === "function");
}

/** Wrapping index navigation retained as a small public utility for callers/tests. */
export function nextIndex(current: number, delta: number, length: number): number {
  return ((current + delta) % length + length) % length;
}

/** Pure single-index toggle retained for callers/tests. */
export function toggled(checked: readonly boolean[], index: number): boolean[] {
  const next = [...checked];
  next[index] = !next[index];
  return next;
}

function wasCancelled(value: unknown, cancelSymbol: symbol, isCancelFn: (v: unknown) => boolean): boolean {
  return value === cancelSymbol || isCancelFn(value);
}

/**
 * Single-select prompt. The returned number is the original item index, so
 * callers do not depend on display labels or prompt-library values.
 */
export async function runSingleSelectPicker(
  items: readonly (string | PickerOption)[],
  streams: PickerStreams = defaultStreams(),
  message = "请选择一个迁移来源",
): Promise<number | null> {
  const { select, CANCEL_SYMBOL, isCancel } = await clack();
  const result = await select<number>({
    message,
    options: items.map((item, value) => ({
      label: typeof item === "string" ? item : item.label,
      value,
      ...(typeof item === "string" || item.disabled === undefined ? {} : { disabled: item.disabled }),
    })),
    input: streams.input,
    output: streams.output,
    showInstructions: true,
  });
  return wasCancelled(result, CANCEL_SYMBOL, isCancel) ? null : result as number;
}

/**
 * Checkbox prompt. The returned indices preserve the existing onboard
 * contract, while Clack handles checked state, wrapping, colors, and cleanup.
 */
export async function runMultiSelectPicker(
  items: string[],
  initiallyChecked: readonly boolean[],
  streams: PickerStreams = defaultStreams(),
  message = "请选择要启用的项目",
): Promise<number[] | null> {
  const { multiselect, CANCEL_SYMBOL, isCancel } = await clack();
  const result = await multiselect<number>({
    message,
    options: items.map((label, value) => ({ label, value })),
    initialValues: items.flatMap((_, index) => (initiallyChecked[index] ? [index] : [])),
    input: streams.input,
    output: streams.output,
    required: false,
    showInstructions: true,
  });
  return wasCancelled(result, CANCEL_SYMBOL, isCancel) ? null : [...result as number[]].sort((left, right) => left - right);
}

/** Searchable multiselect for large skill/MCP inventories. It returns the
 * selected labels as stable names, preserving the semantic adapter contract
 * while avoiding a wall of dozens of rows in the onboarding terminal. */
export async function runSearchMultiSelectPicker(items: readonly string[], streams: PickerStreams = defaultStreams(), message = "选择要迁移的项目"): Promise<string[] | null> {
  const { autocompleteMultiselect, CANCEL_SYMBOL, isCancel } = await clack();
  const result = await autocompleteMultiselect<string>({
    message,
    placeholder: "输入关键词筛选",
    options: items.map((value) => ({ label: value, value })),
    initialValues: [...items],
    input: streams.input,
    output: streams.output,
    required: false,
  });
  return wasCancelled(result, CANCEL_SYMBOL, isCancel) ? null : result as string[];
}
