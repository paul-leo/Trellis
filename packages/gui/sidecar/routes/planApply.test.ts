import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "../server.js";
import { createPlanApplyRoutes } from "./planApply.js";
import { PlanStore } from "../planStore.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

function cli(homeDir: string, args: string[]): string {
  return execFileSync("npx", ["tsx", "src/cli.ts", ...args], { cwd: repoRoot, env: { ...process.env, HOME: homeDir }, encoding: "utf-8" });
}

function serversYaml(homeDir: string): string {
  return readFileSync(join(homeDir, ".trellis", "mcp", "servers.yaml"), "utf-8");
}

/** A real home with `trellis init` run, `claude-code` managed, and one
 * real canonical skill on disk that has never been synced anywhere —
 * i.e. a genuine pending "create" waiting for `sync` to act on. */
function pendingSyncHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-planapply-"));
  cli(homeDir, ["init"]);
  cli(homeDir, ["manage", "add", "claude-code"]);
  // The claude-code probe treats `~/.claude.json`'s presence as the
  // machine-has-this-agent signal (src/probes/claude-code.ts) — without
  // it sync's real plan correctly reports claude-code as absent and
  // produces zero items, which is not what this fixture is for.
  writeFileSync(join(homeDir, ".claude.json"), "{}\n");
  const skillDir = join(homeDir, ".trellis", "skills", "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: a demo skill for planApply tests\n---\n\n# Demo\n");
  return homeDir;
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("plan/apply sync: apply without a prior plan is refused, and nothing is written", async () => {
  const homeDir = pendingSyncHome();
  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const { status, body } = await post(port, "/apply/sync", { planId: "not-a-real-plan-id" });
    assert.equal(status, 400);
    assert.match(String((body as { error: string }).error), /no matching plan/);
    assert.equal(existsSync(join(homeDir, ".claude", "skills", "demo-skill")), false, "refused apply must not write anything");
  } finally {
    server.close();
  }
});

test("plan/apply sync: a real plan precedes a real apply, and the plan is single-use", async () => {
  const homeDir = pendingSyncHome();
  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/sync", {});
    assert.equal(planned.status, 200);
    const { planId, plan } = planned.body as { planId: string; plan: { reports: Array<{ agent: string; items: Array<{ action: string }> }> } };
    assert.ok(planId);
    const claudeReport = plan.reports.find((r) => r.agent === "claude-code");
    assert.ok(claudeReport, "the plan must show claude-code getting the new skill");
    assert.ok(claudeReport.items.some((item) => item.action === "create"), "the pending skill must show up as a create, computed by the real collectSyncReport — not fabricated");

    const applied = await post(port, "/apply/sync", { planId });
    assert.equal(applied.status, 200);
    assert.equal(existsSync(join(homeDir, ".claude", "skills", "demo-skill")), true, "a confirmed apply must actually write the real symlink");

    const replay = await post(port, "/apply/sync", { planId });
    assert.equal(replay.status, 400, "a consumed planId must not be replayable into a second real write");
  } finally {
    server.close();
  }
});

test("plan/apply mcp-add then mcp-remove: real writes to servers.yaml, with the cascade sync included", async () => {
  const homeDir = pendingSyncHome();
  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/mcp-add", { name: "demo-server", raw: { transport: "stdio", command: "echo" } });
    assert.equal(planned.status, 200);
    const { planId, plan } = planned.body as { planId: string; plan: { action: string } };
    assert.equal(plan.action, "create", "collectMcpAddPlan itself must say create — this is its real return value, not a guess");

    const applied = await post(port, "/apply/mcp-add", { planId });
    assert.equal(applied.status, 200);
    assert.match(serversYaml(homeDir), /demo-server:/, "a confirmed apply must actually write the server into servers.yaml");
    const { result } = applied.body as { result: { sync?: unknown } };
    assert.ok(result.sync, "runMcpAdd's cascade sync must have run and been included in the response, same as CLI --json would show");

    const removePlanned = await post(port, "/plan/mcp-remove", { name: "demo-server" });
    const { planId: removePlanId, plan: removePlan } = removePlanned.body as { planId: string; plan: { action: string } };
    assert.equal(removePlan.action, "removed");
    await post(port, "/apply/mcp-remove", { planId: removePlanId });
    assert.doesNotMatch(serversYaml(homeDir), /demo-server:/, "a confirmed remove must actually delete the entry");
  } finally {
    server.close();
  }
});

