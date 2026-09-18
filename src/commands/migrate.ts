/**
 * `trellis migrate --from <agent>` — imports an existing agent's real
 * skills and instructions into canonical source (trellis-cli-migrate).
 * Pure `collectMigratePlan` / effectful `applyMigratePlan`, same
 * plan-then-apply split every adapter already uses.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import * as kimiCodeProbe from "../probes/kimi-code.js";
import { AGENTS_MD_TEMPLATE } from "./init.js";
import { decideDirImport } from "../lib/dirEquals.js";
import { deepEqual } from "../lib/deepEqual.js";
import { readClaudeCodeMcpDefs, readCodexMcpDefs, readKiroMcpDefs, readKimiCodeMcpDefs, resolvedEnvTextMap } from "../lib/mcpMigrateRead.js";
import { parseDotenv, writeLocalSecretValue } from "../lib/secretEnv.js";
import { findLiteralSecret } from "../adapters/mcpPlan.js";
import { ensureGitignoreEntry, ensureShellEnvSource, loadCanonicalSource, upsertServerYaml, writeSecretsPolicyExtraction } from "../core/canonical.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId, AgentSnapshot, McpServerDef, SecretsPolicy } from "../core/types.js";

/** Where a `staticEnv` literal secret's real value goes when
 * `secrets.policy.yaml` doesn't already have its own `env_file`
 * (trellis-migrate-extract-static-env-secrets design.md D3) — a sibling
 * of `servers.yaml`, so "the mcp stuff" stays one directory rather than
 * a second, disconnected location. `~`-form for what gets written into
 * `secrets.policy.yaml` itself (portable across machines); resolved form
 * for real file I/O. */
const DEFAULT_LOCAL_SECRETS_ENV_FILE_TILDE = "~/.trellis/mcp/servers.local.env";

function defaultLocalSecretsEnvFilePath(homeDir: string): string {
  return join(homeDir, ".trellis", "mcp", "servers.local.env");
}

/** Picks the rc file `ensureShellEnvSource` writes its one pointer block
 * into, from `$SHELL` — zsh and bash are the only shells Trellis's own
 * dev/CI machines and this feature's real-machine dogfooding have ever
 * exercised; anything else falls back to `.profile`, the POSIX-sh default
 * every shell still sources one way or another. */
function defaultShellRcPath(homeDir: string): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return join(homeDir, ".zshrc");
  if (shell.includes("bash")) return join(homeDir, ".bash_profile");
  return join(homeDir, ".profile");
}

const PROBES: Record<AgentId, (homeDir: string) => Promise<AgentSnapshot>> = {
  "claude-code": (homeDir) => claudeCodeProbe.probe(homeDir),
  codex: (homeDir) => codexProbe.probe(homeDir),
  kiro: (homeDir) => kiroProbe.probe(homeDir),
  pi: (homeDir) => piProbe.probe(homeDir),
  "kimi-code": (homeDir) => kimiCodeProbe.probe(homeDir),
};

/** pi has no static MCP config to read at all (roadmap.md P14/
 * trellis-migrate-mcp-servers) — deliberately absent, not an oversight;
 * `collectMigratePlan` skips the `mcp` category entirely for pi. */
const MCP_READERS: Partial<Record<AgentId, (homeDir: string) => { entries: { name: string; def: McpServerDef }[]; unsupported: { name: string; reason: string }[] }>> = {
  "claude-code": readClaudeCodeMcpDefs,
  kiro: readKiroMcpDefs,
  codex: readCodexMcpDefs,
  "kimi-code": readKimiCodeMcpDefs,
};

export type MigrateAction = "create" | "skip-symlink" | "skip-case-broken" | "skip-unsupported" | "already-migrated" | "reclassify" | "conflict" | "extract-secret";

/** Internal kind naming, unchanged since before `--only` existed
 * (trellis-migrate-category-selection design.md D2) — the CLI-facing
 * flag value is the plural `"skills"`, mapped to this singular `"skill"`
 * in `runMigrate`, not renamed here to avoid touching every existing
 * `MigratePlanItem.kind` comparison for no functional reason. */
export type MigrateKind = "skill" | "instructions" | "mcp";

