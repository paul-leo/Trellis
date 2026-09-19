export const TRELLIS_RUNTIME_SKILL_NAME = "trellis-runtime";

export function isBuiltinSkillName(name: string): boolean {
  return name === TRELLIS_RUNTIME_SKILL_NAME;
}