test("plan/apply skill-add then skill-remove: real files on disk, with the cascade sync included", async () => {
  const homeDir = pendingSyncHome();
  const sourceDir = mkdtempSync(join(tmpdir(), "trellis-gui-skill-source-"));
  writeFileSync(join(sourceDir, "SKILL.md"), "---\nname: another-skill\ndescription: added through the sidecar route itself\n---\n\n# Another\n");

  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/skill-add", { name: "another-skill", fromPath: sourceDir });
    assert.equal(planned.status, 200);
    const { planId, plan } = planned.body as { planId: string; plan: { action: string } };
    assert.equal(plan.action, "create");

    const applied = await post(port, "/apply/skill-add", { planId });
    assert.equal(applied.status, 200);
    assert.equal(existsSync(join(homeDir, ".trellis", "skills", "another-skill", "SKILL.md")), true, "a confirmed apply must actually copy the skill into canonical");
    assert.equal(existsSync(join(homeDir, ".claude", "skills", "another-skill")), true, "the cascade sync must project it to the managed, present agent");
    const { result } = applied.body as { result: { sync?: unknown } };
    assert.ok(result.sync);

    const removePlanned = await post(port, "/plan/skill-remove", { name: "another-skill" });
    const { planId: removePlanId, plan: removePlan } = removePlanned.body as { planId: string; plan: { action: string } };
    assert.equal(removePlan.action, "removed");
    await post(port, "/apply/skill-remove", { planId: removePlanId });
    assert.equal(existsSync(join(homeDir, ".trellis", "skills", "another-skill")), false, "a confirmed remove must actually delete the canonical skill");
  } finally {
    server.close();
  }
});

test("plan/apply rollback: a real prior write is genuinely undone", async () => {
  const homeDir = pendingSyncHome();
  // `manage add` is unconditionally backup-tracked (src/commands/manage.ts
  // always opens its own session) — a reliable rollback target,
  // independent of the mcp/skill add-remove fix exercised below.
  const before = cli(homeDir, ["manage", "list", "--json"]);
  cli(homeDir, ["manage", "add", "pi"]);
  const after = cli(homeDir, ["manage", "list", "--json"]);
  assert.notEqual(before, after, "precondition: the add really changed managed.yaml");

  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/rollback", {});
    assert.equal(planned.status, 200);
    const { planId, plan } = planned.body as { planId: string; plan: { runId: string; items: Array<{ action: string }> } };
    assert.ok(plan.runId);
    assert.ok(plan.items.some((item) => item.action === "restore"), "the plan must show a real restore, computed by collectRollbackPlan itself");

    const applied = await post(port, "/apply/rollback", { planId });
    assert.equal(applied.status, 200);
    assert.equal(cli(homeDir, ["manage", "list", "--json"]), before, "a confirmed rollback must actually restore managed.yaml's pre-write content");
  } finally {
    server.close();
  }
});