export interface MigratePlanItem {
  kind: MigrateKind;
  name: string;
  action: MigrateAction;
  detail: string;
  /** Only set (and only meaningful) when `action === "conflict"`: the
   * concrete next action, distinct from `detail`'s restatement of why
   * (trellis-onboard-closed-loop design.md D7). */
  remediation?: string;
  /** Only set when action === "create"; consumed by applyMigratePlan. */
  sourceDir?: string;
  sourceContent?: string;
  /** Only set when kind === "mcp" && (action === "create" || "reclassify"
   * || "extract-secret"). For "extract-secret" this is already the SAFE
   * def — the flagged staticEnv value moved to a name-only `env` entry —
   * never the literal (trellis-migrate-extract-static-env-secrets
   * design.md D7). */
  mcpDef?: McpServerDef;
  /** Only set when action === "extract-secret" — the variable name being
   * extracted and the resolved path its real value will be written to.
   * Deliberately never the real value itself, which never rides on this
   * object at all (design.md D9); `applyMigratePlan` re-reads it fresh
   * from the source agent at apply time. */
  extractVarName?: string;
  extractTargetPath?: string;
  /** Only set when action === "extract-secret" and differs from
   * `extractVarName` — the ORIGINAL `staticEnv` dict key in the source
   * def, needed at apply time to know which key to read/remove there.
   * `extractVarName` (design.md D11's `TRELLIS_<SERVER>_<KEY>` scheme) is
   * a different, synthesized name — the two only coincide for an
   * already-migrated server extracted before this naming scheme existed,
   * which never reaches this action at all (already-migrated instead). */
  extractSourceKey?: string;
}

export interface MigratePlan {
  agent: AgentId;
  present: boolean;
  items: MigratePlanItem[];
}

function planSkill(name: string, sourceDir: string, isSymlink: boolean, caseCorrect: boolean, canonicalDir: string): MigratePlanItem {
  if (isSymlink) {
    return { kind: "skill", name, action: "skip-symlink", detail: "shared in from elsewhere, not this agent's own content" };
  }
  if (!caseCorrect) {
    return { kind: "skill", name, action: "skip-case-broken", detail: "already undiscoverable on at least one other agent — fix on the source before migrating" };
  }
  switch (decideDirImport(sourceDir, canonicalDir)) {
    case "create":
      return { kind: "skill", name, action: "create", detail: `will copy from ${sourceDir}`, sourceDir };
    case "already-present":
      return { kind: "skill", name, action: "already-migrated", detail: "canonical content is byte-identical" };
    case "conflict":
      return {
        kind: "skill",
        name,
        action: "conflict",
        detail: `canonical skills/${name}/ already exists with different content — resolve by hand`,
        remediation: `compare \`~/.trellis/skills/${name}/\` against the source agent's copy and either update canonical by hand or delete the source's copy if canonical's is the one to keep`,
      };
  }
}

