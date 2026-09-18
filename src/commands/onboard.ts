/**
 * `trellis onboard` — chains `init` → agent detection → migration-source
 * resolution → migrate-category selection (trellis-migrate-category-
 * selection) → managed-agent-set selection (install-then-manage for a
 * selected, not-yet-present agent) → `migrate` → `sync` → `mcp sync` →
 * `secrets audit` into one guided flow (trellis-cli-onboard,
 * trellis-managed-agents) — a user should never have to type a second
 * command by hand to finish onboarding. Source, categories, and managed
 * set are three independent choices (design.md D2): importing from a
 * source never writes back to it, and it is not implicitly added to the
 * managed set. Orchestrates existing commands' own plan/apply logic; no
 * new skill-copy, symlink, conflict-detection, or secrets-scanning
 * judgment is made here.
 */

import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canUseInteractivePicker, runMultiSelectPicker, runSearchMultiSelectPicker, runSingleSelectPicker } from "../lib/terminalPicker.js";
import * as claudeCodeProbe from "../probes/claude-code.js";
import * as codexProbe from "../probes/codex.js";
import * as kiroProbe from "../probes/kiro.js";
import * as piProbe from "../probes/pi.js";
import * as kimiCodeProbe from "../probes/kimi-code.js";
import { ALL_AGENTS } from "../core/types.js";
import type { AgentId, AgentSnapshot, McpConfig } from "../core/types.js";
import { loadCanonicalSource, removeServerYaml, upsertServerYaml, writeMcpModeYaml, writeMcpRoutesYaml, writeMcpRuntimeDeliveryYaml } from "../core/canonical.js";
import type { McpMode } from "../core/canonical.js";
import { buildCapabilityInventory, parseCapabilitySelectionFile, resolveSelectedNames, selectionContains, type CapabilityInventory, type CapabilitySelection } from "../core/capabilitySelection.js";
import { INSTALL_HINTS, collectInitReport } from "./init.js";
import { applyMigratePlan, collectMigratePlan, printPlan as printMigratePlan } from "./migrate.js";
import type { MigrateKind, MigratePlan, MigratePlanItem } from "./migrate.js";
import { collectSyncReport, printReport as printSyncReport } from "./sync.js";
import type { SyncReport } from "./sync.js";
import { collectMcpSyncReport, printReport as printMcpSyncReport } from "./mcp.js";
import type { McpSyncReport } from "./mcp.js";
import { collectSecretsAuditReport, printReport as printSecretsAuditReport } from "./secretsAudit.js";
import type { SecretsAuditReport } from "./secretsAudit.js";
import { applyMemorySync, collectMemorySyncResult, printMemorySyncResult, DEFAULT_MEMORY_SERVER_DEF, MEMORY_SERVER_NAME } from "./memory.js";
import type { MemorySyncResult } from "./memory.js";
import { collectDoctorReport, printReport as printDoctorReport, resolveKnownHostInjected } from "./doctor.js";
import type { DoctorReport } from "./doctor.js";
import { openBackupSession } from "../lib/backup.js";
import { confirmAndInstall } from "../lib/installAgent.js";
import type { ConfirmAndInstallOptions } from "../lib/installAgent.js";
import {
  normalizeDoctorVerdict,
  normalizeMcpSyncVerdict,
  normalizeMemorySyncVerdict,
  normalizeMigrateVerdict,
  normalizeSecretsAuditVerdict,
  normalizeSelfVerificationVerdict,
  normalizeSyncVerdict,
  printVerdict,
} from "./onboardVerdict.js";
import type { VerdictItem } from "./onboardVerdict.js";

const PROBES: Record<AgentId, (homeDir: string) => Promise<AgentSnapshot>> = {
  "claude-code": (homeDir) => claudeCodeProbe.probe(homeDir),
  codex: (homeDir) => codexProbe.probe(homeDir),
  kiro: (homeDir) => kiroProbe.probe(homeDir),
  pi: (homeDir) => piProbe.probe(homeDir),
  "kimi-code": (homeDir) => kimiCodeProbe.probe(homeDir),
};

export interface OnboardAgentSummary {
  agent: AgentId;
  present: boolean;
  skillCount: number;
  skillNames: string[];
  /** instructionsFile exists and isn't itself a symlink — real content
   * of that agent's own to potentially migrate, not a judgment about
   * its quality or length. */
  hasRealInstructions: boolean;
  /** How many real MCP servers `migrate --only mcp` would find for this
   * agent — computed via `collectMigratePlan(agent, homeDir, ["mcp"])`
   * rather than a second reader dispatch, so this always agrees with
   * what migrate itself will do (design.md D1, trellis-onboard-mcp-
   * memory). 0 for pi, which has no MCP reader at all — not a gap here,
   * the same fact `migrate.ts` already establishes. */
  mcpServerCount: number;
  mcpServerNames: string[];
}

export async function collectOnboardSummary(homeDir: string = homedir()): Promise<OnboardAgentSummary[]> {
  return Promise.all(
    ALL_AGENTS.map(async (agent) => {
      const snapshot = await PROBES[agent](homeDir);
      if (!snapshot.present) {
        return { agent, present: false, skillCount: 0, skillNames: [], hasRealInstructions: false, mcpServerCount: 0, mcpServerNames: [] };
      }
      const skillNames = snapshot.skillRoots.flatMap((root) => root.skills.map((s) => s.name));
      const hasRealInstructions = snapshot.instructionsFile !== undefined && !snapshot.instructionsFile.isSymlink;
      const mcpPlan = await collectMigratePlan(agent, homeDir, ["mcp"]);
      return { agent, present: true, skillCount: skillNames.length, skillNames, hasRealInstructions, mcpServerCount: mcpPlan.items.length, mcpServerNames: mcpPlan.items.map((item) => item.name) };
    }),
  );
}

function hasContent(s: OnboardAgentSummary): boolean {
  return s.skillCount > 0 || s.hasRealInstructions || s.mcpServerCount > 0;
}

function hasSelectedSourceContent(s: OnboardAgentSummary, selection: CapabilitySelection | undefined): boolean {
  if (!selection) return hasContent(s);
  const hasSkills = selection.skills !== "none" && s.skillNames.some((name) => selectionContains(selection.skills, name));
  const hasMcp = selection.mcpServers !== "none" && s.mcpServerNames.some((name) => selectionContains(selection.mcpServers, name));
  return hasSkills || hasMcp || s.hasRealInstructions;
}

