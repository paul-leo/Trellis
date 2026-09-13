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

function envHeader(name: string): string {
  return `${serverHeader(name)}.env`;
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
 * A server's full owned range: its main `[mcp_servers.<name>]` table,
 * extended to also cover an immediately-following `[mcp_servers.<name>.env]`
 * table (skipping only blank/comment padding in between — the same skip
 * rule `findSection`'s own trailing trim already applies) when one is
 * present. The two are rendered and managed as one atomic unit whenever
 * `staticEnv` is set (trellis-mcp-static-env-and-disabled-servers
 * design.md D3) — create/repair/remove must never touch one without the
 * other.
 */
function findServerRange(content: string, name: string): SectionRange | null {
  const main = findSection(content, serverHeader(name));
  if (!main) {
    return null;
  }

  const lines = content.split("\n");
  let i = main.end + 1;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) {
    i += 1;
  }
  if (i < lines.length && lines[i].trim() === `[${envHeader(name)}]`) {
    const envRange = findSection(content, envHeader(name));
    if (envRange) {
      return { start: main.start, end: envRange.end };
    }
  }
  return main;
}

/**
 * Returns the current stored text of a server's full owned range (see
 * `findServerRange`) — or `null` if it doesn't exist — for comparing
 * against `renderServerSection`'s output to decide create/repair vs.
 * no-op. Exact text equality is enough here, no parsing needed on either
 * side.
 */
export function currentServerSectionText(content: string, name: string): string | null {
  const range = findServerRange(content, name);
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

/** Renders a `[mcp_servers.<name>]` block (plus, when `staticEnv` is set,
 * an immediately-adjacent `[mcp_servers.<name>.env]` block — see
 * `findServerRange`) for a bounded, known shape — this is templating,
 * not general TOML serialization. */
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
  // `envAliases`' target key gets a literal `${sourceName}` placeholder
  // in the same env table `staticEnv` writes to — Codex's own runtime
  // expands it from its own ambient environment, the same mechanism
  // `env_vars` already relies on for a same-named reference
  // (trellis-migrate-env-var-alias D3).
  const aliasEntries = Object.entries(def.envAliases ?? {}).map(([targetKey, sourceName]) => [targetKey, `\${${sourceName}}`] as const);
  const staticEnvEntries = [...aliasEntries, ...Object.entries(def.staticEnv ?? {})];
  if (staticEnvEntries.length > 0) {
    lines.push(`[${envHeader(name)}]`);
    for (const [key, value] of staticEnvEntries) {
      lines.push(`${tomlKeySegment(key)} = ${tomlString(value)}`);
    }
  }
  return lines.join("\n");
}

const ENV_TABLE_LINE_RE = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/;

/**
 * Reads a server's `[mcp_servers.<name>.env]` table's literal key-value
 * pairs directly from real `config.toml` text — the exact inverse of
 * `renderServerSection`'s own `static_env` block, the only piece of a
 * Codex server's `static_env` that `codex mcp list --json` cannot ever
 * report (it only exposes `env_vars`, i.e. names, from the *main*
 * table — trellis-migrate-mcp-servers design.md D3). Returns `undefined`
 * if the table doesn't exist; a malformed line inside it is skipped, not
 * fatal, matching `parseMemoryGraph`'s own tolerant-parse precedent.
 */
export function readServerEnvTable(content: string, name: string): Record<string, string> | undefined {
  const range = findSection(content, envHeader(name));
  if (!range) {
    return undefined;
  }
  const lines = content.split("\n").slice(range.start + 1, range.end + 1);
  const result: Record<string, string> = {};
  for (const line of lines) {
    const match = ENV_TABLE_LINE_RE.exec(line.trim());
    if (!match) continue;
    const rawKey = match[1];
    const key = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey;
    result[key] = JSON.parse(match[2]) as string;
  }
  return result;
}

/**
 * Replaces an existing section in place, or appends a new one at EOF
 * (with a leading blank-line separator) if none exists yet. Never touches
 * any line outside the section it locates or the single appended block.
 */
export function upsertSection(content: string, name: string, def: McpServerDef): string {
  const existing = findServerRange(content, name);
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
  const existing = findServerRange(content, name);
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
