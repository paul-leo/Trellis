import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Resource, ReadResourceResult, Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isInScope } from "../core/adapter.js";
import { loadCanonicalSource } from "../core/canonical.js";
import { resolveScope } from "../core/types.js";
import type { AgentId, CanonicalSource, SkillRef } from "../core/types.js";
import type { RuntimeContext, TrellisProvider } from "./mcpRuntime.js";

const MAX_FILE_BYTES = 256 * 1024;
const SKILL_RESOURCE_PREFIX = "trellis://skills/";

const SEARCH_TOOL: Tool = {
  name: "trellis.skills.search",
  description: "Search in-scope Trellis skills by name or description, then read one selected skill on demand.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const READ_TOOL: Tool = {
  name: "trellis.skills.read",
  description: "Read the SKILL.md instructions for one in-scope Trellis skill.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const READ_FILE_TOOL: Tool = {
  name: "trellis.skills.read_file",
  description: "Read one bounded, non-secret supporting file under an in-scope skill directory.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, relativePath: { type: "string" } },
    required: ["name", "relativePath"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function frontmatter(content: string): { name?: string; description?: string } {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = parseYaml(content.slice(3, end)) as { name?: unknown; description?: unknown } | null;
    return {
      name: typeof parsed?.name === "string" ? parsed.name : undefined,
      description: typeof parsed?.description === "string" ? parsed.description : undefined,
    };
  } catch {
    return {};
  }
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSecretLikePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.includes(".env") || normalized.includes("secret") || normalized.endsWith("servers.local.env");
}

function skillFor(canonical: CanonicalSource, agentId: AgentId, name: string) {
  const skill = canonical.skills.find((candidate) => candidate.name === name);
  if (!skill || !hasSkillDocument(skill) || !isInScope(agentId, skill.scope, canonical.managedAgents)) return undefined;
  return skill;
}

function hasSkillDocument(skill: SkillRef): boolean {
  try {
    return statSync(resolve(skill.dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

function skillUri(name: string): string {
  return `${SKILL_RESOURCE_PREFIX}${encodeURIComponent(name)}/SKILL.md`;
}

function skillMetadata(skill: SkillRef, canonical: CanonicalSource, agentId: AgentId, content: string): Record<string, unknown> {
  const metadata = frontmatter(content);
  return {
    name: skill.name,
    description: metadata.description ?? "",
    fingerprint: fingerprint(content),
    uri: skillUri(skill.name),
    scope: resolveScope(skill.scope, canonical.managedAgents).includes(agentId) ? "in-scope" : "out-of-scope",
    source: "canonical",
  };
}

export class SkillProvider implements TrellisProvider {
  readonly id = "skills";

  listTools(): Tool[] {
    return [SEARCH_TOOL, READ_TOOL, READ_FILE_TOOL];
  }

  async callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult> {
    const canonical = loadCanonicalSource(context.homeDir);
    const input = (args ?? {}) as Record<string, unknown>;
    if (name === SEARCH_TOOL.name) return this.search(canonical, context.agentId, input);
    if (name === READ_TOOL.name) return this.readSkill(canonical, context.agentId, input);
    if (name === READ_FILE_TOOL.name) return this.readFile(canonical, context.agentId, input);
    return errorResult(`unknown skill provider tool "${name}"`);
  }

  listResources(context: RuntimeContext): Resource[] {
    const canonical = loadCanonicalSource(context.homeDir);
    return canonical.skills
      .filter((skill) => hasSkillDocument(skill) && isInScope(context.agentId, skill.scope, canonical.managedAgents))
      .map((skill) => ({
        uri: skillUri(skill.name),
        name: `${skill.name}/SKILL.md`,
        description: `Instructions for the ${skill.name} skill`,
        mimeType: "text/markdown",
      }));
  }

  readResource(uri: URL, context: RuntimeContext): ReadResourceResult {
    if (uri.protocol !== "trellis:" || uri.hostname !== "skills") {
      throw new Error(`unsupported skill resource URI "${uri.toString()}"`);
    }
    const segments = uri.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.length !== 2 || segments[1] !== "SKILL.md") {
      throw new Error(`unsupported skill resource URI "${uri.toString()}"`);
    }
    const canonical = loadCanonicalSource(context.homeDir);
    const skill = skillFor(canonical, context.agentId, segments[0]);
    if (!skill) throw new Error(`skill "${segments[0]}" is not available to ${context.agentId}`);
    const content = this.readBoundedFile(resolve(skill.dir, "SKILL.md"), skill.dir);
    return { contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: content }] };
  }

  private search(canonical: CanonicalSource, agentId: AgentId, input: Record<string, unknown>): CallToolResult {
    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    const limit = typeof input.limit === "number" ? Math.min(50, Math.max(1, Math.floor(input.limit))) : 20;
    const results = canonical.skills
      .filter((skill) => isInScope(agentId, skill.scope, canonical.managedAgents))
      .map((skill) => {
        let content: string;
        try {
          content = this.readBoundedFile(resolve(skill.dir, "SKILL.md"), skill.dir);
        } catch {
          return undefined;
        }
        return { ...skillMetadata(skill, canonical, agentId, content), dir: skill.dir };
      })
      .filter((skill): skill is { name: string; description: string; fingerprint: string; uri: string; scope: string; source: string; dir: string } => skill !== undefined)
      .filter((skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query))
      .slice(0, limit)
      .map(({ dir: _dir, ...result }) => result);
    return textResult({ skills: results });
  }

  private readSkill(canonical: CanonicalSource, agentId: AgentId, input: Record<string, unknown>): CallToolResult {
    if (typeof input.name !== "string" || input.name.length === 0) return errorResult('"name" is required');
    const skill = skillFor(canonical, agentId, input.name);
    if (!skill) return errorResult(`skill "${input.name}" is not available to ${agentId}`);
    const path = resolve(skill.dir, "SKILL.md");
    const content = this.readBoundedFile(path, skill.dir);
    return textResult({ ...skillMetadata(skill, canonical, agentId, content), content });
  }

  private readFile(canonical: CanonicalSource, agentId: AgentId, input: Record<string, unknown>): CallToolResult {
    if (typeof input.name !== "string" || typeof input.relativePath !== "string") return errorResult('"name" and "relativePath" are required');
    const skill = skillFor(canonical, agentId, input.name);
    if (!skill) return errorResult(`skill "${input.name}" is not available to ${agentId}`);
    if (input.relativePath.length === 0 || input.relativePath.includes("\0") || isSecretLikePath(input.relativePath)) {
      return errorResult("supporting file path is not allowed");
    }
    try {
      const path = resolve(skill.dir, input.relativePath);
      const root = realpathSync(skill.dir);
      const realPath = realpathSync(path);
      const rel = relative(root, realPath);
      if (rel.startsWith(`..${sep}`) || rel === ".." || !existsSync(realPath) || !statSync(realPath).isFile()) {
        return errorResult("supporting file is outside the skill root");
      }
      return textResult({ name: skill.name, relativePath: rel, source: "canonical-skill-supporting-file", content: this.readBoundedFile(realPath, root) });
    } catch (err) {
      return errorResult(`could not read supporting file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private readBoundedFile(path: string, root: string): string {
    if (isSecretLikePath(path)) throw new Error("secret-like files are not readable through the skill provider");
    const rootPath = realpathSync(root);
    const realPath = realpathSync(path);
    const rel = relative(rootPath, realPath);
    if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("file is outside the skill root");
    const stat = statSync(realPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds the ${MAX_FILE_BYTES}-byte provider limit`);
    return readFileSync(realPath, "utf8");
  }
}
