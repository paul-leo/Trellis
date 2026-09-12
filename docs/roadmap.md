# Roadmap

Each phase must ship with a `trellis doctor` check that verifies its own
claim — no phase is "done" on the strength of a config file existing, only
on the strength of a passing verification against the real running agent.

See [`implementation-plan.md`](implementation-plan.md) for P1–P4 broken down
to file/function level.

**P0 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-doctor-p0/`;
living spec at `openspec/specs/agent-state-probing/` and
`openspec/specs/capability-drift-detection/`). Verified against this real
machine, not just fixtures: independently rediscovered the already-fixed
Codex `openspec-*` duplication as clean, found a real, previously-unknown
MCP name collision (`sentry` statically configured on Claude Code and Kiro
while also being a `known_host_injected` name), and found a real wrong-case
skill file (`e2e-test`). `trellis doctor` (no flags) does none of this by
spawning anything — MCP handshake probing is opt-in via `--probe-mcp`
(see `docs/architecture.md`), added after a real run showed the default
had a much larger blast radius than "read-only" should mean.

This is the format every later phase uses: one `openspec/changes/<phase>/`
directory per phase, `openspec new change <name>` → tasks implemented →
`openspec archive <name>`. `implementation-plan.md`'s P0/P1 sections are
kept only as historical notes; don't edit them further.

**P1 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-sync-p1/`;
living spec at `openspec/specs/canonical-source-loading/` and
`openspec/specs/skill-instructions-sync/`). Covers all four agents,
including pi — a corrected assumption found while starting this change
(pi previously assumed to need "no adapter"; it needs the same symlink
treatment as the other three once its real global directory,
`~/.pi/agent/skills`, was confirmed in P0). Verified against a scratch
`$HOME` and `scripts/sandbox.sh`'s real container, never this developer's
actual dotfiles. The acceptance pass itself caught two real bugs before
they'd have shipped: a removal check that used `realpathSync` and
silently never fired on a symlink whose canonical target had just been
deleted (exactly the case it existed to catch — broken symlinks throw on
realpath), and a plural/singular string mismatch between the CLI's
`target` option and `AdapterPlanItem.kind` that made `trellis sync skills`
silently apply nothing while reporting "already in sync." Both were only
found because the sandbox was actually run end-to-end, not just unit
tests of the pieces — see docs/architecture.md's testing philosophy.

**P2 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-mcp-sync-p2/`;
living spec at `openspec/specs/mcp-server-sync/`). `trellis mcp sync`
covers create/repair only — automatic removal is deliberately deferred: a
symlink's realpath proves Trellis ownership for skills, but a bare TOML/
JSON key has no equivalent marker, so "gone from canonical" and "the user
configured this directly" are indistinguishable without a `trellis.lock.json`
ownership-tracking mechanism that doesn't exist yet. Two write mechanisms
were chosen only after empirically ruling out the obvious ones first: both
`@iarna/toml` and `smol-toml` silently drop comments and reformat arrays on
a bare parse→stringify round-trip (so Codex's `config.toml` is patched by a
hand-rolled, purpose-built line-based section locator/splicer,
`src/lib/tomlSection.ts`, never a general parser), and `codex mcp add
--env` only accepts literal `KEY=VALUE` with no bare-name form (so it's
never shelled out to for the general write path — writing a real secret
value into a config file is the exact thing the secrets policy forbids).
Claude Code and Kiro use a plain JSON parse/merge/stringify, safe because
JSON has no comments to lose. The sandbox acceptance pass caught a real
bug unit tests alone hadn't: a comment block immediately introducing the
*next* `[header]` was being swallowed into the *previous* section's range,
so updating that previous section would have silently deleted an
unrelated comment — see docs/architecture.md's testing philosophy for why
this project always runs the real container, not just fixtures in memory.

**P3 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-secrets-audit-p3/`;
living spec at `openspec/specs/secrets-audit/`). `trellis secrets audit`
reads each present MCP-capable agent's real, on-disk config (never
canonical) and runs two independent checks: a whole-file scan against
`secrets.policy.yaml`'s `reject_patterns`, and a check of every declared
environment-variable *name* against `allowed_vars`. The second check
exists because a value-only scan structurally cannot catch the first real
incident on record — a GitLab PAT stored under the *wrong variable name*
was still a well-formed `${VAR}` reference, just the wrong name. Env-var-
name extraction stays dependency-free and format-narrow (real `JSON.parse`
for Claude Code/Kiro; a five-line regex over the one `env_vars = [...]`
line shape for Codex) rather than reusing P2's write-path
`tomlSection.ts` or adding a TOML library for reads — a deliberate,
separately-reasoned choice, not an oversight (P2's D2 rejected TOML
libraries specifically for round-trip fidelity on *writes*; that concern
doesn't apply to a read-only linter, but a full parser is still more than
this one narrow extraction needs). Both real incidents on record were
reproduced and caught live in the sandbox, not just in unit tests.