function filterMigratePlan(plan: MigratePlan, selection: CapabilitySelection | undefined): MigratePlan {
  if (!selection) return plan;
  const items = plan.items.filter((item: MigratePlanItem) => {
    if (item.kind === "skill") return selectionContains(selection.skills, item.name);
    if (item.kind === "mcp") return selectionContains(selection.mcpServers, item.name);
    return true;
  });
  return { ...plan, items };
}

export interface RunOnboardOptions {
  /** Non-interactive migration-source choice. */
  agent?: string;
  /** Non-interactive managed-set choice: comma-separated agent ids, or
   * the literal string "none" for "add nothing new this run" — distinct
   * from omitting the flag, which requires a prompt or refuses. */
  manage?: string;
  /** Non-interactive MCP-mode choice (trellis-onboard-mcp-mode). Omitted
   * leaves whatever canonical already has untouched and prompts for
   * nothing — "no change requested," not "please choose" (design.md
   * D1), unlike `agent`/`manage` above. */
  mcpMode?: string;
  /** Required when `mcpMode === "hub"`; refused if given otherwise. */
  hubUrl?: string;
  /** Optional when `mcpMode === "gateway"` (comma-separated agent ids;
   * omitted = every managed agent); refused if given otherwise. */
  gatewayAgents?: string;
  /** Non-interactive shared-memory-server toggle: `"on"` or `"off"`.
   * Omitted leaves whatever's already configured untouched — same
   * no-prompt posture as `mcpMode` (design.md D12). */
  memory?: string;
  /** Optional YAML/JSON item-level capability selection for automation. */
  selectionFile?: string;
  dryRun?: boolean;
  json?: boolean;
  /** Defaults to the real `~`; overridable for tests only. */
  homeDir?: string;
  /** Test-only: overrides the real `process.stdin.isTTY` check so the
   * interactive-vs-refuse branch is exercisable without a real terminal. */
  isTTY?: boolean;
  /** Test-only: replaces the real readline prompt with a scripted
   * answer, so the prompt path is exercisable without a real terminal. */
  promptForAgent?: (present: OnboardAgentSummary[]) => Promise<string>;
  /** Test-only: replaces the real readline multi-select prompt. Returns
   * the raw answer string (same grammar as `--manage`'s value), not a
   * pre-parsed list — so the same parsing/validation code path is
   * exercised whether the answer came from a flag or a prompt. */
  promptForManagedAgents?: (candidates: OnboardAgentSummary[], alreadyManaged: readonly AgentId[]) => Promise<string>;
  /** Test-only: replaces the real migrate-category picker/default logic
   * (trellis-migrate-category-selection). An empty array is a valid
   * answer — "skip migrate for this run" (design.md D6) — distinct from
   * `source` being unresolved at all. */
  promptForMigrateCategories?: (source: OnboardAgentSummary) => Promise<MigrateKind[]>;
  /** Test-only: replaces the real end-of-`--dry-run` "apply now?" picker
   * (design.md D9). `true` means "apply for real", matching what
   * accepting the real picker's "Yes, apply now" option means. */
  promptToApply?: () => Promise<boolean>;
  /** Test-only: injected into every `confirmAndInstall` call for a
   * selected, not-yet-present agent. Never a real terminal prompt or a
   * real `npm install` in a unit test. */
  install?: ConfirmAndInstallOptions;
}

export interface OnboardInstallResult {
  agent: AgentId;
  installed: boolean;
  installable: boolean;
}

export interface OnboardResult {
  summary: OnboardAgentSummary[];
  inventory?: CapabilityInventory;
  source?: AgentId;
  sourceReason?: "auto-selected" | "flag" | "prompt";
  /** The full managed set this run acted against — the union of whatever
   * was already in `managed.yaml` plus this run's own new selections
   * that actually resolved (D3: never a subtraction). */
  managedAgents?: AgentId[];
  installResults?: OnboardInstallResult[];
  migratePlan?: MigratePlan;
  /** Set when a source was resolved but zero migrate categories were
   * selected (design.md D6) — distinct from `migratePlan` being absent
   * because no source existed at all, which prints nothing here. */
  migrateSkipped?: string;
  syncReport?: SyncReport;
  mcpSyncReport?: McpSyncReport;
  /**
   * The self-verification re-plan (design.md D2b): a dry-run re-plan of
   * `sync`/`mcp sync`, run immediately after their real apply, against
   * the state that apply just wrote. Absent on `--dry-run` (nothing was
   * written, so nothing to verify) and on every early-refusal path.
   * Present, and empty, on a real run whose write actually held.
   */
  syncVerification?: SyncReport;
  mcpSyncVerification?: McpSyncReport;
  memorySyncResult?: MemorySyncResult;
  secretsAuditReport?: SecretsAuditReport;
  /**
   * A broader, whole-machine health scan — the same detectors
   * `trellis doctor` itself runs, against every agent (not scoped to
   * `managedAgents`, design.md D3), never with MCP handshake probing
   * (design.md D4). Complementary to, and distinct from, the
   * write-verification above: this cannot itself prove a write took
   * effect (it never reads canonical), only that something looks
   * inconsistent across agents independent of this run.
   */
  doctorReport?: DoctorReport;
  /**
   * The resolved MCP mode after this run (trellis-onboard-mcp-mode
   * design.md D7) — `current` reflects canonical's state whether or not
   * this run changed it, `changed` is `true` only when `--mcp-mode` was
   * given and differed from what canonical had before this run. Absent
   * on every early-refusal path before mode resolution is reached.
   */
  mcpMode?: { current: "direct" | "hub" | "gateway"; previous: "direct" | "hub" | "gateway"; changed: boolean };
  /** The resolved shared-memory-server state after this run, mirroring
   * `mcpMode` (design.md D13). */
  memory?: { current: "on" | "off"; previous: "on" | "off"; changed: boolean };
  refusal?: string;
  /** Only set when no agent is present — the same values `--json` and
   * text output both surface, so a machine caller doesn't have to
   * hardcode them a second time. */
  installHints?: Record<AgentId, string>;
  /**
   * Every stage's conflicts and findings, normalized to one shape
   * (trellis-onboard-closed-loop design.md D5) — the single source
   * `runOnboard`'s exit code and the terminal verdict block both derive
   * from, so the two can never disagree. Always present, empty on a
   * fully clean run (including refusal paths, where it reflects
   * whatever partial data was collected before the refusal).
   */
  verdict: VerdictItem[];
}

