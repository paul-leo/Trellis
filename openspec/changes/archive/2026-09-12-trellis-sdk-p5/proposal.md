# trellis-sdk-p5

## Why

Every capability P0-P4 built lives entirely inside `agent-trellis`'s CLI
(`dist/cli.js`, the package's only current entry point — no `"exports"`
field, no library-usable path at all). A third-party agent integration
that wants to read canonical Trellis state today has exactly one option:
shell out to `trellis doctor --json` and parse stdout. The roadmap's own
P5 goal — "read-only API over the canonical source, for third-party
agents to consume without depending on the CLI" — makes `loadCanonicalSource()`
and its supporting types a real, stable, importable surface instead of an
internal implementation detail nothing outside `src/commands/*.ts` is
meant to touch.

## What Changes

- `src/sdk.ts`: a curated barrel re-exporting exactly `loadCanonicalSource`
  and the canonical-source type surface (`CanonicalSource`, `SkillRef`,
  `AgentProfile`, `MemoryEntry`, `McpConfig`, `McpServerDef`, `HubConfig`,
  `SecretsPolicy`, `AgentId`, `Scope`, `ALL_AGENTS`, `resolveScope`) —
  nothing from `src/adapters/*` or `src/commands/*`, which remain the
  CLI's own private implementation (see design.md D1 for what's
  deliberately excluded and why).
- `package.json`: adds an `"exports"` map so `import { loadCanonicalSource }
  from "agent-trellis"` resolves to this barrel, alongside the existing
  `"bin"` entry — the same package serves both uses, not a second
  published package.

## Capabilities

- **New**: `trellis-sdk` — a stable, documented, read-only import surface
  over `~/.trellis/`'s canonical state, usable by any Node program without
  shelling out to the CLI.

## Impact

No new dependency. No behavior change to the CLI itself — this only adds
a second way to reach code that already exists and is already tested.
