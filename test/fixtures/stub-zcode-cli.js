#!/usr/bin/env node
/** Public-ZCode-contract stand-in for chat and delegation tests. */

const args = process.argv.slice(2);
if (args[0] === "version") {
  process.stdout.write("zcode-app-cli 3.14.3-test\nzcode-runtime 0.16.9\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("zcode --prompt <text> --resume <sessionId> --output-format stream-json\n");
  process.exit(0);
}

const promptIndex = args.indexOf("--prompt");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] ?? "" : "";
const resumeIndex = args.indexOf("--resume");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : "zcode-session-123";
const response = `${resumeIndex >= 0 ? "resumed" : "fresh"}:zcode:${prompt}`;
if (args.includes("stream-json")) {
  process.stdout.write(`${JSON.stringify({ type: "model.streaming", payload: { ignored: true } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", response, sessionId })}\n`);
} else {
  process.stdout.write(JSON.stringify({ type: "result", response, sessionId }));
}
