/** Ownership record for the two ZCode native-Skill controls Trellis changes
 * during strict Runtime delivery. MCP ownership stays in mcpOwnership.ts;
 * this separate record lets a later native/both delivery restore the user's
 * prior values without treating an ordinary config key as an MCP server. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ZcodeSkillControlValues {
  featuresSkill: boolean | null;
  skillsEnabled: boolean | null;
}

export interface ZcodeSettingsOwnership {
  configPath: string;
  managed: ZcodeSkillControlValues;
  previous: ZcodeSkillControlValues;
}

export function zcodeSettingsOwnershipPath(homeDir: string): string {
  return join(homeDir, ".trellis", "zcode", "settings-ownership.json");
}

export function loadZcodeSettingsOwnership(homeDir: string): ZcodeSettingsOwnership | undefined {
  const path = zcodeSettingsOwnershipPath(homeDir);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ZcodeSettingsOwnership;
    if (
      typeof value.configPath !== "string"
      || typeof value.managed?.featuresSkill !== "boolean"
      || typeof value.managed?.skillsEnabled !== "boolean"
      || (value.previous?.featuresSkill !== null && typeof value.previous?.featuresSkill !== "boolean")
      || (value.previous?.skillsEnabled !== null && typeof value.previous?.skillsEnabled !== "boolean")
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function saveZcodeSettingsOwnership(homeDir: string, value: ZcodeSettingsOwnership): void {
  const path = zcodeSettingsOwnershipPath(homeDir);
  mkdirSync(join(homeDir, ".trellis", "zcode"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function forgetZcodeSettingsOwnership(homeDir: string): void {
  const path = zcodeSettingsOwnershipPath(homeDir);
  if (existsSync(path)) writeFileSync(path, "");
}
