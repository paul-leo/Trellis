/** Skill scope is a registry, not an exceptions list. Unregistered or
 * invalid entries stay paused until applicable agents are selected. */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ALL_AGENTS, type AgentId } from "../core/types.js";
import { resolveScopeSelection, type ScopeSelectorRaw } from "./scopeSelection.js";
import { canUseInteractivePicker, runMultiSelectPicker } from "./terminalPicker.js";

export function registeredSkillScope(value: unknown): AgentId[] {
  return Array.isArray(value) && value.every((id) => ALL_AGENTS.includes(id)) ? [...new Set(value)] : [];
}

export function readSkillScopes(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const doc = parseYaml(readFileSync(path, "utf8"));
  if (doc?.skills === undefined) return {};
  if (typeof doc.skills !== "object" || doc.skills === null || Array.isArray(doc.skills)) {
    throw new Error(`${path}: skills must be a map of skill names to agent lists`);
  }
  return doc.skills;
}

export function selectSkillScope(raw: ScopeSelectorRaw, managed: readonly AgentId[]): { scope: AgentId[] } | { error: string } {
  const selected = resolveScopeSelection(raw, managed);
  if (!selected.ok) return { error: selected.detail };
  // Even "all" records today's set. Managing another agent later must
  // never expand the compatibility decision made for an existing skill.
  return { scope: selected.scope ?? [...managed] };
}

export async function requestSkillScope(raw: ScopeSelectorRaw, managed: readonly AgentId[], interactive: boolean): Promise<{ scope: AgentId[] } | { error: string }> {
  if (raw.agents !== undefined || raw.all || raw.none) return selectSkillScope(raw, managed);
  if (!interactive || !canUseInteractivePicker()) {
    return { error: "choose applicable agents with --agents <ids>, --all or --none; no scope is selected automatically" };
  }
  if (managed.length === 0) return { error: "no managed agents — run trellis onboard, or use --none to import a paused skill" };
  const indices = await runMultiSelectPicker([...managed], managed.map(() => false), undefined, "选择这个 skill 适用的 agent（不选则暂停分发）");
  return indices === null ? { error: "skill import cancelled" } : { scope: indices.map((index) => managed[index]) };
}
