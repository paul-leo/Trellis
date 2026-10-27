/**
 * 会话记录 → 共享语法渲染(trellis-evolve 任务 9.3 的 read_trajectory)。
 *
 * Trellis 探针会话的捕获格式:probe launcher(13.3)写出的规范化 NDJSON
 * 事件流,每行一个 JSON 对象:
 *
 *   {"type": "text",      "text": ...}                                  → [ASSISTANT]
 *   {"type": "thinking",  "text": ...}                                  → [THINKING]
 *   {"type": "tool_call", "name": ..., "input": ...,                    → [ACTION] name(args)
 *                          "status": "ok"|"error",                      → [OBSERVATION] output
 *                          "output"/"error": ...}                          或 [OBSERVATION ERROR]
 *   {"type": "error",     "message": ...}                               → [ERROR]
 *
 * 渲染语义对齐 harness2 substrate 的 render_events(共享语法,substrate
 * 各自实现):防御性逐行解析(非 JSON 行跳过)、`_clip` 截断标记
 * `…(+N chars — render truncation)`、整体 max_chars 帽。Trellis 的
 * args_trunc 默认 400(协议默认值)。
 */

import { readFileSync } from "node:fs";

const truncMarker = (dropped: number): string => `…(+${dropped} chars — render truncation)`;

/** harness2 `_clip` 的等价物:去 NUL,超长截断并加渲染截断标记。 */
function clip(value: unknown, cap: number): string {
  const s = (value === null || value === undefined ? "" : String(value)).replaceAll("\x00", "");
  if (cap <= 0 || s.length <= cap) return s;
  return s.slice(0, cap) + truncMarker(s.length - cap);
}

export interface RenderSessionOptions {
  obsTrunc: number;
  maxChars: number;
  argsTrunc?: number;
}

/** Render a captured session stream into the shared trajectory grammar. */
export function renderSessionEvents(streamPath: string, opts: RenderSessionOptions): string {
  const argsCap = Math.trunc(opts.argsTrunc ?? 400);
  let raw: string;
  try {
    raw = readFileSync(streamPath, "utf-8");
  } catch (err) {
    return `(failed to read trajectory: ${err instanceof Error ? err.message : String(err)})`;
  }

  const lines: string[] = [];
  for (const ln of raw.split("\n")) {
    const trimmed = ln.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof ev !== "object" || ev === null || Array.isArray(ev)) continue;
    const event = ev as Record<string, unknown>;
    const type = event.type;

    if (type === "text" || type === "assistant") {
      const text = typeof event.text === "string" ? event.text : undefined;
      if (text?.trim()) lines.push(`[ASSISTANT] ${clip(text, opts.obsTrunc)}`);
    } else if (type === "thinking" || type === "reasoning") {
      const text = typeof event.text === "string" ? event.text : undefined;
      if (text?.trim()) lines.push(`[THINKING] ${clip(text, opts.obsTrunc)}`);
    } else if (type === "tool_call" || type === "tool") {
      const name = typeof event.name === "string" && event.name ? event.name : "tool";
      const args = event.input !== undefined ? JSON.stringify(event.input) : "";
      lines.push(`[ACTION] ${name}(${clip(args, argsCap)})`);
      if (event.status === "error") {
        lines.push(`[OBSERVATION ERROR] ${clip(event.error, opts.obsTrunc)}`);
      } else if (event.output !== undefined) {
        lines.push(`[OBSERVATION] ${clip(event.output, opts.obsTrunc)}`);
      }
    } else if (type === "error") {
      lines.push(`[ERROR] ${clip(event.message, 300)}`);
    }
    // 未识别的 type:跳过(捕获格式向前兼容的余地)。
  }

  let rendered = lines.join("\n").trim();
  if (!rendered) return "(no parseable events in trajectory)";
  if (rendered.length > opts.maxChars) {
    const dropped = rendered.length - opts.maxChars;
    rendered = rendered.slice(0, opts.maxChars) + "\n" + truncMarker(dropped);
  }
  return rendered;
}