test("plan/apply rollback: mcp-add's own direct write is now backup-tracked and rolls back (tasks.md 3.5 fix)", async () => {
  // Originally `mcp add`'s canonical `servers.yaml` write bypassed
  // backup/rollback entirely — only its cascade-sync sub-step opened a
  // session, and only when that sync had real projected changes (see
  // src/commands/mcp.ts's `applyMcpAddWithSync` doc comment for the fix:
  // it now opens its own session around the direct write, same pattern
  // `manage.ts` already used). This test targets that exact write through
  // the sidecar's own `/apply/mcp-add` + `/apply/rollback` endpoints —
  // not the raw CLI — to prove the fix holds through the same path the
  // GUI itself uses, not just in isolation.
  const homeDir = pendingSyncHome();
  const before = serversYaml(homeDir);

  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const addPlanned = await post(port, "/plan/mcp-add", { name: "rollback-me", raw: { transport: "stdio", command: "echo" } });
    const { planId: addPlanId } = addPlanned.body as { planId: string };
    const addApplied = await post(port, "/apply/mcp-add", { planId: addPlanId });
    assert.equal(addApplied.status, 200);
    assert.notEqual(serversYaml(homeDir), before, "precondition: the add really changed servers.yaml");

    // `pendingSyncHome` has `claude-code` managed and present, so this
    // `mcp add` cascades into a real sync — which opens its OWN later
    // backup run (same reason `applyMcpAddWithSync`'s doc comment gives
    // for why the direct write needs its own session distinct from the
    // sync's). So the most-recent run here is legitimately the cascade
    // sync, not the add — look up the add's own run id explicitly via the
    // real CLI's `rollback --list --json` rather than assume ordering.
    const runs = JSON.parse(cli(homeDir, ["rollback", "--list", "--json"])) as Array<{ runId: string; command: string }>;
    const addRun = runs.find((r) => r.command === "mcp-add");
    assert.ok(addRun, "the mcp-add write itself must have opened its own backup run");

    const rollbackPlanned = await post(port, "/plan/rollback", { runId: addRun!.runId });
    const { planId: rollbackPlanId, plan } = rollbackPlanned.body as { planId: string; plan: { items: Array<{ action: string; path: string }> } };
    assert.ok(
      plan.items.some((item) => item.action === "restore" && item.path.endsWith(join(".trellis", "mcp", "servers.yaml"))),
      "the mcp-add run's plan must show servers.yaml as restorable",
    );

    const rollbackApplied = await post(port, "/apply/rollback", { planId: rollbackPlanId });
    assert.equal(rollbackApplied.status, 200);
    assert.equal(serversYaml(homeDir), before, "rollback must restore servers.yaml to its pre-add content");
  } finally {
    server.close();
  }
});

test("plan/apply mcp-sync: matches collectMcpSyncReport directly and applies for real", async () => {
  const homeDir = pendingSyncHome();
  cli(homeDir, ["mcp", "add", "another-server", "--transport", "stdio", "--command", "echo", "--json"]); // canonical only would need --dry-run; this writes + auto-syncs like any real CLI use
  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/mcp-sync", {});
    assert.equal(planned.status, 200);
    const { planId, plan } = planned.body as { planId: string; plan: { reports: unknown[] } };
    assert.ok(Array.isArray(plan.reports));
    const applied = await post(port, "/apply/mcp-sync", { planId });
    assert.equal(applied.status, 200);
  } finally {
    server.close();
  }
});

test("plan/apply onboard: a wizard-submitted managed-agent choice produces the same result a CLI --json --manage run would, and never blocks on a terminal prompt", async () => {
  // A fresh home with claude-code detectable as present but NOT YET
  // managed — collectOnboardPlan's own managed-agent resolution
  // (resolveManagedAgents) is real, unexercised work for this test to do,
  // not something pendingSyncHome already set up.
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-planapply-onboard-"));
  cli(homeDir, ["init"]);
  writeFileSync(join(homeDir, ".claude.json"), "{}\n");
  assert.doesNotMatch(cli(homeDir, ["manage", "list", "--json"]), /claude-code/, "precondition: claude-code isn't managed yet");

  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/onboard", { manage: "claude-code" });
    assert.equal(planned.status, 200);
    const { planId, plan } = planned.body as { planId: string; plan: { refusal?: string; managedAgents?: string[] } };
    assert.equal(plan.refusal, undefined, "json:true must never produce a refusal caused by an unanswerable prompt for a choice the wizard already supplied");
    assert.ok(plan.managedAgents?.includes("claude-code"), "the plan must show claude-code entering the managed set");
    assert.doesNotMatch(cli(homeDir, ["manage", "list", "--json"]), /claude-code/, "a /plan call must not have written anything for real yet");

    const applied = await post(port, "/apply/onboard", { planId, manage: "claude-code" });
    assert.equal(applied.status, 200);
    const { result } = applied.body as { result: { managedAgents?: string[] } };
    assert.ok(result.managedAgents?.includes("claude-code"));
    assert.match(cli(homeDir, ["manage", "list", "--json"]), /claude-code/, "a confirmed apply must actually add claude-code to managed.yaml");
  } finally {
    server.close();
  }
});

