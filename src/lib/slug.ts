/**
 * Kebab-case, filesystem-safe slug for deriving a file/dir name from an
 * arbitrary display name (e.g. a memory graph entity's own name, which
 * can contain spaces, mixed case, or punctuation). Collision handling
 * (two different inputs producing the same slug) is the caller's
 * concern (trellis-memory-extraction design.md D3) — this function only
 * ever normalizes one input at a time.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
