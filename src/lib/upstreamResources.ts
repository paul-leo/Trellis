import { z } from "zod/v4";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import type { Client, Resource, ReadResourceResult } from "@modelcontextprotocol/client";
import { digestOf, MAX_SKILL_BYTES, MAX_SKILL_FILES, type SkillEntry, type SkillManifestFile } from "./skillManifest.js";
import { withTimeout } from "./mcpConnect.js";

const EXTENSION = "io.modelcontextprotocol/skills";
const listSchema = z.looseObject({ skills: z.array(z.unknown()), nextCursor: z.string().optional() });
const getSchema = z.looseObject({ skill: z.unknown() });
const PREFIX = "trellis-upstream:";

/** The outer response belongs to the gateway; upstream identity is provenance. */
export function withoutUpstreamServerInfo<T extends { _meta?: Record<string, unknown> }>(result: T): T {
  if (!result._meta || !("io.modelcontextprotocol/serverInfo" in result._meta)) return result;
  const { "io.modelcontextprotocol/serverInfo": _server, ...meta } = result._meta;
  return { ...result, _meta: meta };
}

/** Retain path segments so relative supporting-file references remain valid. */
export function upstreamUri(source: string, uri: string): string {
  const original = new URL(uri);
  if (original.username || original.password || !original.pathname.startsWith("/")) throw new Error("resource URI must be hierarchical and contain no credentials");
  const label = `s${Buffer.from(source).toString("hex")}`;
  const protocol = Buffer.from(original.protocol).toString("base64url");
  return `${PREFIX}//${label}/${protocol}/${encodeURIComponent(original.host) || "~"}${original.pathname}${original.search}${original.hash}`;
}

function originalUri(uri: string): { source: string; original: string } | undefined {
  try {
    const exposed = new URL(uri);
    if (exposed.protocol !== PREFIX || !/^s(?:[0-9a-f]{2})+$/.test(exposed.hostname)) return undefined;
    const match = /^\/([^/]+)\/([^/]+)(\/.*)$/.exec(exposed.pathname);
    if (!match) return undefined;
    const protocol = Buffer.from(match[1]!, "base64url").toString();
    if (!/^[a-z][a-z0-9+.-]*:$/.test(protocol)) return undefined;
    const source = Buffer.from(exposed.hostname.slice(1), "hex").toString();
    const original = `${protocol}//${match[2] === "~" ? "" : decodeURIComponent(match[2]!)}${match[3]}${exposed.search}${exposed.hash}`;
    if (upstreamUri(source, original) !== uri) return undefined;
    return { source, original };
  } catch { return undefined; }
}

interface FileRoute { source: string; original: string; manifest?: SkillManifestFile; skill?: string; frontmatter?: Record<string, unknown> }

export class UpstreamResources {
  private readonly clients = new Map<string, Client>();
  private readonly files = new Map<string, FileRoute>();

  constructor(private readonly timeoutMs: number, private readonly warn: (message: string) => void) {}

  add(source: string, client: Client): void { this.clients.set(source, client); }

  private skillsEnabled(client: Client): boolean {
    return Boolean(client.getServerCapabilities()?.resources && client.getDiscoverResult()?.capabilities.extensions?.[EXTENSION]);
  }