const PROGRESS_STAGES = ["migrate", "sync", "mcp sync", "memory sync", "secrets audit", "doctor"] as const;

/** Transient status, not part of the report — printed to stderr so
 * `trellis onboard > report.txt` still captures exactly the report and
 * verdict, nothing else (design.md D8). Silent for `--json` and for any
 * non-interactive stdout, where nobody's watching a terminal march
 * through stages in real time. */
function shouldShowProgress(opts: RunOnboardOptions): boolean {
  return !opts.json && (opts.isTTY ?? process.stdout.isTTY === true);
}

function logProgress(opts: RunOnboardOptions, stage: (typeof PROGRESS_STAGES)[number]): void {
  if (!shouldShowProgress(opts)) return;
  const index = PROGRESS_STAGES.indexOf(stage) + 1;
  console.error(`[${index}/${PROGRESS_STAGES.length}] ${stage}`);
}

/** A count only, never the full skill name list — with 30+ skills this
 * used to render as one unreadable, wrapping wall of text per row
 * (found via a real mirasim terminal session). The full names are still
 * available from `trellis doctor`/`--json`; a picker row's job is to
 * let you tell agents apart at a glance, not enumerate everything. */
function agentSummaryLabel(s: OnboardAgentSummary): string {
  return `${s.agent} — ${s.skillCount} skill(s), instructions: ${s.hasRealInstructions ? "yes" : "no"}, mcp: ${s.mcpServerCount}`;
}

/** Numbered-typing fallback (trellis-onboard-interactive-picker design.md
 * D2) — used only when the terminal can't support the raw-mode picker
 * (`canUseInteractivePicker()` false). Unchanged from before that change. */
async function promptForAgentNumbered(present: OnboardAgentSummary[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error("Multiple agents detected:");
    present.forEach((s, i) => {
      console.error(`  ${i + 1}) ${agentSummaryLabel(s)}`);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (await rl.question(`Choose a migration source [1-${present.length}]: `)).trim();
      // Accepts either the number shown or the literal agent id — the
      // latter kept so `--agent`-equivalent scripted callers piping a
      // canned answer in don't have to know the numbering.
      const byIndex = present[Number(answer) - 1];
      if (byIndex) return byIndex.agent;
      if (present.some((s) => s.agent === answer)) return answer;
      console.error(`Not a valid choice: enter a number from 1-${present.length}, or one of ${present.map((s) => s.agent).join(", ")}`);
    }
    throw new Error("no valid migration source chosen after 2 attempts");
  } finally {
    rl.close();
  }
}

/** Arrow-key single-select on a real, raw-mode-capable terminal; falls
 * back to `promptForAgentNumbered` otherwise. Resolves to the exact same
 * string contract either way — a real agent id — so `resolveMigrationSource`
 * and every test injecting `RunOnboardOptions.promptForAgent` need no
 * changes (design.md D5). Cancel (Ctrl+C) prints a message and exits
 * directly, rather than threading a new "cancelled" state through the
 * rest of onboard's return-based refusal plumbing. */
async function promptForAgentReal(present: OnboardAgentSummary[]): Promise<string> {
  if (!canUseInteractivePicker()) {
    return promptForAgentNumbered(present);
  }
  console.error("Multiple agents detected — use the selector to choose a migration source:");
  const index = await runSingleSelectPicker(present.map(agentSummaryLabel));
  if (index === null) {
    console.error("cancelled, no changes made");
    process.exit(1);
  }
  return present[index].agent;
}

/** Numbered-typing fallback — unchanged from before this change (see
 * `promptForAgentNumbered`'s doc comment). */
async function promptForManagedAgentsNumbered(candidates: OnboardAgentSummary[], alreadyManaged: readonly AgentId[]): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error("Which agents should Trellis manage? (comma-separated numbers; enter for none new)");
    candidates.forEach((s, i) => {
      const status = s.present ? `present, ${s.skillCount} skill(s)` : "not installed";
      const tag = alreadyManaged.includes(s.agent) ? " [already managed]" : "";
      console.error(`  ${i + 1}) ${s.agent} — ${status}${tag}`);
    });
    const answer = (await rl.question("Select: ")).trim();
    return answer;
  } finally {
    rl.close();
  }
}

/** Checkbox multi-select on a real, raw-mode-capable terminal; falls
 * back to `promptForManagedAgentsNumbered` otherwise. Resolves to the
 * same comma-separated-agent-id string contract `parseManagedSelection`
 * already parses — an empty selection resolves to `""` (comma-separated
 * join of zero items), which `parseManagedSelection` already treats as
 * "none" (design.md D5). Cancel behaves like `promptForAgentReal`'s. */
async function promptForManagedAgentsReal(candidates: OnboardAgentSummary[], alreadyManaged: readonly AgentId[]): Promise<string> {
  if (!canUseInteractivePicker()) {
    return promptForManagedAgentsNumbered(candidates, alreadyManaged);
  }
  console.error("Which agents should Trellis manage? Use the selector to toggle agents:");
  const labels = candidates.map((s) => {
    const status = s.present ? `present, ${s.skillCount} skill(s)` : "not installed";
    return `${s.agent} — ${status}`;
  });
  const initiallyChecked = candidates.map((s) => alreadyManaged.includes(s.agent));
  const indices = await runMultiSelectPicker(labels, initiallyChecked);
  if (indices === null) {
    console.error("cancelled, no changes made");
    process.exit(1);
  }
  return indices.map((i) => candidates[i].agent).join(",");
}

/**
 * Resolves which categories (skills, instructions) to migrate from a
 * resolved source (trellis-migrate-category-selection, extended to a
 * third category by trellis-onboard-mcp-memory design.md D2). Unlike the
 * two pickers above, there is no numbered-text fallback to preserve
 * parity with — this concept never existed before this change, so
 * "can't prompt" simply means "default to whichever kind(s) actually
 * have real content, silently" (design.md D4). The picker itself is
 * only offered when the choice is meaningful — two or more kinds
 * present, a capable terminal, and not a `--json` run (design.md D5).
 * An empty result is a valid answer: "skip migrate for this run"
 * (design.md D6), left for the caller to act on.
 */
