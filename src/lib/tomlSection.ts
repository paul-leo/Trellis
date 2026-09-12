/**
 * Locate and splice a single `[mcp_servers.<name>]` section in Codex's
 * `config.toml` — never a general TOML parser. Both realistic library
 * candidates (`@iarna/toml`, `smol-toml`) were tested directly against a
 * real fixture and silently drop comments + reformat arrays on a bare
 * parse→stringify round-trip (design.md D2, trellis-mcp-sync-p2) — not
 * safe for "touch nothing outside the target section." This module only
 * ever needs to recognize table headers and render a bounded, known
 * shape (`McpServerDef`), never general TOML.
 */

import type { McpServerDef } from "../core/types.js";

export interface SectionRange {
  /** Line index (0-based) of the `[header]` line itself. */
  start: number;
  /** Line index (0-based, inclusive) of the section's last line. */
  end: number;
}

/**
 * Matches a TOML table header line, and *only* a table header line — the
 * entire trimmed line must be exactly `[key.path]` or `[[key.path]]`,
 * each path segment a bare key or a quoted string, nothing else on the
 * line. Deliberately strict: a multi-line array literal elsewhere in the
 * file (e.g. `[1, 2],` as a continuation line) must never be mistaken for
 * a new table boundary — that line has trailing content (`,`) and its
 * bracket contents aren't a valid key path, so this regex correctly
 * rejects it. See tasks.md 2.8.
 */
const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const TABLE_HEADER_RE = new RegExp(`^\\[{1,2}${KEY_SEGMENT}(?:\\.${KEY_SEGMENT})*\\]{1,2}$`);

function isTableHeaderLine(line: string): boolean {
  return TABLE_HEADER_RE.test(line.trim());
}

/** Quotes a key segment if it isn't a valid bare TOML key. */
function tomlKeySegment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function serverHeader(name: string): string {
  return `mcp_servers.${tomlKeySegment(name)}`;
}

/**
 * Finds an existing `[header]` table's exact line range: `start` is the
 * header line itself, `end` is the line before the next table header (any
 * `[...]`/`[[...]]`, not just another mcp_servers one) or EOF, whichever
 * comes first. Returns `null` if no such header exists.
 */
export function findSection(content: string, header: string): SectionRange | null {
  const lines = content.split("\n");
  const headerLine = `[${header}]`;
  const start = lines.findIndex((line) => line.trim() === headerLine);
  if (start === -1) {
    return null;
  }

  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (isTableHeaderLine(lines[i])) {
      end = i - 1;
      break;
    }
  }
  // Don't include a trailing blank separator (or, at EOF, the empty
  // sentinel element split() leaves after a file's final newline), and
  // don't include a trailing comment-only block either — a comment
  // immediately before the NEXT `[header]` documents that section, not
  // this one (found via the sandbox fixture: a multi-line comment
  // introducing `[mcp_servers.sentry]` was getting swallowed into the
  // *previous* section's range and would have been deleted by an
  // unrelated update to that prior section).
  while (end > start && (lines[end].trim() === "" || lines[end].trim().startsWith("#"))) {
    end -= 1;
  }
  return { start, end };
}

/**
 * Returns the current stored text of `[mcp_servers.<name>]` (or `null` if
 * it doesn't exist), for comparing against `renderServerSection`'s output
 * to decide create/repair vs. no-op — exact text equality is enough here,
 * no parsing needed on either side.
 */
export function currentServerSectionText(content: string, name: string): string | null {
  const header = serverHeader(name);
  const range = findSection(content, header);
  if (!range) {
    return null;
  }
  return content.split("\n").slice(range.start, range.end + 1).join("\n");
}

const BEARER_TOKEN_VALUE_RE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * The only `headers` shape Codex's own real schema can express — it has
 * no generic headers concept, only this one purpose-built field
 * (trellis-mcp-transport-auth design.md D4, matching what Codex's own
 * `mcp add --bearer-token-env-var` CLI generates): exactly one entry,
 * key `Authorization`, value exactly `Bearer ${VAR}`. Returns the var
 * name, or `undefined` if `headers` is absent or any other shape —
 * callers (mcpPlan.ts) refuse-and-conflict on "any other shape" rather
 * than this function silently rendering nothing for it.
 */
export function codexBearerTokenEnvVar(def: McpServerDef): string | undefined {
  const entries = Object.entries(def.headers ?? {});
  if (entries.length !== 1) return undefined;
  const [key, value] = entries[0];
  if (key !== "Authorization") return undefined;
  return BEARER_TOKEN_VALUE_RE.exec(value)?.[1];
}

/** Renders a `[mcp_servers.<name>]` block for a bounded, known shape —
 * this is templating, not general TOML serialization. */
export function renderServerSection(name: string, def: McpServerDef): string {
  const lines = [`[${serverHeader(name)}]`];
  if (def.transport === "stdio") {
    if (def.command) lines.push(`command = ${tomlString(def.command)}`);
    if (def.args && def.args.length > 0) lines.push(`args = ${tomlStringArray(def.args)}`);
    if (def.env && def.env.length > 0) lines.push(`env_vars = ${tomlStringArray(def.env)}`);
  } else {
    if (def.url) lines.push(`url = ${tomlString(def.url)}`);
    const bearerEnvVar = codexBearerTokenEnvVar(def);
    if (bearerEnvVar) lines.push(`bearer_token_env_var = ${tomlString(bearerEnvVar)}`);
  }
  return lines.join("\n");
}

/**
 * Replaces an existing section in place, or appends a new one at EOF
 * (with a leading blank-line separator) if none exists yet. Never touches
 * any line outside the section it locates or the single appended block.
 */
export function upsertSection(content: string, name: string, def: McpServerDef): string {
  const header = serverHeader(name);
  const existing = findSection(content, header);
  const newLines = renderServerSection(name, def).split("\n");

  if (existing) {
    const lines = content.split("\n");
    lines.splice(existing.start, existing.end - existing.start + 1, ...newLines);
    return lines.join("\n");
  }

  const withoutTrailingNewlines = content.replace(/\n+$/, "");
  return `${withoutTrailingNewlines}\n\n${newLines.join("\n")}\n`;
}

/**
 * Removes an existing section (and one immediately-preceding blank line,
 * if any, so repeated add/remove doesn't accumulate blank separators).
 * No-op if the section doesn't exist — idempotent.
 */
export function removeSection(content: string, name: string): string {
  const header = serverHeader(name);
  const existing = findSection(content, header);
  if (!existing) {
    return content;
  }

  const lines = content.split("\n");
  let deleteStart = existing.start;
  if (deleteStart > 0 && lines[deleteStart - 1].trim() === "") {
    deleteStart -= 1;
  }
  lines.splice(deleteStart, existing.end - deleteStart + 1);
  return lines.join("\n");
}