**P4 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-pi-mcp-bridge-p4/`;
living spec at `openspec/specs/pi-mcp-bridge/`). pi's MCP access is a
single symlinked extension (`~/.pi/agent/extensions/trellis-mcp-bridge.js`),
not a settings.json entry — found by reading pi's own extension-loader
source directly (same technique as P0's D5): `~/.pi/agent/extensions/`
is auto-discovered on every startup, including symlinks, with zero
configuration. The genuinely hard problem, found only by actually running
the real `pi` binary against the real symlink in a dedicated sandbox
(`docker/pi-sandbox.Dockerfile`) rather than trusting the design on paper:
a symlinked file's own bare-specifier imports (`@modelcontextprotocol/sdk`,
`typebox`) resolve relative to the *symlink's own path*, not its
target — the reverse of the initial assumption — so no dependency
declared in Trellis's own `package.json` could ever make an unbundled
bridge file resolve once placed in an arbitrary user's home directory.
Fixed by bundling the whole bridge into one dependency-free
`dist/pi-bridge/bundle.js` via `esbuild`, confirmed by re-running the
same sandbox check: the bridge loaded cleanly (no more "Failed to load
extension"), reaching pi's own unrelated "no API key configured" failure
instead — proof positive without ever spending a real model call.

**P5 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-sdk-p5/`;
living spec at `openspec/specs/trellis-sdk/`). `agent-trellis` now has a
real `"exports"` map: `import { loadCanonicalSource } from "agent-trellis"`
resolves without touching the CLI at all. Deliberately narrow (a curated
`src/sdk.ts` barrel — canonical-source loading and its types only, never
`src/adapters/*`/`src/commands/*`) and deliberately one package, not a
separately-published `@trellis/sdk` — the roadmap's naming was a working
label, not a monorepo commitment, and there is no second consumer yet to
justify that cost. Verified with a real package-resolution check
(`scripts/verify-sdk-export.sh`: pack the actual tarball, install it into
a throwaway scratch project, import via the bare `"agent-trellis"`
specifier), not just a source-relative `tsx` import — the two use
different resolution algorithms, and only the former would have caught an
`"exports"` map that looked right but didn't actually resolve for a real
consumer.

| Phase | Deliverable | Depends on |
|---|---|---|
| P0 | ✅ `trellis doctor` — read-only, opt-in-for-handshakes scan of all four agents' current skills/MCP/instructions state, reports drift and duplicates | nothing |
| P1 | ✅ `trellis sync skills` / `trellis sync instructions` — symlink-based distribution to Claude Code, Codex, Kiro, and pi | P0 |
| P2 | ✅ `trellis mcp sync` — incremental, in-place adapters for Claude Code (JSON merge), Codex (TOML section patch), Kiro (JSON merge); collision check against known host-injected server names | P1 |
| P3 | ✅ `trellis secrets audit` — scans every adapter's output for literal credential patterns and unexpected env var names, fails non-zero on any hit | P2 |
| P4 | ✅ pi bridge extension — MCP tool registration via `registerTool`, sourced from the same `mcp/servers.yaml` | P2 |
| P5 | ✅ `@trellis/sdk` — read-only API over the canonical source, for third-party agents to consume without depending on the CLI | P1–P4 stable |
| P6 | Memory: document and wire the `server-memory` default; write the mem0/OpenMemory upgrade guide | P2 |
| P7 | GUI: evaluate embedding into mcp-router's or skills-hub's existing interface before building anything new | P3–P6 |

No dates. This is scoped by verification milestones, not calendar time.
