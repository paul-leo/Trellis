/**
 * Extracts the environment-variable *names* an agent's real MCP config
 * declares — not a general parser for either format, just the one shape
 * each needs (trellis-secrets-audit-p3 design.md D1). Read-only: unlike
 * src/lib/tomlSection.ts (a write-path module with a different job),
 * there is no round-trip-fidelity concern here, but a full parser is
 * still more machinery than this one narrow extraction needs.
 */

interface McpServersJson {
  mcpServers?: Record<string, { env?: Record<string, string> }>;
}

/** Claude Code / Kiro's config is real JSON — parse it and walk each
 * server's `env` object keys. Returns `[]` (not a throw) on invalid JSON;
 * that's a diagnostic for a different command, not this extractor's job. */
export function extractJsonEnvVarNames(content: string): string[] {
  let parsed: McpServersJson;
  try {
    parsed = JSON.parse(content) as McpServersJson;
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const server of Object.values(parsed.mcpServers ?? {})) {
    names.push(...Object.keys(server.env ?? {}));
  }
  return names;
}

const ENV_VARS_LINE_RE = /^\s*env_vars\s*=\s*\[(.*)\]\s*$/;
const QUOTED_STRING_RE = /"((?:[^"\\]|\\.)*)"/g;

/** Codex's config is TOML, but the only shape audit needs is every
 * `env_vars = [...]` line's quoted string contents — a five-line regex,
 * not a parser (design.md D1). */
export function extractTomlEnvVarNames(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split("\n")) {
    const match = ENV_VARS_LINE_RE.exec(line);
    if (!match) continue;
    for (const stringMatch of match[1].matchAll(QUOTED_STRING_RE)) {
      names.push(stringMatch[1]);
    }
  }
  return names;
}
