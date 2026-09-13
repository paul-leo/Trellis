/**
 * Reads an agent's own real, already-configured MCP servers and converts
 * each into canonical's `McpServerDef` shape — `trellis migrate --only
 * mcp`'s read path (trellis-migrate-mcp-servers). Deliberately separate
 * from each probe's own `AgentSnapshotMcpServer` (src/probes/*.ts) and its
 * thin `{name, transport, probe?}` shape used by `doctor` — that shape
 * discards exactly the fields this module needs, and extending it would
 * risk `doctor`'s existing, extensively-tested behavior for no reason
 * (design.md D1). pi has no static MCP config to read at all — no reader
 * is defined for it; `migrate.ts` skips pi for the `mcp` category
 * entirely, the same fact already established for skills/instructions.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerDef, Transport } from "../core/types.js";
import { readJsonFile } from "./probeCommon.js";
import { readServerEnvTable } from "./tomlSection.js";

export interface McpMigrateEntry {
  name: string;
  def: McpServerDef;
}

export interface McpMigrateUnsupported {
  name: string;
  reason: string;
}

export interface McpMigrateReadResult {
  entries: McpMigrateEntry[];
  unsupported: McpMigrateUnsupported[];
}

const EMPTY_RESULT: McpMigrateReadResult = { entries: [], unsupported: [] };

/**
 * Trellis's own `env` (name-only reference) vs. `staticEnv` (literal
 * value) split lives in one JSON object on disk (`jsonMcp.ts`'s
 * `renderJsonServerEntry`) — a value is a "name" entry only when it's
 * exactly `${KEY}` referencing its OWN key, matching exactly what that
 * renderer ever produces; anything else (a literal value, or a `${...}`
 * referencing a *different* name) is treated as a literal `staticEnv`
 * value instead of guessed at.
 */
const SELF_VAR_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function splitJsonEnvMap(env: Record<string, string> | undefined): Pick<McpServerDef, "env" | "staticEnv"> {
  if (!env) return {};
  const names: string[] = [];
  const literal: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = SELF_VAR_REF_RE.exec(value);
    if (match && match[1] === key) {
      names.push(key);
    } else {
      literal[key] = value;
    }
  }
  const result: Pick<McpServerDef, "env" | "staticEnv"> = {};
  if (names.length > 0) result.env = names;
  if (Object.keys(literal).length > 0) result.staticEnv = literal;
  return result;
}

/** Shared by claude-code and kiro — both write the identical JSON shape
 * (`jsonMcp.ts` is their common writer). Deliberately richer than either
 * probe's own read-side type: adds `headers`, which both probes' own
 * types currently omit despite it being a real field Trellis itself
 * writes for http/sse servers into this exact shape (confirmed via
 * `grep -n "headers" src/probes/kiro.ts src/probes/claude-code.ts
 * src/adapters/jsonMcp.ts` — only the writer declares it). */
