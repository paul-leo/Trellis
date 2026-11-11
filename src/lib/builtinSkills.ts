import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TRELLIS_RUNTIME_SKILL_NAME = "trellis-runtime";
export const TRELLIS_MEMORY_SKILL_NAME = "trellis-memory";
export const BUILTIN_SKILL_NAMES = [TRELLIS_RUNTIME_SKILL_NAME, TRELLIS_MEMORY_SKILL_NAME] as const;
export type BuiltinSkillName = typeof BUILTIN_SKILL_NAMES[number];

export function isBuiltinSkillName(name: string): name is BuiltinSkillName {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name);
}

export function readBuiltinSkillTemplate(name: BuiltinSkillName): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema", "builtin-skills", name, "SKILL.md"), "utf8");
}

export function readBuiltinSkillFiles(name: BuiltinSkillName): Array<{relativePath: string; content: string}> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema", "builtin-skills", name);
  const files: Array<{relativePath: string; content: string}> = [];
  const visit = (relativeDir: string): void => {
    for (const entry of readdirSync(join(root, relativeDir), {withFileTypes: true})) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") continue;
      const relativePath = join(relativeDir, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile()) files.push({relativePath, content: readFileSync(join(root, relativePath), "utf8")});
    }
  };
  visit("");
  return files;
}