async function resolveMigrateCategories(source: OnboardAgentSummary, opts: RunOnboardOptions, selection?: CapabilitySelection): Promise<MigrateKind[]> {
  // Built dynamically, in skill/instructions/mcp display order — not a
  // fixed two- or three-slot structure, so a fourth category some day
  // would only need an entry here, not a rewritten branch (design.md D2).
  const candidates: { kind: MigrateKind; label: string }[] = [];
  if (source.skillCount > 0 && (!selection || selection.skills !== "none") && (!selection || source.skillNames.some((name) => selectionContains(selection.skills, name)))) {
    candidates.push({ kind: "skill", label: "skills" });
  }
  if (source.hasRealInstructions) candidates.push({ kind: "instructions", label: "instructions" });
  if (source.mcpServerCount > 0 && (!selection || selection.mcpServers !== "none") && (!selection || source.mcpServerNames.some((name) => selectionContains(selection.mcpServers, name)))) {
    candidates.push({ kind: "mcp", label: "mcp" });
  }

  // The choice is only meaningful when two or more kinds are real — same
  // gate for the injected test seam as for the real picker, mirroring
  // how `promptForAgent`/`promptForManagedAgents` are only ever
  // consulted when their own real prompt would actually apply.
  if (candidates.length > 1 && !opts.json) {
    if (opts.promptForMigrateCategories) {
      return opts.promptForMigrateCategories(source);
    }
    if (canUseInteractivePicker()) {
      console.error(`Which categories should be migrated from ${source.agent}? Use the selector to toggle categories:`);
      const indices = await runMultiSelectPicker(
        candidates.map((c) => c.label),
        candidates.map(() => true),
      );
      if (indices === null) {
        console.error("cancelled, no changes made");
        process.exit(1);
      }
      return indices.map((i) => candidates[i].kind);
    }
  }

  return candidates.map((c) => c.kind);
}

async function resolveInteractiveCapabilitySelection(source: OnboardAgentSummary, opts: RunOnboardOptions): Promise<CapabilitySelection | undefined> {
  if (opts.json || opts.promptForMigrateCategories || !canUseInteractivePicker()) return undefined;
  const skills = source.skillNames.length > 0 ? await runSearchMultiSelectPicker(source.skillNames) : [];
  if (skills === null) {
    console.error("cancelled, no changes made");
    process.exit(1);
  }
  const mcpServers = source.mcpServerNames.length > 0 ? await runSearchMultiSelectPicker(source.mcpServerNames) : [];
  if (mcpServers === null) {
    console.error("cancelled, no changes made");
    process.exit(1);
  }
  return { skills: skills ?? "none", mcpServers: mcpServers ?? "none", memories: "all", mcpRoutes: {}, runtimeDelivery: {} };
}

async function resolveInteractiveMcpRoutes(agentIds: readonly AgentId[], serverNames: readonly string[]): Promise<CapabilitySelection["mcpRoutes"]> {
  const routes: CapabilitySelection["mcpRoutes"] = {};
  for (const agent of agentIds) {
    const modeIndex = await runSingleSelectPicker(
      ["direct", "gateway", "hub"],
      undefined,
      `选择 ${agent} 的 MCP 路由模式`,
    );
    if (modeIndex === null) {
      console.error("cancelled, no changes made");
      process.exit(1);
    }
    const mode = (["direct", "gateway", "hub"] as const)[modeIndex];
    if (mode === "hub") {
      routes[agent] = { mode };
      continue;
    }
    const selected = await runSearchMultiSelectPicker(serverNames, undefined, `选择 ${agent} 的 MCP 服务器`);
    if (selected === null) {
      console.error("cancelled, no changes made");
      process.exit(1);
    }
    routes[agent] = { mode, servers: selected ?? [] };
  }
  return routes;
}

/** Shared by `--manage` and the interactive prompt's answer — same
 * grammar either way (design.md D4): a real agent id list, comma- or
 * whitespace-separated numbers referring to `candidates`' own order, or
 * the literal `none`. Never guesses on an unparseable token. */
function parseManagedSelection(raw: string, candidates: OnboardAgentSummary[]): { agents: AgentId[] } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return { agents: [] };
  }
  const tokens = trimmed.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const agents: AgentId[] = [];
  for (const token of tokens) {
    const byIndex = candidates[Number(token) - 1];
    if (byIndex) {
      agents.push(byIndex.agent);
      continue;
    }
    if ((ALL_AGENTS as readonly string[]).includes(token)) {
      agents.push(token as AgentId);
      continue;
    }
    return { error: `"${token}" is not a valid choice — use a number from 1-${candidates.length} or an agent id` };
  }
  return { agents: [...new Set(agents)] };
}

type McpModeValue = "direct" | "hub" | "gateway";

/** Comma-separated agent ids only — unlike `parseManagedSelection`, no
 * numbered-index shorthand, since `--gateway-agents` never has a
 * numbered list on screen to refer back to (it's flag-only, never
 * prompted; design.md D1/D4). */
function parseAgentIdList(raw: string): AgentId[] | { error: string } {
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const agents: AgentId[] = [];
  for (const token of tokens) {
    if (!(ALL_AGENTS as readonly string[]).includes(token)) {
      return { error: `"${token}" is not a valid agent id — use one of ${ALL_AGENTS.join(", ")}` };
    }
    agents.push(token as AgentId);
  }
  return [...new Set(agents)];
}

/**
 * Validates `--mcp-mode`/`--hub-url`/`--gateway-agents` together, before
 * any other work (trellis-onboard-mcp-mode design.md D4) — a bad
 * combination refuses the whole run rather than being discovered
 * partway through. `mode` is only set when `mcpMode` was actually
 * given; omitted resolves to `{}`, meaning "no change requested," not
 * an error (design.md D1) — distinct from every other field on
 * `RunOnboardOptions`, where omission usually requires a prompt.
 */
