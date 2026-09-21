#!/usr/bin/env node
/**
 * Stand-in for a real Agent CLI's non-interactive mode, so agent-bridge
 * tests exercise the real spawn/timeout/output-parsing/persona/session
 * path without any real API calls or cost. Mode selected by argv[2]; every
 * remaining arg is echoed back verbatim (joined by "|") so a test can
 * assert exactly what was passed — including a persona placeholder's
 * value, a resumed sessionId, or a persona-prefixed prompt:
 *
 * - "echo" (default): prints `{"result":"echo:<rest>","session_id":"stub-session-123"}`
 *   and exits 0 — the JSON-output success path, always reporting a fixed
 *   session id so tests can assert extraction.
 * - "fail": writes to stderr and exits 1 — the failure path.
 * - "hang": never exits on its own — the timeout/kill path.
 * - "env": prints `TRELLIS_DELEGATION_DEPTH` from its own environment, so
 *   a test can assert depth was actually propagated to the child process.
 * - "stream": emits a Claude Code-shaped stream-json sequence (init, a
 *   tool_use, a tool_result, a text block, the final result) as separate
 *   lines with real delays between them (not all flushed at once), so a
 *   streaming test can assert a line arrived before the process closed —
 *   not just that the final buffered output was correct.
 */
const mode = process.argv[2] ?? "echo";
const rest = process.argv.slice(3);

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (mode === "echo") {
  process.stdout.write(JSON.stringify({ result: `echo:${rest.join("|")}`, session_id: "stub-session-123" }));
  process.exit(0);
} else if (mode === "env") {
  process.stdout.write(JSON.stringify({ result: process.env.TRELLIS_DELEGATION_DEPTH ?? "unset" }));
  process.exit(0);
} else if (mode === "fail") {
  process.stderr.write(`stub-agent-cli: failing as requested for "${rest.join("|")}"`);
  process.exit(1);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "stream") {
  const prompt = rest.join("|");
  (async () => {
    writeLine({ type: "system", subtype: "init", session_id: "stub-session-123" });
    await delay(30);
    writeLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } }] } });
    await delay(30);
    writeLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] } });
    await delay(30);
    writeLine({ type: "assistant", message: { content: [{ type: "text", text: `stream-reply:${prompt}` }] } });
    await delay(30);
    writeLine({ type: "result", subtype: "success", result: `stream-reply:${prompt}`, session_id: "stub-session-123" });
    process.exit(0);
  })();
} else {
  process.stdout.write(rest.join("|"));
  process.exit(0);
}