test("plan/apply onboard: a choice the wizard omits (no --manage equivalent) comes back as a plan refusal, not a hang", async () => {
  // One present-and-detectable agent, no `manage` field in the request
  // body — collectOnboardPlan's own non-interactive refusal path
  // (resolveManagedAgents, gated on `!opts.json`) must fire unconditionally
  // when `manage` is omitted, proving this endpoint is safe to call from a
  // wizard step that hasn't collected every answer yet, rather than the
  // request simply never resolving because the real code underneath tried
  // to prompt a terminal this sidecar process doesn't have.
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-planapply-onboard-refusal-"));
  cli(homeDir, ["init"]);
  writeFileSync(join(homeDir, ".claude.json"), "{}\n");

  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/onboard", {});
    assert.equal(planned.status, 200, "a refusal is still a 200 with a plan payload, same as the CLI's own --json refusal shape — not an HTTP error");
    const { plan } = planned.body as { plan: { refusal?: string } };
    assert.match(plan.refusal ?? "", /--manage|terminal/i, "must refuse with the same actionable message runOnboard --json would print, not hang");
  } finally {
    server.close();
  }
});

test("plan/apply mcp-import: a real mcpServers export file is imported into servers.yaml, secrets extracted to the local env file, never into the plan", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-planapply-import-"));
  cli(homeDir, ["init"]);

  const exportFile = join(homeDir, "export.json");
  writeFileSync(
    exportFile,
    JSON.stringify({
      mcpServers: {
        "imported-server": {
          command: "npx",
          args: ["-y", "some-mcp-server"],
          env: { SOME_API_KEY: "sk-this-is-a-real-looking-secret-value" },
        },
      },
    }),
  );

  const server = createSidecarServer(createPlanApplyRoutes(homeDir, new PlanStore()));
  const port = await listenOnEphemeralLoopbackPort(server);
  try {
    const planned = await post(port, "/plan/mcp-import", { path: exportFile });
    assert.equal(planned.status, 200);
    const { planId, plan } = planned.body as { planId: string; plan: { items: Array<{ name: string; action: string }> } };
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].name, "imported-server");
    assert.equal(plan.items[0].action, "create");
    assert.doesNotMatch(JSON.stringify(plan), /sk-this-is-a-real-looking-secret-value/, "the plan sent over HTTP must never carry the real secret value");
    assert.equal(serversYaml(homeDir).includes("imported-server"), false, "the plan step alone must not have written anything yet");

    const applied = await post(port, "/apply/mcp-import", { planId });
    assert.equal(applied.status, 200);
    assert.match(serversYaml(homeDir), /imported-server:/, "a confirmed apply must actually write the server into servers.yaml");
    assert.doesNotMatch(serversYaml(homeDir), /sk-this-is-a-real-looking-secret-value/, "servers.yaml itself must never carry the literal secret value");

    const localEnvPath = join(homeDir, ".trellis", "mcp", "servers.local.env");
    assert.ok(existsSync(localEnvPath), "the real secret value must land in the local, gitignored env file instead");
    assert.match(readFileSync(localEnvPath, "utf-8"), /SOME_API_KEY=sk-this-is-a-real-looking-secret-value/);
  } finally {
    server.close();
  }
});