function validateMcpModeOption(opts: Pick<RunOnboardOptions, "mcpMode" | "hubUrl" | "gatewayAgents">): { mode?: McpMode } | { error: string } {
  const { mcpMode, hubUrl, gatewayAgents } = opts;
  if (mcpMode === undefined) {
    if (hubUrl !== undefined) return { error: "--hub-url was given without --mcp-mode hub" };
    if (gatewayAgents !== undefined) return { error: "--gateway-agents was given without --mcp-mode gateway" };
    return {};
  }
  if (mcpMode !== "direct" && mcpMode !== "hub" && mcpMode !== "gateway") {
    return { error: `--mcp-mode must be one of direct, hub, gateway (got "${mcpMode}")` };
  }
  if (mcpMode !== "hub" && hubUrl !== undefined) {
    return { error: "--hub-url was given without --mcp-mode hub" };
  }
  if (mcpMode !== "gateway" && gatewayAgents !== undefined) {
    return { error: "--gateway-agents was given without --mcp-mode gateway" };
  }
  if (mcpMode === "direct") return { mode: { kind: "direct" } };
  if (mcpMode === "hub") {
    if (!hubUrl) return { error: "--mcp-mode hub requires --hub-url <url>" };
    return { mode: { kind: "hub", url: hubUrl } };
  }
  // mcpMode === "gateway"
  if (gatewayAgents === undefined) return { mode: { kind: "gateway" } };
  const agents = parseAgentIdList(gatewayAgents);
  if ("error" in agents) return agents;
  return { mode: { kind: "gateway", agents } };
}

/** Same "omitted means no change requested" posture as
 * `validateMcpModeOption` (design.md D12). */
function validateMemoryOption(memory: string | undefined): { value?: "on" | "off" } | { error: string } {
  if (memory === undefined) return {};
  if (memory !== "on" && memory !== "off") return { error: `--memory must be "on" or "off" (got "${memory}")` };
  return { value: memory };
}

function mcpModeValueOf(mcp: { gateway?: { enabled: boolean }; hub?: { url: string } }): McpModeValue {
  if (mcp.gateway?.enabled) return "gateway";
  if (mcp.hub) return "hub";
  return "direct";
}

interface McpModeResolution {
  current: McpModeValue;
  previous: McpModeValue;
  changed: boolean;
  /** Set whenever `--mcp-mode` was given at all, even if `current ===
   * previous` — an explicit re-request (e.g. new `--gateway-agents`
   * while staying in gateway mode) still writes; only a fully omitted
   * flag skips the writer call (design.md D1). */
  write?: McpMode;
}

function resolveMcpModeChange(mode: McpMode | undefined, currentValue: McpModeValue): McpModeResolution {
  if (!mode) return { current: currentValue, previous: currentValue, changed: false };
  return { current: mode.kind, previous: currentValue, changed: mode.kind !== currentValue, write: mode };
}

type MemoryToggleResolution = { current: "on" | "off"; previous: "on" | "off"; changed: boolean } | { refusal: string };

/**
 * `value === "on"` against an already-host-injected `"memory"` refuses
 * outright rather than writing a definition `mcp sync` would refuse to
 * propagate to any agent a moment later (design.md D10) — the same fact
 * `schema/servers.example.yaml`'s own comment already explains to a
 * human reading it by hand.
 */
function resolveMemoryToggle(value: "on" | "off" | undefined, configuredBefore: boolean, knownHostInjected: readonly string[]): MemoryToggleResolution {
  const previous: "on" | "off" = configuredBefore ? "on" : "off";
  if (value === undefined) return { current: previous, previous, changed: false };
  if (value === "on") {
    if (configuredBefore) return { current: "on", previous, changed: false };
    if (knownHostInjected.includes(MEMORY_SERVER_NAME)) {
      return {
        refusal: `refusing to enable the memory server: "${MEMORY_SERVER_NAME}" is already listed in known_host_injected — a host on this machine is presumed to already inject its own memory connector under that name, so a static definition here would only collide the next time \`mcp sync\` runs`,
      };
    }
    return { current: "on", previous, changed: true };
  }
  // value === "off"
  if (!configuredBefore) return { current: "off", previous, changed: false };
  return { current: "off", previous, changed: true };
}

function mcpModeStatusLine(mode: McpModeResolution): string {
  if (!mode.changed) return `mcp mode: ${mode.current} (unchanged) — pass --mcp-mode direct|hub|gateway to change`;
  return `mcp mode: ${mode.current} (changed from ${mode.previous})`;
}

function memoryStatusLine(memory: { current: "on" | "off"; previous: "on" | "off"; changed: boolean }): string {
  if (!memory.changed) return `memory: ${memory.current} (unchanged) — pass --memory ${memory.current === "on" ? "off" : "on"} to change`;
  return `memory: ${memory.current} (changed from ${memory.previous})`;
}

async function resolveManagedAgents(
  opts: RunOnboardOptions,
  summary: OnboardAgentSummary[],
  alreadyManaged: readonly AgentId[],
): Promise<{ newlySelected: AgentId[] } | { refusal: string }> {
  if (opts.manage !== undefined) {
    const parsed = parseManagedSelection(opts.manage, summary);
    if ("error" in parsed) return { refusal: parsed.error };
    return { newlySelected: parsed.agents };
  }

  const canPrompt = !opts.json && (opts.isTTY ?? process.stdin.isTTY === true);
  if (!canPrompt) {
    return { refusal: "no managed-agent selection given and no terminal to prompt in — pass --manage <ids> or --manage none" };
  }
  const prompt = opts.promptForManagedAgents ?? promptForManagedAgentsReal;
  const answer = await prompt(summary, alreadyManaged);
  const parsed = parseManagedSelection(answer, summary);
  if ("error" in parsed) return { refusal: parsed.error };
  return { newlySelected: parsed.agents };
}

function readManagedYaml(homeDir: string): AgentId[] {
  return loadCanonicalSource(homeDir).managedAgents as AgentId[];
}

function writeManagedYaml(homeDir: string, agents: AgentId[]): void {
  writeFileSync(join(homeDir, ".trellis", "managed.yaml"), `agents: [${agents.join(", ")}]\n`);
}

