/**
 * Config for the GUI's in-app chat feature: which CLI agents can be chatted
 * with from the desktop app, keyed by an arbitrary string id (not `AgentId`
 * — chat targets are not necessarily fully-managed Agents with adapters,
 * sync, and probes; they're just "a non-interactive CLI I can spawn and
 * stream from"). Kept as its own file + config path, sibling to
 * `agent-bridge.yaml`, so delegation's `ALL_AGENTS` constraint (needed for
 * the cross-Agent-delegation use case) never has to bend for chat's needs.
 *
 * Configuration lives at `~/.trellis/mcp/chat-agents.yaml`. Its absence
 * means zero targets, not an error — the same "optional, additive" shape
 * as `agent-bridge.yaml`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type ChatAgentOutputFormat = "text" | "json" | "stream-json";

export interface ChatAgentTargetConfig {
  /** Human-readable name shown in the GUI's agent picker, e.g. "Claude Code". */
  label: string;
  /** Binary to spawn, e.g. "claude", "qoder". */
  command: string;
  /** Argv template for a fresh call. One element may be the literal
   * placeholder `"{prompt}"`, substituted with the caller's message at
   * call time. */
  args: string[];
  /** Argv template used instead of `args` when the caller supplies a
   * `sessionId` to resume — must reference `"{sessionId}"`. */
  resumeArgs?: string[];
  /** How to interpret stdout. Omit for plain text. */
  outputFormat?: ChatAgentOutputFormat;
  timeoutMs?: number;
  /** Free-text, informational only — surfaced in the GUI as a hint. */
  tags?: string[];
  /** Default persona/role text applied to every call to this target. */
  persona?: string;
}

export interface ChatAgentConfig {
  targets: Record<string, ChatAgentTargetConfig>;
}

const OUTPUT_FORMATS: readonly ChatAgentOutputFormat[] = ["text", "json", "stream-json"];

export function chatAgentsPath(homeDir: string): string {
  return join(homeDir, ".trellis", "mcp", "chat-agents.yaml");
}

interface ChatAgentTargetYaml {
  label?: string;
  command?: string;
  args?: string[];
  resumeArgs?: string[];
  outputFormat?: string;
  timeoutMs?: number;
  tags?: string[];
  persona?: string;
}

interface ChatAgentsYaml {
  targets?: Partial<Record<string, ChatAgentTargetYaml>>;
}

export function loadChatAgentConfig(homeDir: string): ChatAgentConfig {
  const path = chatAgentsPath(homeDir);
  if (!existsSync(path)) return { targets: {} };
  const parsed = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as ChatAgentsYaml;
  const targets: ChatAgentConfig["targets"] = {};
  for (const [id, raw] of Object.entries(parsed.targets ?? {})) {
    if (!raw) continue;
    if (!raw.label || !raw.label.trim()) {
      throw new Error(`chat-agents.yaml: target "${id}" must declare a non-empty "label"`);
    }
    if (!raw.command || !Array.isArray(raw.args) || raw.args.length === 0) {
      throw new Error(`chat-agents.yaml: target "${id}" must declare "command" and a non-empty "args"`);
    }
    if (raw.resumeArgs !== undefined && (!Array.isArray(raw.resumeArgs) || raw.resumeArgs.length === 0)) {
      throw new Error(`chat-agents.yaml: target "${id}" has an invalid "resumeArgs"`);
    }
    if (raw.outputFormat !== undefined && !OUTPUT_FORMATS.includes(raw.outputFormat as ChatAgentOutputFormat)) {
      throw new Error(`chat-agents.yaml: target "${id}" has unknown outputFormat "${raw.outputFormat}"`);
    }
    targets[id] = {
      label: raw.label,
      command: raw.command,
      args: raw.args,
      ...(raw.resumeArgs ? { resumeArgs: raw.resumeArgs } : {}),
      ...(raw.outputFormat ? { outputFormat: raw.outputFormat as ChatAgentOutputFormat } : {}),
      ...(raw.timeoutMs ? { timeoutMs: raw.timeoutMs } : {}),
      ...(raw.tags ? { tags: raw.tags } : {}),
      ...(raw.persona ? { persona: raw.persona } : {}),
    };
  }
  return { targets };
}
