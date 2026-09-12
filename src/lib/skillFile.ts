/**
 * Case-sensitive SKILL.md detection. A file saved as `skill.md` is silently
 * dropped from discovery on at least one target agent (Codex — see
 * docs/research.md) with no warning; `doctor` exists in part to catch this
 * before an agent does, so the wrong-case case must be reported, not
 * treated the same as "no skill file present at all."
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface SkillFileResult {
  path: string;
  caseCorrect: boolean;
}

export function findSkillFile(dir: string): SkillFileResult | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  if (entries.includes("SKILL.md")) {
    return { path: join(dir, "SKILL.md"), caseCorrect: true };
  }

  const wrongCase = entries.find((name) => name.toLowerCase() === "skill.md");
  if (wrongCase) {
    return { path: join(dir, wrongCase), caseCorrect: false };
  }

  return null;
}
