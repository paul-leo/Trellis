import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskProvider } from "../../src/lib/taskProvider.js";
import type { GatewayBackend } from "../../src/lib/gatewayBackend.js";
import type { RuntimeContext } from "../../src/lib/mcpRuntime.js";

function home(): string { return mkdtempSync(join(tmpdir(), "trellis-task-provider-")); }
function backend(): GatewayBackend { return { async listTools() { return []; }, async callTool() { return {}; }, async close() {} }; }
function text(value: { content?: Array<{ type: string; text?: string }> }): string { return value.content?.find((item) => item.type === "text")?.text ?? ""; }

test("TaskProvider: create/list/read/claim/handoff/complete are durable and explicit", async () => {
  const context: RuntimeContext = { agentId: "kimi-code", homeDir: home() };
  const provider = new TaskProvider();
  const notConfirmed = await provider.callTool("trellis.tasks.create", { objective: "inspect runtime", confirm: false }, context);
  assert.equal(notConfirmed.isError, true);

  const created = await provider.callTool("trellis.tasks.create", { objective: "inspect runtime", toAgent: "codex", context: { references: ["trellis://skills/trellis-runtime/SKILL.md"] }, confirm: true }, context);
  const task = JSON.parse(text(created));
  assert.equal(task.status, "pending");
  assert.equal(task.toAgent, "codex");

  const claimed = await provider.callTool("trellis.tasks.claim", { id: task.id, confirm: true }, { ...context, agentId: "codex" });
  assert.equal(JSON.parse(text(claimed)).claimedBy, "codex");
  const secondClaim = await provider.callTool("trellis.tasks.claim", { id: task.id, confirm: true }, { ...context, agentId: "pi" });
  assert.equal(secondClaim.isError, true);

  const handed = await provider.callTool("trellis.tasks.handoff", { id: task.id, toAgent: "pi", note: "please review", confirm: true }, { ...context, agentId: "codex" });
  assert.equal(JSON.parse(text(handed)).toAgent, "pi");
  const listed = await provider.callTool("trellis.tasks.list", {}, { ...context, agentId: "pi" });
  assert.equal(JSON.parse(text(listed)).tasks.length, 1);
  const completed = await provider.callTool("trellis.tasks.update", { id: task.id, status: "completed", result: "reviewed", confirm: true }, { ...context, agentId: "pi" });
  assert.equal(JSON.parse(text(completed)).status, "completed");
  assert.equal(JSON.parse(text(completed)).history.length >= 4, true);
});

test("TaskProvider: secret-like handoff content is rejected", async () => {
  const context: RuntimeContext = { agentId: "kimi-code", homeDir: home() };
  const provider = new TaskProvider();
  const result = await provider.callTool("trellis.tasks.create", { objective: "token=do-not-store", confirm: true }, context);
  assert.equal(result.isError, true);
  assert.match(text(result), /credential|secret/i);
});
