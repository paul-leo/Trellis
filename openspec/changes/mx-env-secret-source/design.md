# Design

## Context

`resolveSecretEnv` (`src/lib/secretEnv.ts`) is today a five-line sync function: `env_file` set → sole source; else ambient `process.env`. Consumers: the pi bridge's stdio spawn, `resolveMcpPlan`'s pre-write resolvability check, `trellis secrets audit`, plus OAuth/workspace helpers. Values on the seeded machine now live in mxenv's encrypted global store (`~/.mxenv/.env`, dotenvx) composed by the `@morphixai/mxenv-core` SDK (`loadConfigLayers` + `composeEnvironment(layers, options) → { environment, … }`, async). mxenv owns the `mxenv://<profile>/<KEY>` grammar (`packages/mxenv-core/src/refs.ts`, 1Password-style "value-free files" references) and exports it from the `@morphixai/mxenv-core` SDK entry (0.12.0 起；旧 scheme 形态在 0.12.x 被拒并给改用 `mxenv://` 指引). See proposal.md for the motivating breakage (dangling `env_file`).

## Goals / Non-Goals

**Goals:**
- One resolution mechanism stays true: every consumer keeps calling `resolveSecretEnv`, now async and reference-aware.
- References give wiring files (`servers.yaml`) value-free, machine-independent provenance: composed at consumption, never shadowed by ambient env.
- Bare names keep byte-identical semantics (spec'd `env_file` sole-source rule preserved).
- One grammar owner: `@morphixai/mxenv-core` exports its reference API; Trellis consumes it.

**Non-Goals:**
- Changing how native-client agents resolve `${VAR}` in their own processes (name-based; covered by mxenv terminal injection/shims).
- Replacing `env_file` with an mxenv-backed plaintext mirror; project-scoped composition (v1 composes the global/default scope); reference-in-`headers`; secret rotation flows.

## Decisions

1. **Reference form in `env`/`envAliases` sources, delivered name = `KEY` segment.** `env: ["mxenv://legacy/MINIMAX_API_KEY"]` delivers `MINIMAX_API_KEY`. Alternative: policy-level `mx_env: true` provider for bare names only (rejected: loses per-key provenance and profile pinning; the reference form covers both, and the dangling-`env_file` fix is to remove the pointer, not add a parallel provider mode).
2. **`resolveSecretEnv` becomes async** rather than growing a parallel `resolveSecretEnvAsync`: composition is inherently async (provider subprocesses), a second entry point is exactly the "two consumers disagree" drift the spec forbids. Call sites (7 files) get mechanical `await` updates.
3. **References resolve via the `@morphixai/mxenv-core` SDK in-process** (imported library), not via spawning `mxenv` CLI: the SDK facade exists for embedders (morphix-env 0.8.0 起；Wave A 后随 `@morphixai/mxenv-core` 提供), avoids argv/process-table exposure, and keeps redaction tooling available (`redactionValues`).
4. **Composition scope = global/default (`cwd: homedir()`)**: MCP secrets are machine-global on the seeded use case; composing from a project cwd would make `servers.yaml` results depend on where `trellis` happened to run. The `<profile>` segment of the reference is passed through to composition options so a named profile can select layers where declared.
5. **`@morphixai/mxenv-core` 0.12.0 exports `refs.ts`** (`MxEnvReference`, `findMxEnvReferences`, `hasMxEnvReference`, `ReferenceResolver`, `ReferenceResolution`, `UnresolvedReference`) from the package entry (已随 Wave A 发布，2026-11-07 实测 dist 导出面齐全); Trellis depends on `@morphixai/mxenv-core: ^0.12.0` and treats malformed reference-shaped strings as errors via the exported parser's strict match.
6. **Strict whole-string matching**: an entry is a reference only if the entire entry matches `mxenv://<profile>/<KEY>`; embedded/malformed `mxenv://` text is an error finding (audit) / rejected input (bridge), never a silently-resolved bare name.（旧 scheme 由 SDK 解析器统一拒绝并给改用 `mxenv://` 的指引，不作 legacy 兼容。）

## Risks / Trade-offs

- [Async signature touches several call sites] → mechanical change, compile-driven; the spec's single-resolver rule is what keeps it safe.
- [SDK version coupling (Trellis → `@morphixai/mxenv-core`)] → narrow surface (composition + refs, semver-stable facade); pinned `^0.12.2` (the release carrying the implicit-default profile fix).
- [Composition cost per resolution batch] → compose once per `resolveSecretEnv` call batch (cache per call, not per name); MCP sync/audit paths resolve tens of names at most.
- [Reference resolution depends on `~/.mxenv/.env` being readable/decrypted] → same operational reality as the values themselves; failures surface as `undefined` + findings, matching the missing-name contract.

## Migration Plan

1. `@morphixai/mxenv-core` 0.12.0 (SDK 引用 API 导出) — 前置，已随 Wave A 三包发布完成（2026-11-07）。
2. Trellis: implement + test (unit + `scripts/sandbox.sh` fixture run), release `agent-trellis` 0.21.0.
3. This machine: remove `env_file` from `~/.trellis/secrets.policy.yaml`, migrate the `minimax` entry to the reference form, `trellis secrets audit` + `mcp sync` re-verify. Rollback: revert the YAML lines (names + ambient still work).

## Open Questions

（无——引用语法、交付名、组合范围、异步化均已定案；原生客户端 `${VAR}` 路径明确不改。）
