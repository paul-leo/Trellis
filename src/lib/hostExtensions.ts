/**
 * External host extension loading (host-extension-points spec, 8.6).
 *
 * The ONLY way an external module becomes a Trellis provider or event
 * subscriber: it is declared in the canonical extension manifest at
 * `~/.trellis/mcp/extensions.yaml` (entries carry `id` + a `load` module
 * specifier) and its module exports `activate(ctx)` returning
 * `{ providers?, subscribers? }`. There is no directory scan and no
 * naming convention — a module on disk that the manifest does not name
 * is never imported.
 *
 * Fault isolation is per extension and total: a manifest that fails to
 * parse, an entry of the wrong shape, an import that throws, an
 * `activate` that throws, or an activation of the wrong shape are each
 * recorded as a failure (and warned), and none of them affect the core
 * providers, upstream servers, or any other extension. With no manifest
 * the loader returns empty everything and the gateway is byte-identical
 * to the pre-extension world.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentId } from "../core/types.js";
import { writeFileAtomicSync } from "./fsAtomic.js";
import type { HostEventListener } from "./hostEventBus.js";
import type { TrellisProvider } from "./mcpRuntime.js";

/** Manifest location relative to the home directory — canonical, not
 * user-home-adjacent: extension declarations are canonical content. */
export const EXTENSIONS_MANIFEST_REL = join(".trellis", "mcp", "extensions.yaml");

export function extensionsManifestPath(homeDir: string): string {
  return join(homeDir, EXTENSIONS_MANIFEST_REL);
}

export interface HostExtensionEntry {
  id: string;
  /** Module specifier for dynamic import — an absolute path or a file:
   * URL is the reliable form; bare specifiers resolve by Node's rules
   * from the trellis package itself. */
  load: string;
}

/** What an extension's `activate` receives. Metadata only — the extension
 * never gets the bus or registry itself; it RETURNS providers and
 * subscribers and the host wires them through the same registration
 * surface as everything else. */
export interface HostExtensionContext {
  homeDir: string;
  agent: AgentId;
  workspaceRoot: string | null;
}

export interface HostExtensionActivation {
  providers?: TrellisProvider[];
  subscribers?: HostEventListener[];
}

export type HostExtensionFailureStage = "manifest" | "invalid" | "import" | "activate";

export interface HostExtensionFailure {
  /** The manifest entry id, or the manifest itself when it could not be
   * read as an extension list at all. */
  id: string;
  stage: HostExtensionFailureStage;
  message: string;
}

export interface LoadedHostExtensions {
  providers: TrellisProvider[];
  subscribers: HostEventListener[];
  failures: HostExtensionFailure[];
}

