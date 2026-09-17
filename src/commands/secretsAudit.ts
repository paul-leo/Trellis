/**
 * `trellis secrets audit` — reads every present, MCP-capable agent's real
 * config file and checks it against `CanonicalSource.secretsPolicy`: a
 * literal-value scan against `rejectPatterns`, and a declared-env-var-name
 * check against `allowedVars`. Also checks, agent-agnostically, whether
 * every env var name declared across canonical `mcp.servers[*].env`
 * actually resolves to a value via the same `resolveSecretEnv` the pi
 * bridge uses (trellis-secrets-env-management) — authoritative for pi, a
 * best-effort proxy for the other three (design.md D3 in that change).
 *
 * Also scans canonical's own `mcp/servers.yaml` for the reject-pattern
 * literal-value check (trellis-migrate-extract-static-env-secrets design.md
 * D11): a literal in `command`/`url`/`args`/`headers` is now accepted into
 * canonical by `migrate` rather than refused (no natural name to extract
 * to, or no `${VAR}` resolution proven for every consumer), so canonical
 * is no longer guaranteed clean by construction the way it used to be —
 * this keeps that acceptance from being silent. Never the
 * unexpected-var-name check, which is about agent-native serialized
 * `env`/`env_vars` syntax specifically. Read-only — never writes
 * anything. Fails non-zero on any finding (trellis-secrets-audit-p3).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCanonicalSource } from "../core/canonical.js";
import type { AgentId, McpServerDef, SecretsPolicy } from "../core/types.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { KiroAdapter } from "../adapters/kiro.js";
import { declaredEnvNames, extractJsonEnvVarNames, extractTomlEnvVarNames } from "../lib/envVarNames.js";
import { resolveSecretEnv } from "../lib/secretEnv.js";

export interface RunSecretsAuditOptions {
  json?: boolean;
  /** Same test/sandbox-only seam as every other command — never a CLI
   * flag. See docs/architecture.md's testing philosophy. */
  homeDir?: string;
  /** Onboard-only seam — see RunSyncOptions.managedAgents. Never a CLI
   * flag. */
  managedAgents?: readonly AgentId[];
}

export interface SecretsFinding {
  /** "environment" for `missing-env-value` — that check isn't scoped to
   * any single agent's config file. "canonical" for a literal found in
   * `~/.trellis/mcp/servers.yaml` itself (see module doc comment). */
  agent: AgentId | "environment" | "canonical";
  file: string;
  kind: "literal-secret" | "unexpected-var-name" | "missing-env-value";
  detail: string;
}

export interface SecretsAuditReport {
  findings: SecretsFinding[];
}

interface AuditedAgent {
  id: AgentId;
  probe: () => Promise<{ present: boolean }>;
  configPath: (homeDir: string) => string;
  extractNames: (content: string) => string[];
}

/** Only agents in `managedAgents` — a present-but-unmanaged agent's config
 * file is never even read (trellis-managed-agents), same restriction as
 * `sync`/`mcp sync`. pi has no static, generated MCP config file to audit
 * regardless of management — its bridge reads mcp/servers.yaml directly at
 * its own runtime (P4). See design.md Non-Goals in trellis-secrets-audit-p3. */
function auditedAgents(homeDir: string, managedAgents: readonly AgentId[]): AuditedAgent[] {
  const all: AuditedAgent[] = [
    { id: "claude-code", probe: () => new ClaudeCodeAdapter(homeDir).probe(), configPath: (h) => join(h, ".claude.json"), extractNames: extractJsonEnvVarNames },
    { id: "codex", probe: () => new CodexAdapter(homeDir).probe(), configPath: (h) => join(h, ".codex", "config.toml"), extractNames: extractTomlEnvVarNames },
    { id: "kiro", probe: () => new KiroAdapter(homeDir).probe(), configPath: (h) => join(h, ".kiro", "settings", "mcp.json"), extractNames: extractJsonEnvVarNames },
  ];
  return all.filter((a) => managedAgents.includes(a.id));
}

/**
 * Not scoped to any agent, present or not — a name that can't resolve is
 * a problem regardless of which agents' `servers.yaml` `agents:` field
 * would route it to (trellis-secrets-env-management design.md D3).
 */