function planInstructions(snapshot: AgentSnapshot, canonicalAgentsMd: string): MigratePlanItem | undefined {
  if (!snapshot.instructionsFile) return undefined;
  if (snapshot.instructionsFile.isSymlink) {
    return { kind: "instructions", name: "agents.md", action: "skip-symlink", detail: "source agent's instructions file is itself a symlink, nothing real to read" };
  }
  let sourceContent: string;
  try {
    sourceContent = readFileSync(snapshot.instructionsFile.path, "utf-8");
  } catch (err) {
    return {
      kind: "instructions",
      name: "agents.md",
      action: "conflict",
      detail: `could not read source instructions: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `check that ${snapshot.instructionsFile.path} exists and is readable, then re-run migrate`,
    };
  }

  if (!existsSync(canonicalAgentsMd)) {
    return { kind: "instructions", name: "agents.md", action: "create", detail: "canonical agents.md does not exist yet", sourceContent };
  }
  const current = readFileSync(canonicalAgentsMd, "utf-8");
  if (current === AGENTS_MD_TEMPLATE) {
    return { kind: "instructions", name: "agents.md", action: "create", detail: "canonical agents.md is still trellis init's placeholder", sourceContent };
  }
  if (current === sourceContent) {
    return { kind: "instructions", name: "agents.md", action: "already-migrated", detail: "canonical content is byte-identical" };
  }
  return {
    kind: "instructions",
    name: "agents.md",
    action: "conflict",
    detail: "canonical agents.md already has different real content — resolve by hand",
    remediation: `compare \`~/.trellis/agents.md\` against ${snapshot.instructionsFile.path} and either merge by hand or delete whichever copy you don't want to keep`,
  };
}

/**
 * True when `existing` and `def` differ ONLY in which of `env`/
 * `envAliases`/`staticEnv` an env value is filed under, while every
 * other field and every value's resolved literal/reference text stays
 * identical — the exact shape a migrate-read classification fix (like
 * `trellis-migrate-env-var-alias`) leaves behind on already-migrated
 * canonical data. Not a real conflict: the underlying value never
 * changed, only Trellis's own bucketing of it got more precise
 * (trellis-migrate-reclassify-repair). Anything this doesn't cover — a
 * real value change, a different command, an added/removed field —
 * still conflicts, unchanged.
 */
export function isSafeReclassification(existing: McpServerDef, def: McpServerDef): boolean {
  const { env: _e1, envAliases: _ea1, staticEnv: _se1, ...restExisting } = existing;
  const { env: _e2, envAliases: _ea2, staticEnv: _se2, ...restDef } = def;
  if (!deepEqual(restExisting, restDef)) return false;
  return deepEqual(resolvedEnvTextMap(existing), resolvedEnvTextMap(def));
}

/** Moves `sourceKey` out of `staticEnv` into a name-only `env` reference
 * under `varName` — the def this produces never holds the literal that
 * triggered extraction (trellis-migrate-extract-static-env-secrets
 * design.md D7), safe to upsert into canonical or appear in any output.
 * `sourceKey` and `varName` differ under D11's `TRELLIS_<SERVER>_<KEY>`
 * naming scheme — the source dict key is not, in general, the name the
 * value ends up referenced by. */
function extractedMcpDef(def: McpServerDef, sourceKey: string, varName: string): McpServerDef {
  const remainingStaticEnv = { ...(def.staticEnv ?? {}) };
  delete remainingStaticEnv[sourceKey];
  const result: McpServerDef = { ...def, env: [...(def.env ?? []), varName] };
  if (Object.keys(remainingStaticEnv).length > 0) {
    result.staticEnv = remainingStaticEnv;
  } else {
    delete result.staticEnv;
  }
  return result;
}

/** Uppercase, non-alphanumeric runs collapsed to a single `_`, no leading
 * or trailing `_` — the one sanitization every synthesized name piece
 * shares (design.md D11), so `mcp-router` becomes `MCP_ROUTER` and a
 * header key like `X-Api-Key` becomes `X_API_KEY`. */
function sanitizeEnvNamePart(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "X";
}

/** `TRELLIS_<SERVER>_<KEY>` — the project-wide prefix rules out a
 * collision with anything already in the user's own environment or
 * another tool's convention; the server-name segment rules out two
 * Trellis-managed servers colliding with each other over the same key
 * (design.md D11). Deliberately never the bare source key alone (what
 * the code shipped with initially, and what an already-extracted server
 * predating this scheme still uses — `planStaticEnvExtraction`'s own
 * value-based lookup is what keeps recognizing those, not this
 * function). */
function synthesizeVarName(serverName: string, key: string): string {
  return `TRELLIS_${sanitizeEnvNamePart(serverName)}_${sanitizeEnvNamePart(key)}`;
}

/**
 * Only reached when `findLiteralSecret` matched inside `staticEnv` —
 * `key` is that field's own dict key (design.md D1). Reads the target
 * local-secrets file read-only to decide the outcome; never writes
 * anything itself (planning stays dry-run-safe) and never puts the real
 * value on the returned item (design.md D9) — only used here, in memory,
 * to compare against what's already on disk.
 *
 * The variable name a *new* extraction is filed under is synthesized
 * (design.md D11's `TRELLIS_<SERVER>_<KEY>`, not the bare `key`) — but an
 * already-extracted server may have been extracted before this scheme
 * existed, under the bare key or any other name. Rather than hardcoding
 * "the old scheme was the bare key", this looks up `existing.env` by
 * VALUE: any name already in canonical's `env` list whose local-secrets
 * value already matches `realValue` means this server was already
 * extracted, under whatever name that was, and must keep using it — not
 * get a second, newly-synthesized reference alongside the first.
 */
function planStaticEnvExtraction(name: string, def: McpServerDef, existing: McpServerDef | undefined, homeDir: string, policy: SecretsPolicy, key: string): MigratePlanItem {
  const realValue = def.staticEnv![key];
  const targetPath = policy.envFile ?? defaultLocalSecretsEnvFilePath(homeDir);
  const localSecrets = existsSync(targetPath) ? parseDotenv(readFileSync(targetPath, "utf-8")) : {};

  const priorName = existing?.env?.find((n) => Object.hasOwn(localSecrets, n) && localSecrets[n] === realValue);
  const varName = priorName ?? synthesizeVarName(name, key);
  const safeDef = extractedMcpDef(def, key, varName);
  const alreadyInSecretsFile = Object.hasOwn(localSecrets, varName);

  if (priorName === undefined && alreadyInSecretsFile && localSecrets[varName] !== realValue) {
    return {
      kind: "mcp",
      name,
      action: "conflict",
      detail: `refusing to extract MCP server "${name}"'s "${varName}": ${targetPath} already has a different value for this name — resolve by hand`,
      remediation: `compare the source agent's current value for "${varName}" against the value already in ${targetPath} and update whichever one is stale, then re-run migrate`,
    };
  }

  if (alreadyInSecretsFile && existing !== undefined && deepEqual(existing, safeDef)) {
    return { kind: "mcp", name, action: "already-migrated", detail: `already extracted — "${varName}" is referenced from servers.yaml and its real value is already in ${targetPath}` };
  }

  if (existing !== undefined && !deepEqual(existing, safeDef) && !isSafeReclassification(existing, safeDef)) {
    return {
      kind: "mcp",
      name,
      action: "conflict",
      detail: `canonical mcp/servers.yaml already has a different definition for "${name}" — resolve by hand`,
      remediation: `compare the source agent's own definition for "${name}" against \`~/.trellis/mcp/servers.yaml\` and update canonical by hand if the source's is the one to keep`,
    };
  }

  return {
    kind: "mcp",
    name,
    action: "extract-secret",
    detail: `will extract "${key}" to ${targetPath} as "${varName}", referencing it from servers.yaml instead of holding the literal value`,
    mcpDef: safeDef,
    extractVarName: varName,
    extractTargetPath: targetPath,
    extractSourceKey: key,
  };
}

function planMcpServer(name: string, def: McpServerDef, existing: McpServerDef | undefined, homeDir: string, policy: SecretsPolicy): MigratePlanItem {
  // A `staticEnv` match is extracted (trellis-migrate-extract-static-env-secrets):
  // its own dict key is a natural variable name, and `env`/`env_vars` is
  // the one shape proven to resolve back to a real value for every
  // consumer (pi-bridge, claude-code, codex, kiro). A literal anywhere
  // else (`command`/`url`/`args`/`headers`) has either no natural name to
  // extract to, or no `${VAR}` resolution mechanism proven across every
  // consumer — a fake reference there would be strictly worse than the
  // literal it replaced (an agent silently failing to connect instead of
  // the source agent's own working config). Accepted as ordinary literal
  // config instead (design.md D11), same as if no match were found at
  // all; `secrets audit` keeps flagging canonical itself so this isn't
  // silent.
  const secretMatch = findLiteralSecret(def);
  if (secretMatch?.field === "staticEnv") {
    return planStaticEnvExtraction(name, def, existing, homeDir, policy, secretMatch.key!);
  }
  if (existing === undefined) {
    return { kind: "mcp", name, action: "create", detail: "will add to servers.yaml", mcpDef: def };
  }
  if (deepEqual(existing, def)) {
    return { kind: "mcp", name, action: "already-migrated", detail: "canonical definition is already identical" };
  }
  if (isSafeReclassification(existing, def)) {
    return { kind: "mcp", name, action: "reclassify", detail: "same value, only its internal classification changed — safe to update", mcpDef: def };
  }
  return {
    kind: "mcp",
    name,
    action: "conflict",
    detail: `canonical mcp/servers.yaml already has a different definition for "${name}" — resolve by hand`,
    remediation: `compare the source agent's own definition for "${name}" against \`~/.trellis/mcp/servers.yaml\` and update canonical by hand if the source's is the one to keep`,
  };
}

/**
 * `only` restricts which kind(s) are even considered — not a post-hoc
 * filter on a fully-computed plan (trellis-migrate-category-selection
 * design.md D3): the excluded kind's canonical path is never read for
 * comparison and never appears in the plan, not even as a suppressed
 * conflict. Omitting `only` (or passing both kinds) is exactly today's
 * behavior.
 */
export async function collectMigratePlan(agent: AgentId, homeDir: string = homedir(), only?: readonly MigrateKind[]): Promise<MigratePlan> {
  const snapshot = await PROBES[agent](homeDir);
  if (!snapshot.present) {
    return { agent, present: false, items: [] };
  }

  const canonicalRoot = join(homeDir, ".trellis");
  const items: MigratePlanItem[] = [];
  const wants = (kind: MigrateKind) => !only || only.includes(kind);

  if (wants("skill")) {
    for (const root of snapshot.skillRoots) {
      for (const skill of root.skills) {
        items.push(planSkill(skill.name, skill.dir, skill.isSymlink, skill.caseCorrect, join(canonicalRoot, "skills", skill.name)));
      }
    }
  }

  if (wants("instructions")) {
    const instructionsItem = planInstructions(snapshot, join(canonicalRoot, "agents.md"));
    if (instructionsItem) items.push(instructionsItem);
  }

  if (wants("mcp")) {
    const reader = MCP_READERS[agent];
    if (reader) {
      const canonical = loadCanonicalSource(homeDir);
      const { entries, unsupported } = reader(homeDir);
      for (const { name, def } of entries) {
        items.push(planMcpServer(name, def, canonical.mcp.servers[name], homeDir, canonical.secretsPolicy));
      }
      for (const { name, reason } of unsupported) {
        items.push({ kind: "mcp", name, action: "skip-unsupported", detail: reason });
      }
    }
  }

  return { agent, present: true, items };
}

/**
 * Re-reads the source agent's real MCP entries at apply time to recover
 * `sourceKey`'s current value — deliberately not carried on the plan item
 * itself (design.md D9), so it never rides through a `--json`/`--dry-run`
 * plan object a caller might log or serialize. A cheap, synchronous
 * re-read (the same `MCP_READERS` function `collectMigratePlan` already
 * called), not a second network/probe round-trip. `sourceKey` (the
 * source's own dict key) and `varName` (the synthesized name it's
 * written under, design.md D11) are looked up and written under
 * separately — they are not, in general, the same string.
 */
function applyStaticEnvExtraction(agent: AgentId, serverName: string, sourceKey: string, varName: string, targetPath: string, homeDir: string): void {
  const reader = MCP_READERS[agent];
  const realValue = reader?.(homeDir).entries.find((e) => e.name === serverName)?.def.staticEnv?.[sourceKey];
  if (realValue === undefined) return; // source changed between plan and apply; nothing left to extract

  if (targetPath === defaultLocalSecretsEnvFilePath(homeDir)) {
    ensureGitignoreEntry(join(homeDir, ".trellis", ".gitignore"), "mcp/servers.local.env");
  }
  writeLocalSecretValue(targetPath, varName, realValue);
  writeSecretsPolicyExtraction(join(homeDir, ".trellis", "secrets.policy.yaml"), { varName, envFilePath: DEFAULT_LOCAL_SECRETS_ENV_FILE_TILDE });
}

export function applyMigratePlan(plan: MigratePlan, homeDir: string = homedir()): void {
  const canonicalRoot = join(homeDir, ".trellis");
  for (const item of plan.items) {
    if (item.action !== "create" && item.action !== "reclassify" && item.action !== "extract-secret") continue;
    if (item.kind === "skill" && item.sourceDir) {
      const dest = join(canonicalRoot, "skills", item.name);
      mkdirSync(dest, { recursive: true });
      cpSync(item.sourceDir, dest, { recursive: true });
    } else if (item.kind === "instructions" && item.sourceContent !== undefined) {
      mkdirSync(canonicalRoot, { recursive: true });
      writeFileSync(join(canonicalRoot, "agents.md"), item.sourceContent);
    } else if (item.kind === "mcp" && item.mcpDef) {
      upsertServerYaml(join(canonicalRoot, "mcp", "servers.yaml"), item.name, item.mcpDef);
      if (item.action === "extract-secret" && item.extractVarName && item.extractTargetPath && item.extractSourceKey) {
        applyStaticEnvExtraction(plan.agent, item.name, item.extractSourceKey, item.extractVarName, item.extractTargetPath, homeDir);
      }
    }
  }
  // Runs every real (non-dry-run) migrate invocation, not just the one that
  // performed a fresh extraction — a machine that already extracted a
  // secret before this shell-wiring existed gets fixed the next time
  // migrate runs at all, not only on its next brand-new extraction.
  const envFile = loadCanonicalSource(homeDir).secretsPolicy.envFile;
  if (envFile) {
    ensureShellEnvSource(defaultShellRcPath(homeDir), envFile);
  }
}

/** CLI-facing spelling: `"skills"` (plural — a run usually touches more
 * than one), `"instructions"` (already singular-shaped), or `"mcp"`
 * (already the CLI's own convention, matching `trellis mcp`'s own
 * command name). Mapped to `MigrateKind` in `runMigrate`, the one place
 * this translation lives. */
export type MigrateOnlyValue = "skills" | "instructions" | "mcp";

export interface RunMigrateOptions {
  from?: string;
  /** Restricts the run to one category (`"skills"`, `"instructions"`, or
   * `"mcp"`, raw and unvalidated same as `from` — `runMigrate` checks
   * it). `undefined` means all three, exactly as before `"mcp"` existed. */
  only?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Defaults to the real `~`; overridable for tests only. */
  homeDir?: string;
}

const ONLY_VALUES: readonly MigrateOnlyValue[] = ["skills", "instructions", "mcp"];

function isMigrateOnlyValue(value: string): value is MigrateOnlyValue {
  return (ONLY_VALUES as readonly string[]).includes(value);
}

function toMigrateKinds(only: MigrateOnlyValue): readonly MigrateKind[] {
  if (only === "skills") return ["skill"];
  if (only === "instructions") return ["instructions"];
  return ["mcp"];
}

export async function runMigrate(opts: RunMigrateOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();

  if (!opts.from || !(ALL_AGENTS as readonly string[]).includes(opts.from)) {
    console.error(`--from must be one of: ${ALL_AGENTS.join(", ")} (got ${opts.from ?? "(none)"})`);
    return { exitCode: 1 };
  }
  const agent = opts.from as AgentId;

  if (opts.only !== undefined && !isMigrateOnlyValue(opts.only)) {
    console.error(`--only must be one of: ${ONLY_VALUES.join(", ")} (got ${opts.only})`);
    return { exitCode: 1 };
  }
  const only = opts.only && isMigrateOnlyValue(opts.only) ? toMigrateKinds(opts.only) : undefined;

  const plan = await collectMigratePlan(agent, homeDir, only);
  if (!plan.present) {
    console.error(`${agent} is not present on this machine — nothing to migrate.`);
    return { exitCode: 1 };
  }

  if (!opts.dryRun) {
    applyMigratePlan(plan, homeDir);
  }

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printPlan(plan, opts.dryRun ?? false);
  }

  const hasConflict = plan.items.some((i) => i.action === "conflict");
  return { exitCode: hasConflict ? 1 : 0 };
}

/** Exported so `onboard` prints a migrate plan identically to running
 * `migrate` standalone, instead of a second, easily-drifting copy of
 * this formatting (including the empty-plan "nothing to migrate" case). */
export function printPlan(plan: MigratePlan, dryRun: boolean): void {
  console.log(`${dryRun ? "[dry run] " : ""}migrate --from ${plan.agent}`);
  if (plan.items.length === 0) {
    console.log("  nothing to migrate");
    return;
  }
  for (const item of plan.items) {
    const label = item.kind === "skill" ? `skill "${item.name}"` : item.kind === "mcp" ? `mcp server "${item.name}"` : "instructions";
    console.log(`  [${item.action}] ${label} — ${item.detail}`);
  }
}
