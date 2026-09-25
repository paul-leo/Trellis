import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runDelegatedCallStreaming, tryParseClaudeStreamJsonLine, tryParseZcodeStreamJsonLine, type StreamChunk } from "../../src/lib/agentBridge.js";

const STUB_CLI = join(process.cwd(), "test/fixtures/stub-agent-cli.js");
const STUB_ZCODE = join(process.cwd(), "test/fixtures/stub-zcode-cli.js");

test("tryParseClaudeStreamJsonLine: parses the four known shapes", () => {
  assert.deepEqual(
    tryParseClaudeStreamJsonLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" })),
    { kind: "init", sessionId: "s-1" },
  );
  assert.deepEqual(
    tryParseClaudeStreamJsonLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } })),
    { kind: "text-delta", text: "hi there" },
  );
  assert.deepEqual(
    tryParseClaudeStreamJsonLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } }] } })),
    { kind: "tool-call", toolCallId: "t1", name: "read_file", input: { path: "a.txt" } },
  );
  assert.deepEqual(
    tryParseClaudeStreamJsonLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] } })),
    { kind: "tool-result", toolCallId: "t1", output: "file contents" },
  );
  assert.deepEqual(
    tryParseClaudeStreamJsonLine(JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s-1" })),
    { kind: "final", output: "done", sessionId: "s-1" },
  );
});

test("tryParseClaudeStreamJsonLine: malformed or unrecognized lines degrade to undefined, not a throw", () => {
  assert.equal(tryParseClaudeStreamJsonLine("not json at all"), undefined);
  assert.equal(tryParseClaudeStreamJsonLine(""), undefined);
  assert.equal(tryParseClaudeStreamJsonLine(JSON.stringify({ type: "something-unknown" })), undefined);
  assert.equal(tryParseClaudeStreamJsonLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "image" }] } })), undefined);
});

test("tryParseZcodeStreamJsonLine: final result keeps ZCode response and session id", () => {
  assert.deepEqual(
    tryParseZcodeStreamJsonLine(JSON.stringify({ type: "result", response: "done", sessionId: "z-1" })),
    { kind: "final", output: "done", protocol: "zcode", sessionId: "z-1" },
  );
  assert.equal(tryParseZcodeStreamJsonLine(JSON.stringify({ type: "model.streaming", payload: {} })), undefined);
});

test("runDelegatedCallStreaming: ZCode stream emits raw unknown events and retains its result session", async () => {
  const chunks: StreamChunk[] = [];
  const result = await runDelegatedCallStreaming(
    "zcode",
    { command: process.execPath, args: [STUB_ZCODE, "--prompt", "{prompt}", "--output-format", "stream-json"], outputFormat: "stream-json", streamProtocol: "zcode" },
    "hello",
    { onChunk: (chunk) => chunks.push(chunk) },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "fresh:zcode:hello");
  assert.equal(result.sessionId, "zcode-session-123");
  assert.equal(chunks[0]?.parsed, undefined);
  assert.deepEqual(chunks[1]?.parsed, { kind: "final", output: "fresh:zcode:hello", protocol: "zcode", sessionId: "zcode-session-123" });
});

