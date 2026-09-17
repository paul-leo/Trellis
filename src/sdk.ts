/**
 * `agent-trellis`'s public, read-only API surface (trellis-sdk-p5) — a
 * stable contract for reading `~/.trellis/`'s canonical state without
 * depending on the CLI. Deliberately narrow (design.md D1): everything
 * here is canonical-source loading and its type surface, nothing from
 * `src/adapters/*` or `src/commands/*` — those are how the four
 * built-in integrations work, not something a third-party integration
 * should reach into. A third party wanting Trellis-style sync for its
 * own agent writes its own adapter against these types, the same way
 * `src/adapters/pi.ts` does today.
 */

export { loadCanonicalSource } from "./core/canonical.js";
export { ALL_AGENTS, resolveScope } from "./core/types.js";
export type {
  AgentId,
  AgentProfile,
  CapabilityDelivery,
  CanonicalSource,
  HubConfig,
  McpConfig,
  McpRuntimeConfig,
  McpServerDef,
  MemoryEntry,
  Scope,
  SecretsPolicy,
  SkillRef,
  Transport,
} from "./core/types.js";