function findMissingEnvValues(servers: Record<string, McpServerDef>, policy: SecretsPolicy): SecretsFinding[] {
  const names = new Set<string>();
  for (const def of Object.values(servers)) {
    for (const name of declaredEnvNames(def)) names.add(name);
  }
  if (names.size === 0) return [];

  const resolved = resolveSecretEnv([...names], policy);
  const source = policy.envFile ?? "process environment";
  return [...names]
    .filter((name) => !resolved[name])
    .map((name) => ({
      agent: "environment" as const,
      file: source,
      kind: "missing-env-value" as const,
      detail: `"${name}" is declared by a canonical MCP server's env but has no resolvable value`,
    }));
}

/**
 * Reject-pattern-only scan of canonical's own `mcp/servers.yaml` (design.md
 * D11) — no `unexpected-var-name` check here, that one is specifically
 * about names extracted from an agent's own serialized `env`/`env_vars`
 * syntax, not canonical's `env:` name list (which holding a name matching
 * a reject pattern would be an absurd false positive, not a real finding).
 */
function auditCanonicalServersYaml(homeDir: string, policy: SecretsPolicy): SecretsFinding[] {
  const file = join(homeDir, ".trellis", "mcp", "servers.yaml");
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8");
  const findings: SecretsFinding[] = [];
  for (const pattern of policy.rejectPatterns) {
    if (pattern.test(content)) {
      findings.push({ agent: "canonical", file, kind: "literal-secret", detail: `matches reject pattern ${pattern}` });
    }
  }
  return findings;
}

function auditFile(agent: AgentId, file: string, content: string, policy: SecretsPolicy, extractNames: (content: string) => string[]): SecretsFinding[] {
  const findings: SecretsFinding[] = [];

  for (const pattern of policy.rejectPatterns) {
    if (pattern.test(content)) {
      findings.push({ agent, file, kind: "literal-secret", detail: `matches reject pattern ${pattern}` });
    }
  }

  const allowed = new Set(policy.allowedVars);
  for (const name of new Set(extractNames(content))) {
    if (!allowed.has(name)) {
      findings.push({ agent, file, kind: "unexpected-var-name", detail: `"${name}" is not in secrets.policy.yaml's allowed_vars` });
    }
  }

  return findings;
}

export async function collectSecretsAuditReport(opts: RunSecretsAuditOptions = {}): Promise<SecretsAuditReport> {
  const homeDir = opts.homeDir ?? homedir();
  const canonical = loadCanonicalSource(homeDir);
  const managedAgents = opts.managedAgents ?? canonical.managedAgents;
  const findings: SecretsFinding[] = [];

  for (const agent of auditedAgents(homeDir, managedAgents)) {
    const probeResult = await agent.probe();
    if (!probeResult.present) continue;

    const file = agent.configPath(homeDir);
    if (!existsSync(file)) continue;

    const content = readFileSync(file, "utf-8");
    findings.push(...auditFile(agent.id, file, content, canonical.secretsPolicy, agent.extractNames));
  }

  findings.push(...findMissingEnvValues(canonical.mcp.servers, canonical.secretsPolicy));
  findings.push(...auditCanonicalServersYaml(homeDir, canonical.secretsPolicy));

  return { findings };
}

export async function runSecretsAudit(opts: RunSecretsAuditOptions = {}): Promise<{ exitCode: number }> {
  let report: SecretsAuditReport;
  try {
    report = await collectSecretsAuditReport(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { exitCode: 1 };
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return { exitCode: report.findings.length > 0 ? 1 : 0 };
}

/** Exported so `onboard` prints a secrets-audit report identically to
 * running `secrets audit` standalone, instead of a second, easily-drifting
 * copy of this formatting. */
export function printReport(report: SecretsAuditReport): void {
  if (report.findings.length === 0) {
    console.log("✅ no findings — every present agent's real config and every declared env var passed all checks");
    return;
  }
  console.log(`⚠️  ${report.findings.length} finding(s):`);
  for (const finding of report.findings) {
    console.log(`   - [${finding.kind}] ${finding.agent} — ${finding.file}: ${finding.detail}`);
  }
}