interface ExtensionsYaml {
  extensions?: unknown;
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal structural check for one provider handed back by an
 * extension: it must at least be able to answer a call. */
function isProviderShape(value: unknown): value is TrellisProvider {
  return (
    typeof value === "object" && value !== null &&
    typeof (value as TrellisProvider).id === "string" &&
    typeof (value as TrellisProvider).callTool === "function"
  );
}

function isSubscriberShape(value: unknown): value is HostEventListener {
  return typeof value === "function";
}

/**
 * Load every extension the canonical manifest declares. Never throws:
 * the worst case is a `failures` entry per broken extension.
 */
export async function loadHostExtensions(
  context: HostExtensionContext,
  warn: (message: string) => void = console.error,
): Promise<LoadedHostExtensions> {
  const providers: TrellisProvider[] = [];
  const subscribers: HostEventListener[] = [];
  const failures: HostExtensionFailure[] = [];
  const report = (failure: HostExtensionFailure): void => {
    failures.push(failure);
    warn(`trellis-mcp-gateway: extension "${failure.id}" failed (${failure.stage}): ${failure.message}`);
  };

  const manifestPath = extensionsManifestPath(context.homeDir);
  if (!existsSync(manifestPath)) {
    return { providers, subscribers, failures };
  }

  let parsed: ExtensionsYaml;
  try {
    parsed = (parseYaml(readFileSync(manifestPath, "utf-8")) ?? {}) as ExtensionsYaml;
  } catch (err) {
    report({ id: "<manifest>", stage: "manifest", message: failureMessage(err) });
    return { providers, subscribers, failures };
  }

  const rawEntries = parsed.extensions;
  if (rawEntries === undefined || rawEntries === null) {
    return { providers, subscribers, failures };
  }
  if (!Array.isArray(rawEntries)) {
    report({ id: "<manifest>", stage: "manifest", message: "extensions must be a list of {id, load} entries" });
    return { providers, subscribers, failures };
  }

  for (const raw of rawEntries) {
    const entry = raw as Partial<HostExtensionEntry> | null;
    if (
      typeof entry !== "object" || entry === null ||
      typeof entry.id !== "string" || entry.id === "" ||
      typeof entry.load !== "string" || entry.load === ""
    ) {
      report({ id: "<manifest>", stage: "invalid", message: `entry is not a {id, load} pair: ${JSON.stringify(raw)}` });
      continue;
    }

    let mod: Record<string, unknown>;
    try {
      mod = await import(entry.load) as Record<string, unknown>;
    } catch (err) {
      report({ id: entry.id, stage: "import", message: failureMessage(err) });
      continue;
    }
    if (typeof mod.activate !== "function") {
      report({ id: entry.id, stage: "invalid", message: "module does not export an activate function" });
      continue;
    }

    let activation: HostExtensionActivation;
    try {
      activation = (await (mod.activate as (ctx: HostExtensionContext) => HostExtensionActivation | Promise<HostExtensionActivation>)(context)) ?? {};
    } catch (err) {
      report({ id: entry.id, stage: "activate", message: failureMessage(err) });
      continue;
    }
    if (typeof activation !== "object") {
      report({ id: entry.id, stage: "invalid", message: "activate did not return an object" });
      continue;
    }

    const returnedProviders = Array.isArray(activation.providers) ? activation.providers : [];
    for (const provider of returnedProviders) {
      if (isProviderShape(provider)) {
        providers.push(provider);
      } else {
        report({ id: entry.id, stage: "invalid", message: "activation.providers contains a non-provider entry" });
      }
    }
    const returnedSubscribers = Array.isArray(activation.subscribers) ? activation.subscribers : [];
    for (const subscriber of returnedSubscribers) {
      if (isSubscriberShape(subscriber)) {
        subscribers.push(subscriber);
      } else {
        report({ id: entry.id, stage: "invalid", message: "activation.subscribers contains a non-function entry" });
      }
    }
  }

  return { providers, subscribers, failures };
}

// ---------- 清单写入(声明面的唯一写路径) ----------

/**
 * 写入(或原位更新)一条清单条目;幂等——同 id 旧条目被替换,其余条目
 * 与未知键原样保留。清单是 canonical 内容,写入是显式管理动作(进化
 * 启用命令 8.1),loader 侧永不写。
 */
export function upsertExtensionEntry(homeDir: string, entry: HostExtensionEntry): void {
  if (typeof entry.id !== "string" || entry.id === "" || typeof entry.load !== "string" || entry.load === "") {
    throw new Error(`extensions.yaml: entry must be a non-empty {id, load} pair, got ${JSON.stringify(entry)}`);
  }
  const manifestPath = extensionsManifestPath(homeDir);
  let parsed: Record<string, unknown> = {};
  if (existsSync(manifestPath)) {
    const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("extensions.yaml: top level must be a mapping with an `extensions` list");
      }
      parsed = raw as Record<string, unknown>;
    }
  }
  const existing = parsed.extensions;
  if (existing !== undefined && !Array.isArray(existing)) {
    // 非数组的 extensions 键是手误产物:抛错而不是静默重置,避免
    // 其余条目无声丢失。
    throw new Error("extensions.yaml: `extensions` must be a list of {id, load} entries");
  }
  const entries = (existing ?? []) as unknown[];
  const next: unknown[] = [];
  let replaced = false;
  for (const raw of entries) {
    const candidate = raw as Partial<HostExtensionEntry> | null;
    if (candidate !== null && typeof candidate === "object" && candidate.id === entry.id) {
      next.push({ id: entry.id, load: entry.load });
      replaced = true;
    } else {
      next.push(raw);
    }
  }
  if (!replaced) next.push({ id: entry.id, load: entry.load });
  parsed.extensions = next;
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileAtomicSync(manifestPath, stringifyYaml(parsed));
}

/**
 * 移除一条清单条目;不存在时是无副作用的 no-op(返回 false)。不清空
 * 文件、不动其他条目——清单还可能声明别的扩展。
 */
export function removeExtensionEntry(homeDir: string, id: string): boolean {
  const manifestPath = extensionsManifestPath(homeDir);
  if (!existsSync(manifestPath)) return false;
  const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return false;
  const parsed = raw as Record<string, unknown>;
  const existing = Array.isArray(parsed.extensions) ? (parsed.extensions as unknown[]) : [];
  const next = existing.filter((item) => {
    const candidate = item as Partial<HostExtensionEntry> | null;
    return !(candidate !== null && typeof candidate === "object" && candidate.id === id);
  });
  if (next.length === existing.length) return false;
  parsed.extensions = next;
  writeFileAtomicSync(manifestPath, stringifyYaml(parsed));
  return true;
}
