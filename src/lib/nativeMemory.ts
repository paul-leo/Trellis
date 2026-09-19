import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { AgentId } from "../core/types.js";
import { slugify } from "./slug.js";

export const MAX_NATIVE_MEMORY_BYTES = 256 * 1024;

export type NativeMemoryStatus = "supported" | "empty" | "unsupported";

export interface NativeMemoryCandidate {
  sourceAgent: AgentId;
  sourceId: string;
  sourcePath: string;
  displayName: string;
  targetName: string;
  content: string;
}

export interface NativeMemoryDiscovery {
  adapter: string;
  status: NativeMemoryStatus;
  detail: string;
  candidates: NativeMemoryCandidate[];
}

function claudeProjectKey(workspaceDir: string): string {
  const absolute = resolve(workspaceDir);
  const normalized = absolute
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-");
  return `-${normalized}`;
}

function safeMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  return readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(root, name))
    .filter((file) => {
      try {
        const realFile = realpathSync(file);
        const rel = relative(realRoot, realFile);
        return !rel.startsWith(`..${sep}`) && rel !== ".." && statSync(realFile).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export function discoverNativeMemory(agent: AgentId, homeDir: string = homedir(), workspaceDir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): NativeMemoryDiscovery {
  if (agent === "codex") {
    const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, ".codex");
    const memoryRoot = join(codexHome, "memories");
    const files = safeMarkdownFiles(memoryRoot);
    if (files.length === 0) {
      return {
        adapter: "codex-local-memory",
        status: "empty",
        detail: `no Markdown memory files found under ${memoryRoot}; session indexes and non-Markdown state were not inspected`,
        candidates: [],
      };
    }
    const candidates: NativeMemoryCandidate[] = [];
    for (const file of files) {
      const stat = statSync(file);
      if (stat.size > MAX_NATIVE_MEMORY_BYTES) continue;
      const content = readFileSync(file, "utf8");
      const displayName = basename(file, ".md");
      const targetName = `codex-${slugify(displayName)}`;
      if (!targetName || targetName === "codex-") continue;
      candidates.push({
        sourceAgent: agent,
        sourceId: `codex/${displayName}`,
        sourcePath: file,
        displayName,
        targetName,
        content,
      });
    }
    return {
      adapter: "codex-local-memory",
      status: candidates.length > 0 ? "supported" : "empty",
      detail: candidates.length > 0
        ? `found ${candidates.length} bounded Markdown memory file(s) under ${memoryRoot}`
        : "Codex memory files were empty, oversized, or unsafe to read",
      candidates,
    };
  }

  if (agent !== "claude-code") {
    return {
      adapter: "none",
      status: "unsupported",
      detail: `${agent} native memory is unsupported: sessions or private stores do not have a supported Trellis adapter; no session, cache, SQLite, or credential data was read`,
      candidates: [],
    };
  }

  const projectKey = claudeProjectKey(workspaceDir);
  const memoryRoot = join(homeDir, ".claude", "projects", projectKey, "memory");
  const files = safeMarkdownFiles(memoryRoot);
  if (files.length === 0) {
    return {
      adapter: "claude-code-project-memory",
      status: "empty",
      detail: `no Markdown memory files found for the exact current workspace project key "${projectKey}"`,
      candidates: [],
    };
  }

  const candidates: NativeMemoryCandidate[] = [];
  for (const file of files) {
    const stat = statSync(file);
    if (stat.size > MAX_NATIVE_MEMORY_BYTES) continue;
    const content = readFileSync(file, "utf8");
    const displayName = basename(file, ".md");
    const targetName = `claude-${slugify(projectKey)}-${slugify(displayName)}`;
    if (!targetName || targetName === "claude-") continue;
    candidates.push({
      sourceAgent: agent,
      sourceId: `claude-code/${projectKey}/${displayName}`,
      sourcePath: file,
      displayName,
      targetName,
      content,
    });
  }

  return {
    adapter: "claude-code-project-memory",
    status: candidates.length > 0 ? "supported" : "empty",
    detail: candidates.length > 0
      ? `found ${candidates.length} bounded Markdown memory file(s) for the exact current workspace project key "${projectKey}"`
      : "memory files were empty, oversized, or unsafe to read",
    candidates,
  };
}

export function renderNativeMemory(candidate: Pick<NativeMemoryCandidate, "sourceAgent" | "sourceId" | "content">): string {
  return `<!-- Trellis import: ${candidate.sourceAgent} / ${candidate.sourceId} -->\n\n${candidate.content.replace(/^\s+|\s+$/g, "")}\n`;
}