  private async isolated<T>(source: string, work: () => Promise<T>, fallback: T): Promise<T> {
    try { return await withTimeout(work(), this.timeoutMs, "upstream resource request timed out"); }
    catch (err) {
      this.warn(`trellis-mcp-runtime: upstream "${source}" resources: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  async listResources(): Promise<Resource[]> {
    const lists = await Promise.all([...this.clients].map(([source, client]) => this.isolated(source, async () => {
      if (!client.getServerCapabilities()?.resources) return [];
      const { resources } = await client.listResources();
      if (resources.length > 8192) throw new Error("upstream resource catalog exceeds 8192 entries");
      return resources.map((resource) => {
        const uri = upstreamUri(source, resource.uri);
        if (!this.files.get(uri)?.manifest) this.files.set(uri, { source, original: resource.uri });
        return { ...resource, uri, _meta: { ...resource._meta, "io.trellis/origin": { server: source, uri: resource.uri } } };
      });
    }, [] as Resource[])));
    return lists.flat();
  }

  private registerSkill(source: string, value: unknown): SkillEntry {
    if (!value || typeof value !== "object") throw new Error("invalid upstream skill entry");
    const entry = value as SkillEntry;
    if (typeof entry.uri !== "string" || !entry.frontmatter || typeof entry.frontmatter.name !== "string" || typeof entry.frontmatter.description !== "string" || !entry.frontmatter.description.trim()) throw new Error("invalid upstream skill metadata");
    if (!Array.isArray(entry.resources) || entry.resources.length === 0 || entry.resources.length > MAX_SKILL_FILES) throw new Error("upstream skill needs a bounded, complete manifest");
    const root = new URL(".", entry.uri).toString();
    if (!new URL(entry.uri).pathname.endsWith("/SKILL.md") || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.frontmatter.name) || entry.frontmatter.name.length > 64) throw new Error("invalid upstream skill name or entry URI");
    const directory = new URL(root);
    const parent = directory.pathname.split("/").filter(Boolean).at(-1) ?? directory.hostname;
    if (decodeURIComponent(parent) !== entry.frontmatter.name) throw new Error("upstream skill name does not match its directory");
    const seen = new Set<string>();
    let total = 0;
    for (const file of entry.resources) {
      if (!file || typeof file.uri !== "string" || !file.uri.startsWith(root) || !/^sha256:[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 0 || seen.has(file.uri)) throw new Error("invalid upstream skill manifest");
      const parsed = new URL(file.uri);
      if (!parsed.toString().startsWith(root)) throw new Error("skill file escaped its source directory");
      upstreamUri(source, file.uri);
      seen.add(file.uri);
      total += file.size;
    }
    if (total > MAX_SKILL_BYTES || !seen.has(entry.uri)) throw new Error("upstream skill manifest exceeds limits or omits SKILL.md");
    const uri = upstreamUri(source, entry.uri);
    for (const [key, route] of this.files) if (route.skill === uri) this.files.delete(key);
    const resources = entry.resources.map((file) => {
      const exposed = upstreamUri(source, file.uri);
      this.files.set(exposed, { source, original: file.uri, manifest: file, skill: uri, ...(file.uri === entry.uri ? { frontmatter: entry.frontmatter } : {}) });
      return { ...file, uri: exposed };
    });
    return { ...entry, uri, resources, _meta: { "io.trellis/origin": { server: source, uri: entry.uri } } };
  }

  async listSkills(): Promise<SkillEntry[]> {
    const lists = await Promise.all([...this.clients].map(([source, client]) => this.isolated(source, async () => {
      if (!this.skillsEnabled(client)) return [];
      const entries: SkillEntry[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 64; page++) {
        const result = await client.request({ method: "skills/list", params: cursor ? { cursor } : {} }, listSchema, { timeout: this.timeoutMs });
        for (const entry of result.skills) {
          if (entries.length >= 2048) throw new Error("upstream skill catalog exceeds 2048 entries");
          try { entries.push(this.registerSkill(source, entry)); }
          catch (err) { this.warn(`trellis-mcp-runtime: omitted skill from "${source}": ${err instanceof Error ? err.message : String(err)}`); }
        }
        if (!result.nextCursor) return entries;
        if (cursors.has(result.nextCursor)) throw new Error("repeated upstream skill cursor");
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error("upstream skill pagination exceeded 64 pages");
    }, [] as SkillEntry[])));
    return lists.flat();
  }

  async getSkill(uri: string): Promise<SkillEntry | undefined> {
    const decoded = originalUri(uri);
    if (!decoded) return undefined;
    const client = this.clients.get(decoded.source);
    if (!client || !this.skillsEnabled(client)) return undefined;
    const result = await client.request({ method: "skills/get", params: { uri: decoded.original } }, getSchema, { timeout: this.timeoutMs });
    if ((result.skill as { uri?: unknown } | undefined)?.uri !== decoded.original) throw new Error("upstream returned another skill identity");
    const entry = this.registerSkill(decoded.source, result.skill);
    if (entry.uri !== uri) throw new Error("upstream returned another skill identity");
    return entry;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const route = this.files.get(uri);
    const client = route && this.clients.get(route.source);
    if (!route || !client) throw new Error("unknown upstream resource");
    const result = await client.readResource({ uri: route.original }, { timeout: this.timeoutMs });
    if (result.contents.length !== 1 || result.contents[0]!.uri !== route.original) throw new Error("upstream resource identity mismatch");
    const content = result.contents[0]!;
    if (route.manifest) {
      const bytes = "blob" in content ? Buffer.from(content.blob, "base64") : Buffer.from(content.text, "utf8");
      if (bytes.length !== route.manifest.size || digestOf(bytes) !== route.manifest.digest) throw new Error("upstream skill file differs from its manifest; refresh the skill entry");
      if (route.frontmatter) {
        const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!match || !isDeepStrictEqual(parseYaml(match[1]!), route.frontmatter)) throw new Error("upstream skill frontmatter differs from its entry");
      }
    }
    return { ...withoutUpstreamServerInfo(result), ttlMs: 0, cacheScope: "private", contents: [{ ...content, uri }] };
  }
}
