/**
 * Exercises openspec/changes/trellis-doctor-p0/specs/capability-drift-detection/spec.md's
 * scenarios directly against synthetic AgentSnapshots — no real agent
 * needs to be installed to verify this comparison logic.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_KNOWN_HOST_INJECTED,
  collectDoctorReport,
  detectCaseMismatches,
  detectCollisions,
  detectCrossAgentDrift,
  detectDuplication,
  detectRuntimeDrift,
  resolveKnownHostInjected,
} from "../../src/commands/doctor.js";
import { readToken, writeToken } from "../../src/lib/oauth/store.js";
import type { AgentSnapshot, AgentSnapshotSkillEntry } from "../../src/core/types.js";
import { scratchHome as sharedScratchHome, seedAgentPresence, seedCanonical } from "../helpers/home.js";

function scratchHome(): string {
  return sharedScratchHome("doctor-report");
}

function skill(overrides: Partial<AgentSnapshotSkillEntry> & { name: string; realDir: string }): AgentSnapshotSkillEntry {
  return { dir: overrides.realDir, isSymlink: false, caseCorrect: true, ...overrides };
}

function snapshot(agent: AgentSnapshot["agent"], overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { agent, present: true, skillRoots: [], mcpServers: [], diagnostics: [], ...overrides };
}

test("cross-agent drift: same skill, same realpath — no finding", () => {
  const snapshots = [
    snapshot("claude-code", { skillRoots: [{ path: "/c", isSymlink: false, skills: [skill({ name: "foo", realDir: "/shared/foo" })] }] }),
    snapshot("codex", { skillRoots: [{ path: "/x", isSymlink: false, skills: [skill({ name: "foo", realDir: "/shared/foo" })] }] }),
  ];
  assert.deepEqual(detectCrossAgentDrift(snapshots), []);
});

test("cross-agent drift: same name, different realpath — drift finding names both agents", () => {
  const snapshots = [
    snapshot("claude-code", { skillRoots: [{ path: "/c", isSymlink: false, skills: [skill({ name: "foo", realDir: "/a/foo" })] }] }),
    snapshot("kiro", { skillRoots: [{ path: "/k", isSymlink: false, skills: [skill({ name: "foo", realDir: "/b/foo" })] }] }),
  ];
  const findings = detectCrossAgentDrift(snapshots);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /claude-code=\/a\/foo/);
  assert.match(findings[0].message, /kiro=\/b\/foo/);
});

test("duplication: physical duplicate alongside a symlinked entry is flagged, identifying the non-symlinked path", () => {
  const snap = snapshot("codex", {
    skillRoots: [
      { path: "/agents/skills", isSymlink: false, skills: [skill({ name: "foo", dir: "/agents/skills/foo", realDir: "/source/foo", isSymlink: true })] },
      { path: "/codex/skills", isSymlink: false, skills: [skill({ name: "foo", dir: "/codex/skills/foo", realDir: "/source/foo", isSymlink: false })] },
    ],
  });
  const findings = detectDuplication([snap]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /\/codex\/skills\/foo/);
});

test("duplication: all skills symlinked — no finding", () => {
  const snap = snapshot("codex", {
    skillRoots: [
      { path: "/agents/skills", isSymlink: false, skills: [skill({ name: "foo", dir: "/agents/skills/foo", realDir: "/source/foo", isSymlink: true })] },
    ],
  });
  assert.deepEqual(detectDuplication([snap]), []);
});

test("collision: static server name also in known_host_injected is flagged, Codex gets the failure-class note", () => {
  const snap = snapshot("codex", { mcpServers: [{ name: "sentry", transport: "stdio" }] });
  const findings = detectCollisions([snap], ["atlassian", "sentry", "memory", "mirasim"]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /url is not supported for stdio/);
});

test("collision: no overlap — clean", () => {
  const snap = snapshot("claude-code", { mcpServers: [{ name: "tanka", transport: "stdio" }] });
  assert.deepEqual(detectCollisions([snap], ["atlassian", "sentry", "memory", "mirasim"]), []);
});

test("runtime drift: missing canonical runtime entry is reported, present entry is clean", () => {
  const canonical = {
    managedAgents: ["codex"] as const,
    mcp: { servers: {}, knownHostInjected: [], runtime: { delivery: { codex: "mcp" as const } } },
    secretsPolicy: { allowedVars: [], rejectPatterns: [] },
  };
  const missing = detectRuntimeDrift([snapshot("codex")], canonical);
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /trellis/);

  const present = detectRuntimeDrift([snapshot("codex", { mcpServers: [{ name: "trellis", transport: "stdio" }] })], canonical);
  assert.deepEqual(present, []);
});

test("case mismatch: wrong-case entry file is flagged, distinguishable from absent", () => {
  const snap = snapshot("kiro", {
    skillRoots: [
      { path: "/kiro/skills", isSymlink: false, skills: [skill({ name: "broken-case-skill", realDir: "/kiro/skills/broken-case-skill", caseCorrect: false })] },
    ],
  });
  const findings = detectCaseMismatches([snap]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /broken-case-skill/);
});

test("resolveKnownHostInjected: an explicit override always wins, no canonical lookup needed", () => {
  const result = resolveKnownHostInjected({ knownHostInjected: ["custom"] });
  assert.deepEqual(result, ["custom"]);
});

test("resolveKnownHostInjected: a real canonical source's known_host_injected is used (trellis-cli-init)", () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-doctor-canonical-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(
    join(home, ".trellis", "mcp", "servers.yaml"),
    "servers: {}\nknown_host_injected:\n  - a-real-machine-specific-connector\n",
  );

  const result = resolveKnownHostInjected({ homeDir: home });
  assert.deepEqual(result, ["a-real-machine-specific-connector"]);
  assert.notDeepEqual(result, DEFAULT_KNOWN_HOST_INJECTED);
});

test("resolveKnownHostInjected: no canonical source falls back to the hardcoded default (P0, unchanged)", () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-doctor-no-canonical-"));
  const result = resolveKnownHostInjected({ homeDir: home });
  assert.deepEqual(result, DEFAULT_KNOWN_HOST_INJECTED);
});

// trellis-onboard-closed-loop D1: collectDoctorReport gained a homeDir
// parameter specifically so onboard's own tests — and onboard itself,
// run against an explicit home — never probe the real ~.

test("collectDoctorReport: a scratch home with a distinctively-named agent reports it, scoped to that home", async () => {
  const home = scratchHome();
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "trellis-doctor-report-marker": { command: "true" } } }));

  const report = await collectDoctorReport(home);
  const claudeCode = report.snapshots.find((s) => s.agent === "claude-code");

  assert.equal(claudeCode?.present, true);
  assert.ok(claudeCode?.mcpServers.some((s) => s.name === "trellis-doctor-report-marker"));
});

test("collectDoctorReport: an empty scratch home reports every agent absent, never falling through to the real ~", async () => {
  const home = scratchHome();

  const report = await collectDoctorReport(home);

  assert.equal(report.snapshots.length, 6);
  for (const snapshot of report.snapshots) {
    assert.equal(snapshot.present, false, `${snapshot.agent} must not be present — an empty scratch home has none of its config files`);
  }
});

test("collectDoctorReport: homeDir defaults to the real ~ — the same seam every other probe uses", async () => {
  // Not a claim about what the real machine has installed (that varies);
  // only that omitting homeDir doesn't throw and resolves against a real
  // path, matching every probe's own `homeDir: string = homedir()` default.
  const report = await collectDoctorReport();
  assert.equal(report.snapshots.length, 6);
});

// trellis-mcp-oauth-renew tasks.md 3.2: doctor's OAuth section — the same
// classifier `mcp renew` consumes (design.md D2), strictly read-only
// (design.md D4): no token endpoint exists in these fixtures at all, so
// any network attempt would fail the test by hanging/erroring.

function canonicalHomeWithOAuth(serversYaml: string): string {
  const home = scratchHome();
  mkdirSync(join(home, ".trellis", "mcp", "oauth"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  return home;
}

const OAUTH_YAML = `servers:
  remote:
    transport: http
    url: "https://example.test/mcp"
    auth:
      kind: oauth
      owner: trellis
`;

test("doctor oauth: a valid credential yields a valid entry and no finding", async () => {
  const home = canonicalHomeWithOAuth(OAUTH_YAML);
  writeToken(home, "remote", { accessToken: "a", expiresAt: Date.now() + 3_600_000 });

  const report = await collectDoctorReport(home);

  assert.deepEqual(report.oauth, [{ server: "remote", status: "valid", expiresAt: report.oauth?.[0]?.expiresAt }]);
  assert.ok(!report.findings.some((f) => f.kind === "oauth-expired"));
});

test("doctor oauth: an expired credential yields an oauth-expired finding naming both remediations", async () => {
  const home = canonicalHomeWithOAuth(OAUTH_YAML);
  writeToken(home, "remote", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1000 });

  const report = await collectDoctorReport(home);

  assert.equal(report.oauth?.[0]?.status, "expired");
  const finding = report.findings.find((f) => f.kind === "oauth-expired");
  assert.ok(finding, "a credential that will 401 on next use is exactly what doctor exists to catch first (design.md D4)");
  assert.match(finding.message, /remote/);
  assert.match(finding.message, /trellis mcp renew/);
  assert.match(finding.message, /trellis mcp auth remote/);
});

test("doctor oauth: a classified server with no token is absent plus a finding; the token stays unwritten", async () => {
  const home = canonicalHomeWithOAuth(OAUTH_YAML);

  const report = await collectDoctorReport(home);

  assert.equal(report.oauth?.[0]?.status, "absent");
  assert.ok(report.findings.some((f) => f.kind === "oauth-expired" && /never been authorized/.test(f.message)));
  assert.equal(readToken(home, "remote"), undefined, "doctor stays read-only (design.md D4)");
});

test("doctor oauth: a token file for an unclassified server is ignored — classification is explicit (design.md D5)", async () => {
  const home = canonicalHomeWithOAuth(`servers:
  ordinary:
    transport: http
    url: "https://example.test/mcp"
`);
  writeToken(home, "ordinary", { accessToken: "a", expiresAt: Date.now() - 1000 });

  const report = await collectDoctorReport(home);

  assert.equal(report.oauth, undefined);
  assert.ok(!report.findings.some((f) => f.kind === "oauth-expired"));
});

test("doctor oauth: an agent-owned server is never a finding — its credential is the Agent client's, not Trellis's", async () => {
  // trellis-desktop-oauth-ownership: scalar `auth: oauth` defaults to
  // agent-owned. Without this exclusion doctor would cry wolf on every
  // healthy native authorization (real machine: figma authorized inside
  // Claude Code, Trellis's store empty by design).
  const home = canonicalHomeWithOAuth(`servers:
  figma:
    transport: http
    url: "https://mcp.figma.com/mcp"
    auth: oauth
`);

  const report = await collectDoctorReport(home);

  assert.equal(report.oauth, undefined);
  assert.ok(!report.findings.some((f) => f.kind === "oauth-expired"));
});

test("doctor oauth: no canonical source — section absent, doctor still works standalone", async () => {
  const home = scratchHome();

  const report = await collectDoctorReport(home);

  assert.equal(report.oauth, undefined);
});

test("doctor oauth: oauth-expired fails the run, alongside the other non-zero kinds", async () => {
  const home = canonicalHomeWithOAuth(OAUTH_YAML);
  writeToken(home, "remote", { accessToken: "a", expiresAt: Date.now() - 1000 });

  const report = await collectDoctorReport(home);
  // Mirror runDoctor's own exit computation — the finding kind, not some
  // parallel flag, is what must drive non-zero (spec: "contributes to a
  // non-zero doctor exit code").
  const wouldExitNonZero = report.findings.some((f) => f.kind === "oauth-expired");

  assert.equal(wouldExitNonZero, true);
});
