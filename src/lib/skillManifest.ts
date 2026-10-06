/**
 * Manifest for serving a canonical skill in the shape the Skills-over-MCP
 * extension defines (trellis-skills-over-mcp design.md D2/D3): every file's
 * URI, `sha256:<hex>` digest and byte size, computed from the exact bytes
 * that `resources/read` returns. One reader serves both, so the manifest and
 * the content can never disagree.
 *
 * A digest here means "these bytes match this manifest" — it is not a claim
 * about the content's safety (design.md D5).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

/** The extension's SHOULD-NOT-exceed limits per skill. */
export const MAX_SKILL_FILES = 512;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
/** Same per-file bound the existing provider tools enforce. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

const SKILL_SCHEME = "skill://";
/** Agent Skills naming rule: lowercase alphanumerics and single hyphens. It
 * also keeps the name safe as a URI authority, which lowercases. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKIPPED_DIRS = new Set(["node_modules"]);

export interface SkillManifestFile {
  uri: string;
  digest: string;
  size: number;
}

export interface SkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: SkillManifestFile[];
  _meta?: Record<string, unknown>;
}

export type SkillBuild = { ok: true; entry: SkillEntry } | { ok: false; reason: string };

export function skillRootUri(name: string): string {
  return `${SKILL_SCHEME}${name}/SKILL.md`;
}

export function skillFileUri(name: string, relativePath: string): string {
  return `${SKILL_SCHEME}${name}/${relativePath.split(sep).map(encodeURIComponent).join("/")}`;
}

/** `skill://<name>/<path>` → parts, or undefined for any other shape. Parsed
 * by hand: `URL` would lowercase the authority and mangle odd names. */
export function parseSkillUri(uri: string): { name: string; path: string } | undefined {
  if (!uri.startsWith(SKILL_SCHEME)) return undefined;
  const rest = uri.slice(SKILL_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const name = rest.slice(0, slash);
  try {
    const segments = rest.slice(slash + 1).split("/").map(decodeURIComponent);
    if (segments.length === 0 || segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
    return { name, path: segments.join("/") };
  } catch {
    return undefined;
  }
}

function isSecretLikePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.includes(".env") || normalized.includes("secret") || normalized.endsWith("servers.local.env");
}

export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The one reader. Refuses secret-shaped paths, anything resolving outside the
 * skill root (symlink escape included), non-files and oversized files; returns
 * the raw bytes otherwise.
 */
export function readSkillFileBytes(skillDir: string, relativePath: string): Buffer {
  if (relativePath.length === 0 || relativePath.includes("\0") || isSecretLikePath(relativePath)) {
    throw new Error("supporting file path is not allowed");
  }
  const root = realpathSync(skillDir);
  const real = realpathSync(resolve(skillDir, relativePath));
  const rel = relative(root, real);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel === "") throw new Error("file is outside the skill root");
  if (isSecretLikePath(rel)) throw new Error("secret-like files are not readable through the skill provider");
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_SKILL_FILE_BYTES) throw new Error(`file exceeds the ${MAX_SKILL_FILE_BYTES}-byte provider limit`);
  return readFileSync(real);
}

export function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".html")) return "text/html";
  return "text/plain";
}

/** Valid UTF-8 round-trips exactly as `text`; anything else must go out as a
 * base64 blob, or the bytes a host verifies would not be the bytes we hashed. */
export function toResourceContent(uri: string, path: string, bytes: Buffer): { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { uri, mimeType: mimeTypeFor(path), text };
  } catch {
    return { uri, mimeType: "application/octet-stream", blob: bytes.toString("base64") };
  }
}

function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  try {
    const parsed = parseYaml(content.slice(3, end));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Walks the skill directory without following links out of it. Stops as soon
 * as a limit is exceeded so a huge tree is never fully traversed. */
function collectFiles(skillDir: string): { files: string[] } | { tooLarge: string } {
  const files: string[] = [];
  const stack = [skillDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || SKIPPED_DIRS.has(name)) continue;
      const full = resolve(dir, name);
      const link = lstatSync(full);
      if (link.isSymbolicLink()) {
        // A link is followed only if it stays inside the root and is a file.
        try {
          const target = realpathSync(full);
          const rel = relative(realpathSync(skillDir), target);
          if (rel.startsWith(`..${sep}`) || rel === ".." || !statSync(target).isFile()) continue;
        } catch {
          continue;
        }
      } else if (link.isDirectory()) {
        stack.push(full);
        continue;
      } else if (!link.isFile()) {
        continue;
      }
      files.push(relative(skillDir, full));
      if (files.length > MAX_SKILL_FILES) return { tooLarge: `more than ${MAX_SKILL_FILES} files` };
    }
  }
  return { files };
}

/**
 * Builds the entry for one skill, or says why it cannot be served. A skill
 * that breaks a limit is omitted whole rather than published with a partial
 * manifest — a partial manifest is a false claim of completeness (D2).
 */
export function buildSkillEntry(name: string, skillDir: string): SkillBuild {
  if (!NAME_RE.test(name) || name.length > 64) {
    return { ok: false, reason: `"${name}" is not a valid Agent Skills name (lowercase letters, digits and single hyphens, at most 64 characters)` };
  }
  if (!existsSync(resolve(skillDir, "SKILL.md"))) return { ok: false, reason: `"${name}" has no SKILL.md` };

  let skillMd: Buffer;
  try {
    skillMd = readSkillFileBytes(skillDir, "SKILL.md");
  } catch (err) {
    return { ok: false, reason: `"${name}" SKILL.md cannot be served: ${err instanceof Error ? err.message : String(err)}` };
  }
  const frontmatter = parseFrontmatter(skillMd.toString("utf8"));
  if (!frontmatter || typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string" || frontmatter.description.length === 0) {
    return { ok: false, reason: `"${name}" SKILL.md frontmatter needs a string name and a non-empty description` };
  }
  if (frontmatter.name !== name) {
    return { ok: false, reason: `"${name}" directory name does not match its frontmatter name "${frontmatter.name}"` };
  }

  const collected = collectFiles(skillDir);
  if ("tooLarge" in collected) return { ok: false, reason: `"${name}" exceeds the extension's size limit (${collected.tooLarge})` };

  const resources: SkillManifestFile[] = [];
  let total = 0;
  for (const rel of collected.files) {
    let bytes: Buffer;
    try {
      bytes = readSkillFileBytes(skillDir, rel);
    } catch {
      continue; // refused by the reader: absent from the manifest and from reads alike
    }
    total += bytes.length;
    if (total > MAX_SKILL_BYTES) return { ok: false, reason: `"${name}" exceeds the extension's size limit (more than ${MAX_SKILL_BYTES} bytes)` };
    resources.push({ uri: skillFileUri(name, rel), digest: digestOf(bytes), size: bytes.length });
  }
  if (!resources.some((file) => file.uri === skillRootUri(name))) {
    return { ok: false, reason: `"${name}" SKILL.md is missing from its own manifest` };
  }
  return { ok: true, entry: { uri: skillRootUri(name), frontmatter, resources } };
}