export async function collectOnboardPlan(opts: RunOnboardOptions = {}): Promise<OnboardResult> {
  const homeDir = opts.homeDir ?? homedir();
  let capabilitySelection: CapabilitySelection | undefined;
  if (opts.selectionFile) {
    const parsedSelection = parseCapabilitySelectionFile(opts.selectionFile);
    if (!parsedSelection.ok) return { summary: [], refusal: parsedSelection.error, verdict: [] };
    capabilitySelection = parsedSelection.selection;
  }
  await collectInitReport(homeDir);
  const summary = await collectOnboardSummary(homeDir);
  const present = summary.filter((s) => s.present);

  if (present.length === 0) {
    return { summary, installHints: { ...INSTALL_HINTS }, verdict: [] };
  }

  // Validated up front, before any of this run's own writes (managed.yaml
  // included) — a bad `--mcp-mode`/`--hub-url`/`--gateway-agents`/
  // `--memory` combination refuses the whole run cleanly rather than
  // being discovered partway through (design.md D4). The parsed results
  // are reused later, once managed-set resolution has run (design.md
  // D5/D11).
  const mcpModeValidation = validateMcpModeOption(opts);
  if ("error" in mcpModeValidation) {
    return { summary, refusal: mcpModeValidation.error, verdict: [] };
  }
  const memoryValidation = validateMemoryOption(opts.memory);
  if ("error" in memoryValidation) {
    return { summary, refusal: memoryValidation.error, verdict: [] };
  }

  const sourceCandidates = present.filter((candidate) => hasSelectedSourceContent(candidate, capabilitySelection));
  let source: AgentId | undefined;
  let sourceReason: OnboardResult["sourceReason"];

  if (opts.agent) {
    const match = present.find((s) => s.agent === opts.agent);
    if (!match) {
      return {
        summary,
        refusal: `"${opts.agent}" is not one of the present agents (${present.map((s) => s.agent).join(", ")})`,
        verdict: [],
      };
    }
    source = match.agent;
    sourceReason = "flag";
  } else if (sourceCandidates.length === 1) {
    source = sourceCandidates[0].agent;
    sourceReason = "auto-selected";
  } else if (sourceCandidates.length > 1) {
    const canPrompt = !opts.json && (opts.isTTY ?? process.stdin.isTTY === true);
    if (!canPrompt) {
      return {
        summary,
        refusal: `multiple agents detected (${sourceCandidates.map((s) => s.agent).join(", ")}) and no terminal to prompt in — pass --agent <id>`,
        verdict: [],
      };
    }
    const prompt = opts.promptForAgent ?? promptForAgentReal;
    try {
      source = (await prompt(sourceCandidates)) as AgentId;
    } catch (err) {
      return { summary, refusal: err instanceof Error ? err.message : String(err), verdict: [] };
    }
    sourceReason = "prompt";
  }
  // sourceCandidates.length === 0: nothing with real content to migrate
  // from — source stays undefined, managed-set selection still proceeds.

  const alreadyManaged = readManagedYaml(homeDir);
  const managedResult = await resolveManagedAgents(opts, summary, alreadyManaged);
  if ("refusal" in managedResult) {
    return { summary, source, sourceReason, refusal: managedResult.refusal, verdict: [] };
  }

  const installResults: OnboardInstallResult[] = [];
  const resolvedNew: AgentId[] = [];
  for (const agent of managedResult.newlySelected) {
    const alreadyPresent = summary.find((s) => s.agent === agent)?.present ?? false;
    if (alreadyPresent) {
      resolvedNew.push(agent);
      continue;
    }
    // A selected, not-yet-present agent: install-then-manage (design.md
    // D5). `--json`/non-interactive callers still get a real confirm
    // step here (never silently installed) — with no injected `confirm`
    // and no TTY, the real readline prompt itself will simply never
    // resolve to "yes" in a non-interactive run, so nothing installs;
    // callers that want this path automated must inject `opts.install`.
    if (opts.json && !opts.install?.confirm) {
      return {
        summary,
        source,
        sourceReason,
        refusal: `"${agent}" is not installed — installing it requires a confirmation, which --json never prompts for. Inject a confirm handler or install ${agent} first.`,
        verdict: [],
      };
    }
    const result = await confirmAndInstall(agent, opts.install);
    installResults.push({ agent, installed: result.installed, installable: result.installable });
    if (result.installed) {
      resolvedNew.push(agent);
    }
    // Declined or (Kiro) not installable: excluded from this run's
    // managed set, not an abort of the rest of the flow.
  }

  const managedAgents = [...new Set([...alreadyManaged, ...resolvedNew])];
  if (!opts.dryRun) {
    writeManagedYaml(homeDir, managedAgents);
  }

  // MCP mode + memory-server resolution (design.md D5/D11) — grouped
  // with managed-set above as "how is this machine configured"
  // decisions resolved once per run, ahead of migrate/sync/mcp-sync/
  // memory-sync below, which act on the result. Both flags were already
  // validated before managed-set was even touched; omitting either
  // resolves to "no change requested" here too (design.md D1/D12) — no
  // writer call at all, on either a first run or a later one.
  const canonicalForModeAndMemory = loadCanonicalSource(homeDir);
  const sourceSummaryForInventory = source ? summary.find((item) => item.agent === source) : undefined;
  const inventory = sourceSummaryForInventory
    ? buildCapabilityInventory(
        sourceSummaryForInventory,
        canonicalForModeAndMemory,
        [{ name: `${source}:native`, detail: "native agent memory has no Trellis reader; use a provider-specific import when available" }],
      )
    : undefined;
  const mcpModeResolution = resolveMcpModeChange(mcpModeValidation.mode, mcpModeValueOf(canonicalForModeAndMemory.mcp));
  const mcpMode = { current: mcpModeResolution.current, previous: mcpModeResolution.previous, changed: mcpModeResolution.changed };
  const serversYamlPath = join(homeDir, ".trellis", "mcp", "servers.yaml");
  if (mcpModeResolution.write && !opts.dryRun) {
    writeMcpModeYaml(serversYamlPath, mcpModeResolution.write);
  }

  const memoryConfiguredBefore = canonicalForModeAndMemory.mcp.servers[MEMORY_SERVER_NAME] !== undefined;
  const memoryResolution = resolveMemoryToggle(memoryValidation.value, memoryConfiguredBefore, canonicalForModeAndMemory.mcp.knownHostInjected);
  if ("refusal" in memoryResolution) {
    return { summary, source, sourceReason, managedAgents, mcpMode, refusal: memoryResolution.refusal, verdict: [] };
  }
  const memory = { current: memoryResolution.current, previous: memoryResolution.previous, changed: memoryResolution.changed };
  if (memory.changed && !opts.dryRun) {
    if (memory.current === "on") {
      upsertServerYaml(serversYamlPath, MEMORY_SERVER_NAME, DEFAULT_MEMORY_SERVER_DEF);
    } else {
      removeServerYaml(serversYamlPath, MEMORY_SERVER_NAME);
    }
  }

  let migratePlan: MigratePlan | undefined;
  let migrateSkipped: string | undefined;
  logProgress(opts, "migrate");
  if (source) {
    const sourceSummary = summary.find((s) => s.agent === source)!;
    const interactiveSelection = capabilitySelection ?? await resolveInteractiveCapabilitySelection(sourceSummary, opts);
    const categories = await resolveMigrateCategories(sourceSummary, opts, interactiveSelection);
    if (categories.length > 0) {
      migratePlan = filterMigratePlan(await collectMigratePlan(source, homeDir, categories), interactiveSelection);
      if (!opts.dryRun) {
        applyMigratePlan(migratePlan, homeDir);
      }
    } else {
      migrateSkipped = "migrate skipped — no categories selected";
    }
  }

  const currentMcpAfterMigration = loadCanonicalSource(homeDir).mcp;
  const migratedMcpNames = migratePlan?.items.filter((item) => item.kind === "mcp").map((item) => item.name) ?? [];
  const availableMcpNames = [...new Set([...Object.keys(currentMcpAfterMigration.servers), ...migratedMcpNames])];
  let requestedRoutes = capabilitySelection?.mcpRoutes;
  const shouldPromptForRoutes = !opts.selectionFile
    && opts.mcpMode === undefined
    && !currentMcpAfterMigration.routes
    && !currentMcpAfterMigration.gateway
    && !currentMcpAfterMigration.hub
    && managedAgents.length > 0
    && availableMcpNames.length > 0
    && canUseInteractivePicker();
  if (!requestedRoutes && shouldPromptForRoutes) {
    requestedRoutes = await resolveInteractiveMcpRoutes(managedAgents, availableMcpNames);
  }

  const requestedRuntimeDelivery = capabilitySelection?.runtimeDelivery;
  let mcpSyncOverride: McpConfig | undefined;
  if ((requestedRoutes && Object.keys(requestedRoutes).length > 0) || (requestedRuntimeDelivery && Object.keys(requestedRuntimeDelivery).length > 0)) {
    const currentMcp = currentMcpAfterMigration;
    const routes = requestedRoutes && Object.keys(requestedRoutes).length > 0
      ? { ...(currentMcp.routes ?? {}), ...requestedRoutes }
      : currentMcp.routes;
    const delivery = requestedRuntimeDelivery && Object.keys(requestedRuntimeDelivery).length > 0
      ? { ...(currentMcp.runtime?.delivery ?? {}), ...requestedRuntimeDelivery }
      : currentMcp.runtime?.delivery;
    mcpSyncOverride = {
      ...currentMcp,
      ...(routes ? { routes } : {}),
      ...(delivery ? { runtime: { ...(currentMcp.runtime ?? {}), delivery } } : {}),
    };
    if (!opts.dryRun && requestedRoutes && Object.keys(requestedRoutes).length > 0) {
      writeMcpRoutesYaml(join(homeDir, ".trellis", "mcp", "servers.yaml"), routes ?? {});
    }
    if (!opts.dryRun && requestedRuntimeDelivery && Object.keys(requestedRuntimeDelivery).length > 0) {
      writeMcpRuntimeDeliveryYaml(join(homeDir, ".trellis", "mcp", "servers.yaml"), delivery ?? {});
    }
  }

  // One session for the whole chained run (trellis-backup-rollback) —
  // `--dry-run` opens none, there's nothing either stage will write.
  // Neither collectSyncReport nor collectMcpSyncReport finalizes a
  // session they were handed; only this caller does, once, after both.
  const backupSession = opts.dryRun ? undefined : openBackupSession(homeDir, "onboard");
  logProgress(opts, "sync");
  const syncReport = await collectSyncReport({ homeDir, dryRun: opts.dryRun, managedAgents, backupSession });
  // The self-verification re-plan (design.md D2b): immediately after a
  // real apply, re-run the exact same plan computation, dry-run, against
  // what was just written. A remaining "create"/"conflict" item means
  // the write did not hold — the mechanism that actually closes the
  // loop, since doctor (below) never reads canonical and cannot catch
  // this even in principle. Skipped entirely on --dry-run: nothing was
  // written, so there is nothing to verify.
  const syncVerification = opts.dryRun ? undefined : await collectSyncReport({ homeDir, dryRun: true, managedAgents });
  logProgress(opts, "mcp sync");
  const mcpSyncReport = await collectMcpSyncReport({ homeDir, dryRun: opts.dryRun, managedAgents, backupSession, mcp: mcpSyncOverride });
  const mcpSyncVerification = opts.dryRun ? undefined : await collectMcpSyncReport({ homeDir, dryRun: true, managedAgents });
  backupSession?.finalize();

  // Independent of `managedAgents` — the shared memory server is not
  // per-agent (design.md D4, trellis-onboard-mcp-memory), unlike
  // sync/mcp-sync above. Runs unconditionally once reached; an
  // unconfigured `memory` server is a legitimate "nothing to do yet"
  // state (design.md D5), not gated on any prior step here.
  logProgress(opts, "memory sync");
  const selectedMemoryNames = capabilitySelection ? resolveSelectedNames(capabilitySelection.memories, loadCanonicalSource(homeDir).memories.map((memory) => memory.name)) : undefined;
  const memorySyncResult = collectMemorySyncResult(homeDir, selectedMemoryNames);
  if (!opts.dryRun) {
    applyMemorySync(memorySyncResult);
  }

  // Read-only, no dryRun concept — same report either way, run last since
  // it audits the config mcp sync just wrote (or, on --dry-run, whatever
  // was already there before this run).
  logProgress(opts, "secrets audit");
  const secretsAuditReport = await collectSecretsAuditReport({ homeDir, managedAgents });

  // The broader health scan (design.md D2/D3/D4) — last, since it's the
  // only stage whose job is to observe the result of every other one.
  // Never --probe-mcp: the worst possible moment to start spawning every
  // configured MCP server is a user's first-ever run of this command.
  // Scoped to every agent, not just managedAgents — filtering here would
  // hide exactly the finding onboarding is most likely to create (a
  // newly-relevant agent drifting, or colliding with an unmanaged one);
  // normalizeDoctorVerdict is what turns "unmanaged" into a warning
  // rather than hiding it outright.
  logProgress(opts, "doctor");
  const doctorReport = await collectDoctorReport(homeDir, resolveKnownHostInjected({ homeDir }));

  const verdict: VerdictItem[] = [
    ...normalizeMigrateVerdict(migratePlan),
    ...normalizeSyncVerdict(syncReport),
    ...normalizeSelfVerificationVerdict("sync", syncVerification?.reports),
    ...normalizeMcpSyncVerdict(mcpSyncReport),
    ...normalizeSelfVerificationVerdict("mcp sync", mcpSyncVerification?.reports),
    ...normalizeMemorySyncVerdict(memorySyncResult),
    ...normalizeSecretsAuditVerdict(secretsAuditReport),
    ...normalizeDoctorVerdict(doctorReport, managedAgents),
  ];

  return {
    summary,
    inventory,
    source,
    sourceReason,
    managedAgents,
    installResults: installResults.length > 0 ? installResults : undefined,
    migratePlan,
    migrateSkipped,
    syncReport,
    mcpSyncReport,
    syncVerification,
    mcpSyncVerification,
    memorySyncResult,
    secretsAuditReport,
    doctorReport,
    mcpMode,
    memory,
    verdict,
  };
}

