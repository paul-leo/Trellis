/**
 * `trellis doctor` — read-only cross-agent scan. No `.trellis/` canonical
 * source required (docs/roadmap.md): this compares the five agents' own
 * current state against each other, the same manual process used
 * throughout docs/research.md's investigation, now formalized.
 */

import { homedir } from "node:os";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import * as kimiCodeProbe from "../probes/kimi-code.js";
import * as zcodeProbe from "../probes/zcode.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { GATEWAY_ENTRY_NAME, RUNTIME_ENTRY_NAME, resolveMcpPlan } from "../adapters/mcpPlan.js";
import { ALL_AGENTS, isOAuthAuth, oauthOwner } from "../core/types.js";
import { classifyStoredToken, remediationFor } from "../lib/oauth/renew.js";
import { readToken } from "../lib/oauth/store.js";
import type { AgentId, AgentSnapshot, CanonicalSource } from "../core/types.js";

/**
 * Interim default until P1 wires this from `.trellis/mcp/servers.yaml`'s
 * real `known_host_injected` field (P0 has no canonical source at all —
 * docs/roadmap.md). Matches `schema/servers.example.yaml`'s list, which
 * documents mirasim's actual known connectors on this project's own
 * machine.
 */
export const DEFAULT_KNOWN_HOST_INJECTED: readonly string[] = ["atlassian", "sentry", "memory", "mirasim"];

export type FindingKind =
  | "probe-failed"
  | "duplication"
  | "collision"
  | "drift"
  | "case-mismatch"
  | "parse-diagnostic"
  | "runtime-drift"
  | "oauth-expired"
  | "mcp-unreachable";

export interface Finding {
  kind: FindingKind;
  /** Omitted for a finding that names more than one agent (drift). */
  agent?: AgentId;
  message: string;
}

/**
 * Every kind except "mcp-unreachable" fails the run per spec (a specific
 * server not answering its handshake is real information, worth showing,
 * but isn't itself drift/duplication/collision/an incomplete probe — see
 * specs/capability-drift-detection/spec.md's "Non-zero exit" requirement).
 */
const EXIT_NONZERO_KINDS: ReadonlySet<FindingKind> = new Set([
  "probe-failed",
  "duplication",
  "collision",
  "drift",
  "case-mismatch",
  "parse-diagnostic",
  "runtime-drift",
  // A stored credential that will 401 on next use is exactly what doctor
  // exists to catch *before* the session does (trellis-mcp-oauth-renew
  // design.md D4).
  "oauth-expired",
]);

export interface RunDoctorOptions {
  json?: boolean;
  /**
   * Explicit override, mainly for tests. Most callers should leave this
   * unset and let `runDoctor` resolve it itself: canonical source's real
   * `known_host_injected` when `~/.trellis/` exists, `DEFAULT_KNOWN_HOST_INJECTED`
   * otherwise (trellis-cli-init) — the same list `mcp sync`'s own
   * collision refusal already reads, so the two commands agree on one
   * machine instead of each trusting a different source.
   */
  knownHostInjected?: readonly string[];
  /**
   * Off by default. Spawning every configured MCP server for a live
   * handshake is not actually read-only in the sense that matters here:
   * some servers reach real external services with real credentials
   * (OAuth-backed connectors, chrome-devtools-mcp's `--autoConnect`,
   * etc.), and probing all of them serially against a machine with a
   * dozen-plus configured servers made a single run take minutes. Default
   * `trellis doctor` sticks to structural checks (collision, duplication,
   * drift, case) that need no process spawned at all; pass this to also
   * attempt handshakes.
   */
  probeMcp?: boolean;
  /** Defaults to the real `~`; overridable for tests only — same seam
   * every other Trellis entry point uses. */
  homeDir?: string;
}

export interface OAuthHealthEntry {
  server: string;
  status: "valid" | "expired" | "absent" | "unreadable";
  expiresAt?: number;
}

export interface DoctorReport {
  snapshots: AgentSnapshot[];
  findings: Finding[];
  /** Credential health for canonical OAuth-classified servers. Absent
   * when no canonical source exists (doctor stays standalone, P0) or no
   * server is OAuth-classified. Read-only by construction
   * (trellis-mcp-oauth-renew design.md D4). */
  oauth?: OAuthHealthEntry[];
}

/** Exported so tests can assert on this resolution directly, without
 * routing through real per-agent probes `runDoctor` also runs. */