test("runDelegatedCallStreaming: chunks arrive incrementally, before the process closes", async () => {
  const arrivalTimes: number[] = [];
  const chunks: StreamChunk[] = [];
  const start = Date.now();

  const result = await runDelegatedCallStreaming(
    "qoder",
    { command: process.execPath, args: [STUB_CLI, "stream", "{prompt}"], outputFormat: "stream-json" },
    "hello",
    {
      onChunk: (chunk) => {
        arrivalTimes.push(Date.now() - start);
        chunks.push(chunk);
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output, "stream-reply:hello");
  assert.equal(result.sessionId, "stub-session-123");
  assert.equal(result.targetAgent, "qoder");

  // Five distinct lines from stub-agent-cli's "stream" mode.
  assert.equal(chunks.length, 5);
  assert.equal(chunks[0]?.parsed?.kind, "init");
  assert.equal(chunks[1]?.parsed?.kind, "tool-call");
  assert.equal(chunks[2]?.parsed?.kind, "tool-result");
  assert.equal(chunks[3]?.parsed?.kind, "text-delta");
  assert.equal(chunks[4]?.parsed?.kind, "final");

  // Real proof of incremental delivery: the first chunk arrived well
  // before the ~120ms it takes stub-agent-cli to emit all five lines and
  // exit, not all at once at the very end.
  assert.ok(arrivalTimes[0]! < 90, `expected first chunk before 90ms, got ${arrivalTimes[0]}ms`);
  assert.ok(arrivalTimes[4]! - arrivalTimes[0]! >= 60, "expected a real gap between the first and last chunk");
});

test("runDelegatedCallStreaming: non-stream-json target still gets raw line chunks and a plain-text result", async () => {
  const chunks: StreamChunk[] = [];
  const result = await runDelegatedCallStreaming(
    "qoder",
    { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"], outputFormat: "json" },
    "hello",
    { onChunk: (chunk) => chunks.push(chunk) },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "echo:hello");
  assert.equal(result.sessionId, "stub-session-123");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.parsed, undefined);
});

test("runDelegatedCallStreaming: a positional-prompt template (MiniMax Code's \"mcode exec <prompt> --model ...\" shape) substitutes {prompt} correctly with no leading flag", async () => {
  const chunks: StreamChunk[] = [];
  const result = await runDelegatedCallStreaming(
    "minimax-code",
    { command: process.execPath, args: [STUB_CLI, "echo", "exec", "{prompt}", "--model", "some-provider/some-model"], outputFormat: "json" },
    "explain this project",
    { onChunk: (chunk) => chunks.push(chunk) },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "echo:exec|explain this project|--model|some-provider/some-model");
  assert.equal(chunks.length, 1);
});

test("runDelegatedCallStreaming: a hanging process times out and reports status timeout", async () => {
  const result = await runDelegatedCallStreaming(
    "qoder",
    { command: process.execPath, args: [STUB_CLI, "hang", "{prompt}"] },
    "hello",
    { onChunk: () => {}, timeoutMs: 200 },
  );
  assert.equal(result.status, "timeout");
});

test("runDelegatedCallStreaming: aborting via signal kills the process and reports status cancelled, well before the timeout", async () => {
  const controller = new AbortController();
  const start = Date.now();
  const resultPromise = runDelegatedCallStreaming(
    "qoder",
    { command: process.execPath, args: [STUB_CLI, "hang", "{prompt}"] },
    "hello",
    { onChunk: () => {}, timeoutMs: 5_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50);
  const result = await resultPromise;
  const elapsed = Date.now() - start;
  assert.equal(result.status, "cancelled");
  assert.ok(elapsed < 4_000, `expected cancellation well before the 5s timeout, took ${elapsed}ms`);
});

test("runDelegatedCallStreaming: resuming uses resumeArgs and threads sessionId through", async () => {
  const chunks: StreamChunk[] = [];
  const result = await runDelegatedCallStreaming(
    "qoder",
    {
      command: process.execPath,
      args: [STUB_CLI, "echo", "{prompt}"],
      resumeArgs: [STUB_CLI, "echo", "--resume", "{sessionId}", "{prompt}"],
      outputFormat: "json",
    },
    "continue please",
    { onChunk: (chunk) => chunks.push(chunk), sessionId: "stub-session-123" },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "echo:--resume|stub-session-123|continue please");
});

test("runDelegatedCallStreaming: resuming against a target with no resumeArgs fails clearly, without spawning", async () => {
  const result = await runDelegatedCallStreaming(
    "qoder",
    { command: process.execPath, args: [STUB_CLI, "echo", "{prompt}"] },
    "continue please",
    { onChunk: () => {}, sessionId: "stub-session-123" },
  );
  assert.equal(result.status, "failed");
  assert.match(result.output, /no resumeArgs configured/);
});
