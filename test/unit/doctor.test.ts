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
  detectCaseMismatches,
  detectCollisions,
  detectCrossAgentDrift,
  detectDuplication,
  resolveKnownHostInjected,
} from "../../src/commands/doctor.js";
import type { AgentSnapshot, AgentSnapshotSkillEntry } from "../../src/core/types.js";

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