interface RichJsonServerDef {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface RichJsonConfig {
  mcpServers?: Record<string, RichJsonServerDef>;
}

function fromRichJsonServerDef(raw: RichJsonServerDef): McpServerDef | undefined {
  if (raw.url) {
    const transport: Transport = raw.type === "sse" ? "sse" : "http";
    const def: McpServerDef = { transport, url: raw.url };
    if (raw.headers && Object.keys(raw.headers).length > 0) def.headers = raw.headers;
    return def;
  }
  if (!raw.command) return undefined;
  const def: McpServerDef = { transport: "stdio", command: raw.command };
  if (raw.args && raw.args.length > 0) def.args = raw.args;
  Object.assign(def, splitJsonEnvMap(raw.env));
  return def;
}

function readRichJsonMcpDefs(configPath: string): McpMigrateReadResult {
  const parsed = readJsonFile<RichJsonConfig>(configPath);
  const entries: McpMigrateEntry[] = [];
  const unsupported: McpMigrateUnsupported[] = [];
  for (const [name, raw] of Object.entries(parsed?.mcpServers ?? {})) {
    const def = fromRichJsonServerDef(raw);
    if (def) {
      entries.push({ name, def });
    } else {
      unsupported.push({ name, reason: "stdio entry has no command — malformed, skipped" });
    }
  }
  return { entries, unsupported };
}

export function readClaudeCodeMcpDefs(homeDir: string): McpMigrateReadResult {
  return readRichJsonMcpDefs(join(homeDir, ".claude.json"));
}

export function readKiroMcpDefs(homeDir: string): McpMigrateReadResult {
  return readRichJsonMcpDefs(join(homeDir, ".kiro", "settings", "mcp.json"));
}

export interface CodexMcpEntryRich {
  name: string;
  enabled: boolean;
  transport: {
    type: string;
    command?: string;
    args?: string[];
    env_vars?: string[];
    /** Remote-transport fields. Confirmed by running the real,
     * locally-installed `codex-cli 0.154.0` against a hand-written
     * `url`-only server and a `url` + `bearer_token_env_var` server: the
     * type string is `"streamable_http"` (not `"http"`), and the three
     * `*headers*` fields come back `null` when unused. Codex's own
     * config.toml schema (`tomlSection.ts`'s `renderServerSection`) has
     * no way to distinguish `http` from `sse` at all — both render
     * identically — so there is no lossy guess in always reading a
     * remote entry back as `"http"`; that distinction was never stored. */
    url?: string;
    bearer_token_env_var?: string | null;
    http_headers?: unknown;
    env_http_headers?: unknown;
    http_headers_helper?: unknown;
  };
}

/**
 * Pure conversion half — separated from the subprocess/file-read effects
 * below so the stdio/non-stdio/malformed decision logic is unit-testable
 * without a real `codex` binary on PATH (this codebase has no fake-codex
 * fixture anywhere; codex's subprocess dependency is otherwise entirely
 * untested at the unit level).
 */
export function buildCodexMcpReadResult(mcpEntries: CodexMcpEntryRich[], tomlContent: string | undefined): McpMigrateReadResult {
  const entries: McpMigrateEntry[] = [];
  const unsupported: McpMigrateUnsupported[] = [];
  for (const entry of mcpEntries) {
    if (entry.transport.type !== "stdio") {
      const remote = buildCodexRemoteDef(entry);
      if (remote.def) {
        entries.push({ name: entry.name, def: remote.def });
      } else {
        unsupported.push({ name: entry.name, reason: remote.reason });
      }
      continue;
    }
    if (!entry.transport.command) {
      unsupported.push({ name: entry.name, reason: "stdio entry has no command — malformed, skipped" });
      continue;
    }
    const def: McpServerDef = { transport: "stdio", command: entry.transport.command };
    if (entry.transport.args && entry.transport.args.length > 0) def.args = entry.transport.args;
    if (entry.transport.env_vars && entry.transport.env_vars.length > 0) def.env = entry.transport.env_vars;
    if (tomlContent) {
      const staticEnv = readServerEnvTable(tomlContent, entry.name);
      if (staticEnv && Object.keys(staticEnv).length > 0) def.staticEnv = staticEnv;
    }
    entries.push({ name: entry.name, def });
  }
  return { entries, unsupported };
}

/**
 * A non-stdio Codex entry converts only when it's exactly `url` (+
 * optional `bearer_token_env_var`) — the one shape this project has
 * verified evidence for, and the only shape Trellis's own writer
 * (`renderServerSection`'s else-branch) ever produces for Codex. Any of
 * the three unexplained `*headers*` fields being non-null means the real
 * server uses a mechanism this codebase has no verified shape for — that
 * entry stays unsupported rather than silently dropping whatever those
 * fields represent.
 */
function buildCodexRemoteDef(entry: CodexMcpEntryRich): { def: McpServerDef; reason?: undefined } | { def?: undefined; reason: string } {
  const { url, bearer_token_env_var: bearerVar, http_headers, env_http_headers, http_headers_helper } = entry.transport;
  if (http_headers != null || env_http_headers != null || http_headers_helper != null) {
    return { reason: `codex migrate-in does not support this server's header mechanism (http_headers/env_http_headers/http_headers_helper) — no verified shape for it` };
  }
  if (!url) {
    return { reason: `codex migrate-in: non-stdio entry has no url — malformed, skipped` };
  }
  const def: McpServerDef = { transport: "http", url };
  if (bearerVar) {
    def.headers = { Authorization: `Bearer \${${bearerVar}}` };
  }
  return { def };
}

/**
 * Stdio only (design.md D2) — `codex mcp list --json`'s own output never
 * exposes `url`/`bearer_token_env_var` in this codebase's `CodexMcpEntry`
 * (src/probes/codex.ts), and this codebase has no verified evidence for
 * what that subprocess reports for a non-stdio server. Guessing at an
 * external tool's unverified output shape is exactly what this project's
 * "verify, don't assume" discipline exists to prevent — a non-stdio
 * entry is reported as unsupported instead.
 */
export function readCodexMcpDefs(homeDir: string): McpMigrateReadResult {
  let raw: string;
  try {
    // `codex` resolves its own config via $HOME (confirmed by running it
    // with an overridden HOME against an empty scratch dir — it returns
    // `[]`, not the real machine's servers), so this must be scoped to
    // `homeDir` explicitly — `src/probes/codex.ts`'s own equivalent call
    // has this same gap, unaddressed there; not touched by this change.
    raw = execFileSync("codex", ["mcp", "list", "--json"], { encoding: "utf-8", timeout: 5_000, env: { ...process.env, HOME: homeDir } });
  } catch {
    return EMPTY_RESULT;
  }

  let mcpEntries: CodexMcpEntryRich[];
  try {
    mcpEntries = JSON.parse(raw) as CodexMcpEntryRich[];
  } catch {
    return EMPTY_RESULT;
  }

  const configToml = join(homeDir, ".codex", "config.toml");
  let tomlContent: string | undefined;
  try {
    tomlContent = readFileSync(configToml, "utf-8");
  } catch {
    tomlContent = undefined;
  }

  return buildCodexMcpReadResult(mcpEntries, tomlContent);
}