/**
 * Declining is the default (design.md D9): "No" is the first, highlighted
 * option, so Enter — the reflex keystroke — declines. Only ever offered
 * on a real, raw-mode-capable terminal (`canUseInteractivePicker`, the
 * same gate every other onboard prompt already uses); `--json` and
 * non-interactive runs never reach this at all.
 */
async function offerToApply(opts: RunOnboardOptions): Promise<boolean> {
  if (opts.promptToApply) return opts.promptToApply();
  if (!canUseInteractivePicker()) return false;
  console.error("");
  const choice = await runSingleSelectPicker(["No, don't apply", "Yes, apply now"]);
  return choice === 1;
}

export async function runOnboard(opts: RunOnboardOptions = {}): Promise<{ exitCode: number }> {
  const homeDir = opts.homeDir ?? homedir();
  const result = await collectOnboardPlan(opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result, opts.dryRun ?? false, shouldShowProgress(opts));
    // Always last — including on a fully clean run and on a refusal —
    // so the terminal state of the run is never a green line from
    // whichever stage happened to print last (spec: "Every run
    // terminates in a verdict that matches its exit code"). A refusal
    // never populates `result.verdict` (every early-return path sets it
    // to `[]`), so it has to be folded in here explicitly — otherwise
    // the verdict would print "nothing needs attention, exit code: 0"
    // directly underneath a real refusal that returns exit code 1: the
    // exact contradiction this whole mechanism exists to prevent, just
    // reached from a different direction.
    const verdictForDisplay = result.refusal ? [...result.verdict, { stage: "onboard", severity: "blocked" as const, message: result.refusal }] : result.verdict;
    printVerdict(verdictForDisplay, homeDir);
  }

  if (result.refusal) return { exitCode: 1 };

  if (opts.dryRun && !opts.json) {
    const accepted = await offerToApply(opts);
    if (accepted) {
      // Re-plan and apply for real rather than replaying this exact
      // plan — the user may have changed state while reading the
      // preview, and re-planning against current state is cheap next to
      // applying a plan that's gone stale (design.md D9).
      return runOnboard({ ...opts, dryRun: false });
    }
  }

  const hasBlocked = result.verdict.some((item) => item.severity === "blocked");
  return { exitCode: hasBlocked ? 1 : 0 };
}