export function resolveKnownHostInjected(opts: RunDoctorOptions): readonly string[] {
  if (opts.knownHostInjected) return opts.knownHostInjected;
  try {
    const canonical = loadCanonicalSource(opts.homeDir);
    return canonical.mcp.knownHostInjected;
  } catch {
    // No canonical source — doctor must still work standalone (P0).
    return DEFAULT_KNOWN_HOST_INJECTED;
  }
}

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<{ exitCode: number }> {
  const report = await collectDoctorReport(opts.homeDir, resolveKnownHostInjected(opts), opts.probeMcp);
  const exitCode = report.findings.some((f) => EXIT_NONZERO_KINDS.has(f.kind)) ? 1 : 0;

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return { exitCode };
}

/**
 * Exported separately from `runDoctor` so tests can assert on findings
 * without capturing stdout — and, since trellis-onboard-closed-loop,
 * so `trellis onboard` can call this against the scratch home its own
 * tests use. `homeDir` defaults to the real `~` so `runDoctor`'s
 * existing call site (which now passes `opts.homeDir`, itself normally
 * `undefined`) is unaffected.
 */
export async function collectDoctorReport(
  homeDir: string = homedir(),
  knownHostInjected: readonly string[] = DEFAULT_KNOWN_HOST_INJECTED,
  probeMcp = false,
): Promise<DoctorReport> {
  const probeList: { agent: AgentId; run: () => Promise<AgentSnapshot> }[] = [
    { agent: "claude-code", run: () => claudeCodeProbe.probe(homeDir, { probeMcp }) },
    { agent: "codex", run: () => codexProbe.probe(homeDir, { probeMcp }) },
    { agent: "kiro", run: () => kiroProbe.probe(homeDir, { probeMcp }) },
    { agent: "pi", run: () => piProbe.probe(homeDir) },
    { agent: "kimi-code", run: () => kimiCodeProbe.probe(homeDir, { probeMcp }) },
    { agent: "zcode", run: () => zcodeProbe.probe(homeDir, { probeMcp }) },
  ];

  // One agent erroring must not blank the other three's results.
  const settled = await Promise.allSettled(probeList.map((p) => p.run()));

  const snapshots: AgentSnapshot[] = [];
  const findings: Finding[] = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      snapshots.push(result.value);
    } else {
      findings.push({
        kind: "probe-failed",
        agent: probeList[index].agent,
        message: `probe failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      });
    }
  });

  let canonical: ReturnType<typeof loadCanonicalSource> | undefined;
  try {
    canonical = loadCanonicalSource(homeDir);
  } catch {
    // Doctor remains useful as a standalone cross-agent scanner when
    // canonical has not been initialized yet.
  }

  const oauth = canonical ? collectOAuthHealth(homeDir, canonical) : [];
  findings.push(
    ...detectDuplication(snapshots),
    ...detectCollisions(snapshots, knownHostInjected),
    ...detectCrossAgentDrift(snapshots),
   ...detectCaseMismatches(snapshots),
   ...detectParseDiagnostics(snapshots),
    ...(canonical ? detectRuntimeDrift(snapshots, canonical) : []),
   ...detectMcpUnreachable(snapshots),
    ...oauth.flatMap((entry) => (entry.status === "valid" ? [] : [oauthFinding(entry)])),
  );

  return { snapshots, findings, ...(oauth.length > 0 ? { oauth } : {}) };
}

/**
 * Read-only OAuth credential health (trellis-mcp-oauth-renew design.md
 * D4): classified from the stored token file alone — no token endpoint,
 * no writes. Scope is canonical Trellis-owned OAuth servers only, the
 * same rule `trellis mcp renew` iterates (design.md D5 +
 * trellis-desktop-oauth-ownership: an agent-owned server's authorization
 * lives in the Agent's own client, so Trellis's empty token store for it
 * is expected, never a finding), via the same classifier (design.md D2).
 */
export function collectOAuthHealth(homeDir: string, canonical: Pick<CanonicalSource, "mcp">): OAuthHealthEntry[] {
  return Object.entries(canonical.mcp.servers)
    .filter(([, def]) => isOAuthAuth(def.auth) && oauthOwner(def.auth) === "trellis")
    .map(([name]) => name)
    .sort()
    .map((name) => {
      const status = classifyStoredToken(homeDir, name);
      const expiresAt = readToken(homeDir, name)?.expiresAt;
      const collapsed: OAuthHealthEntry["status"] =
        status === "valid" ? "valid"
        : status === "no-token" ? "absent"
        : status === "unreadable" ? "unreadable"
        : "expired";
      return { server: name, status: collapsed, ...(expiresAt !== undefined ? { expiresAt } : {}) };
    });
}

function oauthFinding(entry: OAuthHealthEntry): Finding {
  const reason =
    entry.status === "absent" ? "has never been authorized"
    : entry.status === "unreadable" ? "has an unreadable credential file"
    : "has an expired stored token";
  return {
    kind: "oauth-expired",
    message: `OAuth server "${entry.server}" ${reason} — ${remediationFor(
      entry.status === "expired" ? "expired-renewable" : "needs-auth",
      entry.server,
    )}`,
  };
}

/**
 * Within one agent, across all of its skill roots: any realpath reached by
 * more than one entry, where at least one of those entries is NOT a
 * symlink, is a physical duplicate — design.md D3 / the Codex `openspec-*`
 * incident this check exists to catch again if it recurs. Two symlinks
 * sharing a realpath is the expected, already-deduplicated case: no finding.
 */
export function detectDuplication(snapshots: AgentSnapshot[]): Finding[] {
  const findings: Finding[] = [];
  for (const snap of snapshots) {
    if (!snap.present) continue;
    const byRealDir = new Map<string, AgentSnapshot["skillRoots"][number]["skills"]>();
    for (const root of snap.skillRoots) {
      for (const skill of root.skills) {
        const bucket = byRealDir.get(skill.realDir) ?? [];
        bucket.push(skill);
        byRealDir.set(skill.realDir, bucket);
      }
    }
    for (const bucket of byRealDir.values()) {
      if (bucket.length < 2) continue;
      const nonSymlinkEntries = bucket.filter((s) => !s.isSymlink);
      for (const entry of nonSymlinkEntries) {
        findings.push({
          kind: "duplication",
          agent: snap.agent,
          message: `physical duplicate skill "${entry.name}" at ${entry.dir} — same content already reachable elsewhere; should be a symlink or removed`,
        });
      }
    }
  }
  return findings;
}

const CODEX_STDIO_URL_CRASH_NOTE =
  ' On Codex specifically, this crashes the entire process at startup ("url is not supported for stdio"), not just this one server — see docs/research.md.';

/**
 * A statically configured server name that also appears in
 * `known_host_injected` — see docs/research.md "Codex — three hard
 * constraints" #3 for why this is worth catching before it happens rather
 * than after.
 */
export function detectCollisions(snapshots: AgentSnapshot[], knownHostInjected: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const known = new Set(knownHostInjected);
  for (const snap of snapshots) {
    if (!snap.present) continue;
    for (const server of snap.mcpServers) {
      if (known.has(server.name)) {
        findings.push({
          kind: "collision",
          agent: snap.agent,
          message: `MCP server "${server.name}" is statically configured but also appears in known_host_injected.${snap.agent === "codex" ? CODEX_STDIO_URL_CRASH_NOTE : ""}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Same skill name, different realpath, across two or more DISTINCT
 * agents. An agent reporting the same name from two of its own roots is a
 * separate case (already covered by `detectDuplication` when the
 * realpaths match, and not yet a specified finding class when they don't)
 * — deliberately not conflated with cross-agent drift here.
 */
export function detectCrossAgentDrift(snapshots: AgentSnapshot[]): Finding[] {
  const findings: Finding[] = [];
  const byName = new Map<string, Map<AgentId, string>>();

  for (const snap of snapshots) {
    if (!snap.present) continue;
    for (const root of snap.skillRoots) {
      for (const skill of root.skills) {
        let perAgent = byName.get(skill.name);
        if (!perAgent) {
          perAgent = new Map();
          byName.set(skill.name, perAgent);
        }
        if (!perAgent.has(snap.agent)) {
          perAgent.set(snap.agent, skill.realDir);
        }
      }
    }
  }

  for (const [name, perAgent] of byName) {
    if (perAgent.size < 2) continue;
    if (new Set(perAgent.values()).size < 2) continue;
    const detail = [...perAgent.entries()].map(([agent, realDir]) => `${agent}=${realDir}`).join(", ");
    findings.push({ kind: "drift", message: `skill "${name}" resolves to different sources across agents: ${detail}` });
  }
  return findings;
}

export function detectCaseMismatches(snapshots: AgentSnapshot[]): Finding[] {
  const findings: Finding[] = [];
  for (const snap of snapshots) {
    if (!snap.present) continue;
    for (const root of snap.skillRoots) {
      for (const skill of root.skills) {
        if (!skill.caseCorrect) {
          findings.push({
            kind: "case-mismatch",
            agent: snap.agent,
            message: `skill "${skill.name}" at ${skill.dir} has a wrong-case entry file (expected exact "SKILL.md") — silently dropped from discovery on at least one target agent (Codex)`,
          });
        }
      }
    }
  }
  return findings;
}

export function detectParseDiagnostics(snapshots: AgentSnapshot[]): Finding[] {
  const findings: Finding[] = [];
  for (const snap of snapshots) {
    for (const message of snap.diagnostics) {
      findings.push({ kind: "parse-diagnostic", agent: snap.agent, message });
    }
  }
  return findings;
}

export function detectMcpUnreachable(snapshots: AgentSnapshot[]): Finding[] {
  const findings: Finding[] = [];
  for (const snap of snapshots) {
    if (!snap.present) continue;
    for (const server of snap.mcpServers) {
      if (server.probe && !server.probe.ok) {
        findings.push({
          kind: "mcp-unreachable",
          agent: snap.agent,
          message: `MCP server "${server.name}" did not respond to handshake: ${server.probe.error ?? "unknown error"}`,
        });
      }
    }
  }
  return findings;
}

/** Compares runtime entries against the same canonical MCP plan that sync
 * uses. Only missing Trellis-owned runtime edges are reported; extra
 * user-authored MCP entries remain outside doctor ownership. */
export function detectRuntimeDrift(
  snapshots: AgentSnapshot[],
  canonical: Pick<ReturnType<typeof loadCanonicalSource>, "mcp" | "managedAgents" | "secretsPolicy">,
): Finding[] {
  const findings: Finding[] = [];
  for (const snap of snapshots) {
    if (!snap.present || !canonical.managedAgents.includes(snap.agent) || snap.agent === "pi") continue;
    const expected = resolveMcpPlan(snap.agent, canonical.mcp, canonical.managedAgents, canonical.secretsPolicy).desired
      .map((entry) => entry.name)
      .filter((name) => name === RUNTIME_ENTRY_NAME || name === GATEWAY_ENTRY_NAME);
    const actual = new Set(snap.mcpServers.map((server) => server.name));
    for (const name of expected) {
      if (!actual.has(name)) {
        findings.push({
          kind: "runtime-drift",
          agent: snap.agent,
          message: "canonical expects MCP runtime entry \"" + name + "\" for " + snap.agent + ", but it is missing from the agent static configuration",
        });
      }
    }
  }
  return findings;
}

/** Exported so `trellis onboard` can reuse it verbatim for its own final
 * stage (trellis-onboard-closed-loop) rather than a second copy of this
 * formatting. */
export function printReport(report: DoctorReport): void {
  const byAgent = new Map<AgentId, Finding[]>();
  const crossAgent: Finding[] = [];
  for (const finding of report.findings) {
    if (finding.agent) {
      const list = byAgent.get(finding.agent) ?? [];
      list.push(finding);
      byAgent.set(finding.agent, list);
    } else {
      crossAgent.push(finding);
    }
  }

  for (const agent of ALL_AGENTS) {
    const snap = report.snapshots.find((s) => s.agent === agent);
    if (!snap) {
      console.log(`❌ ${agent} — probe did not complete`);
      continue;
    }
    if (!snap.present) {
      console.log(`—  ${agent} (not installed)`);
      continue;
    }
    const agentFindings = byAgent.get(agent) ?? [];
    const label = `${agent}${snap.version ? ` (${snap.version})` : ""}`;
    if (agentFindings.length === 0) {
      console.log(`✅ ${label}`);
      continue;
    }
    console.log(`⚠️  ${label} — ${agentFindings.length} finding(s)`);
    for (const finding of agentFindings) {
      console.log(`   - ${finding.message}`);
    }
  }

  if (report.oauth && report.oauth.length > 0) {
    console.log("\nOAuth credentials:");
    for (const entry of report.oauth) {
      const expiry = entry.expiresAt !== undefined ? ` (expires ${new Date(entry.expiresAt).toISOString()})` : "";
      const icon = entry.status === "valid" ? "✅" : "❌";
      console.log(`${icon} ${entry.server} — ${entry.status}${expiry}`);
    }
  }

  if (crossAgent.length > 0) {
    console.log("\nCross-agent:");
    for (const finding of crossAgent) {
      console.log(`⚠️  ${finding.message}`);
    }
  }
}