function printResult(result: OnboardResult, dryRun: boolean, showStatusLine: boolean): void {
  if (dryRun) console.log("[dry run]");

  const present = result.summary.filter((s) => s.present);
  if (present.length === 0) {
    console.log("No agent detected on this machine yet. Install one, then re-run `trellis onboard`:");
    for (const agent of ALL_AGENTS) {
      console.log(`  ${agent}: ${INSTALL_HINTS[agent]}`);
    }
    return;
  }

  if (result.refusal) {
    console.error(result.refusal);
    return;
  }

  if (result.sourceReason === "auto-selected") {
    console.log(`Only ${result.source} has real content — using it as the migration source.`);
  } else if (result.sourceReason === "flag") {
    console.log(`Using ${result.source} as the migration source (--agent).`);
  } else if (result.sourceReason === "prompt") {
    console.log(`Using ${result.source} as the migration source.`);
  } else {
    console.log("No agent has real content to migrate from — starting from canonical's placeholder.");
  }

  for (const install of result.installResults ?? []) {
    console.log(
      install.installed
        ? `Installed ${install.agent}.`
        : install.installable
          ? `${install.agent} was not installed and the install was declined — left out of this run's managed set.`
          : `${install.agent} has no npm package to install (see \`trellis init\`'s install hint) — left out of this run's managed set.`,
    );
  }
  console.log(`Managed agents: ${result.managedAgents && result.managedAgents.length > 0 ? result.managedAgents.join(", ") : "(none)"}`);

  // Informational only, never a prompt (design.md D6/D12,
  // trellis-onboard-mcp-mode) — this is what keeps `--mcp-mode`/
  // `--memory` discoverable without costing every run a keystroke.
  // Suppressed under `--json` and non-TTY, same gate stage progress
  // already uses.
  if (showStatusLine && result.mcpMode) {
    console.log(mcpModeStatusLine(result.mcpMode));
  }
  if (showStatusLine && result.memory) {
    console.log(memoryStatusLine(result.memory));
  }

  // Reuse `migrate`/`sync`'s own printing verbatim (including the
  // "nothing to migrate" / "already in sync" cases) rather than a second,
  // easily-drifting copy of this formatting. `dryRun: false` here since
  // this function's own leading "[dry run]" line already said so once.
  if (result.migratePlan) {
    console.log("");
    printMigratePlan(result.migratePlan, false);
  } else if (result.migrateSkipped) {
    console.log("");
    console.log(result.migrateSkipped);
  }

  if (result.syncReport) {
    console.log("\nsync");
    printSyncReport(result.syncReport, false);
  }

  if (result.mcpSyncReport) {
    console.log("\nmcp sync");
    printMcpSyncReport(result.mcpSyncReport, false);
  }

  if (result.memorySyncResult) {
    console.log("\nmemory sync");
    printMemorySyncResult(result.memorySyncResult, false);
  }

  if (result.secretsAuditReport) {
    console.log("\nsecrets audit");
    printSecretsAuditReport(result.secretsAuditReport);
  }

  if (result.doctorReport) {
    // Distinct from the self-verification re-plan above: this is a
    // broader health scan across every agent, not proof that this run's
    // own writes took effect (design.md D2b).
    console.log("\nhealth scan (trellis doctor)");
    printDoctorReport(result.doctorReport);
  }
}
