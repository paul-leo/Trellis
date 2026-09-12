# Implementation plan

Breaks `docs/roadmap.md`'s phases into concrete tasks. P0–P2 are specified at
file/function level since they're next. P3–P4 are specified at
module/decision level. P5–P7 stay at the roadmap's level of detail — planning
them further now would be speculative, since their shape depends on what P0–P4
actually reveal.

Every task below ends in something that can fail. If a task can't fail, it
isn't specified enough yet.

---

## P0 — `trellis doctor` (read-only scan, no canonical source required)

> **Superseded by `openspec/changes/trellis-doctor-p0/`.** The section below
> is kept as a historical note only — the authoritative proposal, design,
> specs, and tasks for P0 live there now. Don't edit this section further.

**Key simplification**: P0 does not require `.trellis/` to exist. It
cross-compares the four agents' *own current state* against each other and
flags drift/duplication directly — this is the exact manual process used
throughout `docs/research.md`'s investigation (symlink-vs-realpath checks,
MCP handshake probes, hash comparisons), now formalized into code instead of
one-off shell commands.

### 0.1 Shared probing library — `src/lib/`

- `src/lib/mcpProbe.ts`
  - `probeMcpServer(def: McpServerDef, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<McpProbeResult>`
  - Spawns the server, sends a JSON-RPC `initialize`, resolves on the first
    `id:1` response or process exit, whichever comes first. This is a direct
    port of the probe script used repeatedly by hand in this project's
    research — it needs to become a tested module, not stay a throwaway
    `/tmp/mcp-probe.mjs`.
  - Fails the task if: a known-good server (e.g. `@modelcontextprotocol/server-memory`)
    does not return `serverInfo` within the timeout in CI.

- `src/lib/fsIdentity.ts`
  - `isSymlinkTo(path: string, target: string): boolean`
  - `realpathDedupe(paths: string[]): Map<string /* realpath */, string[] /* original paths pointing there */>`
  - This directly encodes the Codex finding from `docs/research.md`: dedup
    must happen on realpath, not on path string or content hash alone
    (two physical copies with identical content are *not* the same thing to
    an agent's discovery logic — they show up as two entries).
  - Fails the task if: given two physical copies of the same skill directory
    (not symlinks), it correctly reports them as **not** deduplicated —
    inverse of what `isSymlinkTo` would report for an actual symlink pair.

- `src/lib/skillFile.ts`
  - `findSkillFile(dir: string): { path: string; caseCorrect: boolean } | null`
  - Case-sensitivity check is explicit and reported, not silently corrected —
    this is the exact bug (`skill.md` vs `SKILL.md`) found and fixed by hand
    in this project's own history.

### 0.2 Per-agent probes — `src/probes/`

Each file implements `probe(): Promise<AgentSnapshot>` where
`AgentSnapshot` is a new type (add to `src/core/types.ts`):

```ts
interface AgentSnapshot {
  agent: "claude-code" | "codex" | "kiro" | "pi";
  present: boolean;
  version?: string;
  skillRoots: { path: string; isSymlink: boolean; target?: string; skillCount: number }[];
  mcpServers: { name: string; source: "static-config" | "runtime-injected"; probe?: McpProbeResult }[];
  instructionsFile?: { path: string; isSymlink: boolean; target?: string };
  subagentsDir?: { path: string; isSymlink: boolean; count: number };
}
```

- `src/probes/claude-code.ts` — reads `~/.claude.json` (`mcpServers` key),
  `~/.claude/skills`, `~/.claude/agents`, `~/.claude/CLAUDE.md`. Best-understood
  agent; build this one first to validate the `AgentSnapshot` shape before
  committing to it for the other three.

- `src/probes/codex.ts` — shells out to `codex mcp list` rather than
  hand-parsing `config.toml` (TOML section patching in P2 will need real
  parsing, but P0 is read-only and `codex` already exposes this). Skill root
  is `~/.agents/skills` per Codex's own convention (confirmed in
  `docs/research.md`) — the probe should also check whether `~/.codex/skills`
  independently contains any *non-symlink* skill directories, since that's
  exactly the duplication bug already found and fixed once in this
  environment and is exactly the kind of regression `doctor` exists to catch.

- `src/probes/kiro.ts` — same shape as Claude Code:
  `~/.kiro/settings/mcp.json`, `~/.kiro/skills`, `~/.kiro/steering/CLAUDE.md`.

- `src/probes/pi.ts` — **has an open unknown, resolve it first**: pi's skill
  discovery path was never pinned down by direct observation in this
  project's research (only confirmed pi *reads* `SKILL.md`-format files and
  `AGENTS.md`/`CLAUDE.md`; the actual discovery directory wasn't isolated
  from the minified bundle). Before writing this probe:
  1. Run `pi --skill <path>` against a known skill dir and confirm it loads
     (`pi -p "what skills do you have"` or similar, non-interactively).
  2. Check `pi config` (interactive TUI) for any skill-path setting, and
     check `~/.pi/agent/settings.json` again after that interaction — the
     settings file only had four keys when checked during research; a skill
     path may be set here that wasn't visible before because nothing had
     configured one yet.
  3. If no fixed discovery directory exists (i.e. skills are strictly
     `--skill`-flag-only, per-invocation), document that as a real
     constraint — the pi adapter in P4 would then need to inject the flag
     via a wrapper rather than write to a filesystem location, which changes
     P4's design meaningfully. **This determination gates P4's design, not
     just P0's probe — do it early.**

### 0.3 Command — `src/commands/doctor.ts`

- `runDoctor(opts: { json?: boolean }): Promise<{ exitCode: number }>`
- Calls all four probes in parallel (`Promise.allSettled` — one agent being
  absent or erroring must not blank out the other three's results).
- Cross-compares snapshots pairwise for:
  - Same skill name present with different realpaths across agents (drift)
  - Any skill root containing a non-symlinked physical copy where a symlink
    pattern is otherwise established for that agent (duplication risk)
  - MCP server names present in one agent's static config that also appear
    in `known_host_injected` for another — surfaces the exact class of bug
    documented in `docs/research.md` (Codex + mirasim same-name collision)
    *before* it causes a startup failure, not after.
- Human-readable output matches the table style already used throughout this
  project's manual investigations (✅/⚠️/❌ per row) — this isn't cosmetic,
  it's continuity with how these findings were actually communicated and
  understood during research.
- `--json` emits `AgentSnapshot[]` for P5's SDK and any future GUI to
  consume without re-parsing terminal output.
- Exit code is non-zero if any ⚠️/❌ finding exists. `doctor` is meant to be
  runnable in CI/pre-commit, not just read by a human.

### P0 acceptance

Run against *this* machine (which has known, already-diagnosed issues
documented in `docs/research.md`) and confirm `doctor` independently
rediscovers at least these three already-known findings without being told
where to look:
1. The Codex `openspec-*` skill duplication (already fixed — confirm it now
   reports clean).
2. Any current MCP server name collision against `known_host_injected`.
3. Any skill file with incorrect case (currently none — confirm it reports
   clean, and separately unit-test the detector against a synthetic
   `skill.md`).

If `doctor` can't independently reproduce findings that were previously only
found by hand, it isn't done — restating `docs/research.md`'s conclusions as
hardcoded checks doesn't count.

---

## P1 — `trellis sync skills` / `trellis sync instructions`

> **Done and archived** (`openspec/changes/archive/2026-09-12-trellis-sync-p1/`).
> Section kept as a historical note only — see `docs/roadmap.md` for the
> actual outcome and the two real bugs the acceptance pass caught. Don't
> edit this section further.

Depends on P0's `AgentSnapshot` to decide *what* needs syncing; this phase
adds the *write* path.

- `.trellis/` canonical source becomes real for the first time here — not
  before. `src/core/canonical.ts`: `loadCanonicalSource(): CanonicalSource`
  reads `~/.trellis/skills/*/SKILL.md`, `~/.trellis/agents/*.md`,
  `~/.trellis/agents.md`, `~/.trellis/scope.yaml`. **Global only** — see
  `docs/architecture.md` "Global vs. workspace scope". No `root` parameter,
  no workspace merge; don't build toward the `.agents Protocol` draft's
  global+workspace precedence model until that's an explicit decision, not
  a default carried over from the draft.
- `src/adapters/claude-code.ts`, `src/adapters/codex.ts`, `src/adapters/kiro.ts`,
  `src/adapters/pi.ts` each implement `TrellisAdapter` (`src/core/adapter.ts`)
  for skills + instructions only — MCP is P2/P4, deliberately kept out of
  this phase's scope. Pi's adapter is the same symlink shape as the other
  three (`~/.pi/agent/skills`, `~/.pi/agent/AGENTS.md` — confirmed real,
  persistent paths per design.md D5 in the archived P0 change; see
  docs/architecture.md's corrected pi adapter notes) — P4 is only pi's MCP
  bridge, not its skills/instructions, which need nothing more than what
  every other agent here needs.
  `plan()` filters skills/subagent profiles through `isInScope` before
  producing any plan item — a skill scoped away from that adapter's `id`
  must produce zero plan items for it, not a plan item that apply() later
  skips. `apply()` handles three cases, not just creation:
  - **create/repair**: no symlink, or a symlink pointing at the wrong
    target — safe to (re)write.
  - **remove**: an agent's skill directory has a Trellis-managed symlink
    (its realpath resolves inside the canonical `skills/` root) whose
    corresponding skill either no longer exists in canonical or was just
    scoped away from this agent — this is the "delete" half of "add once,
    remove once, reaches every agent," and it's easy to build only the
    create path and quietly never finish this half.
  - **refuse**: the path exists as a *real* directory, not a symlink at
    all — this is not Trellis's to touch. Surface it as a conflict and
    stop; never delete something that might be a user's own content just
    because its name matches a skill Trellis also knows about.

  The realpath check in the remove case is not optional: it's what makes
  removal safe. Only ever delete a symlink Trellis can prove it created
  (points inside the canonical source), never a same-named real directory.
- `verify()` re-runs the relevant P0 probe and diffs against canonical —
  this is why P0's probes are written as reusable functions, not
  doctor-command-only logic.

### P1 acceptance

Point at a scratch `$HOME` (or a container) with none of the four agents'
skill directories populated, run `trellis sync skills`, then run `trellis
doctor` and confirm zero findings. Then manually corrupt one symlink
(point it somewhere wrong) and confirm `doctor` catches it before re-running
sync to confirm `apply()` repairs it idempotently. Separately: add one
skill scoped to `[claude-code]` only in `scope.yaml`, run `trellis sync
skills`, and confirm it appears only in Claude Code's skills directory —
not Codex's, Kiro's, or pi's.

---

## P2 — `trellis mcp sync`

> **Done and archived** (`openspec/changes/archive/2026-09-12-trellis-mcp-sync-p2/`).
> Section kept as a historical note only — see `docs/roadmap.md` for the
> actual outcome. Two corrections against this plan's own assumptions,
> found before/while implementing: neither `@iarna/toml` nor `smol-toml`
> survives a round-trip (both drop comments, reformat arrays) — Codex is
> patched by a hand-rolled line-based section locator/splicer instead
> (`src/lib/tomlSection.ts`), no library dependency at all; and automatic
> MCP removal turned out to be unsafe without an ownership marker a bare
> TOML/JSON key has no equivalent of (a symlink's realpath proves it for
> skills) — deferred until a lock-file mechanism exists, `plan()` only
> ever produces create/repair + conflict for MCP. Don't edit this section
> further.

The highest-risk phase — this is where `docs/research.md`'s hardest-won
constraint applies directly: **Codex's adapter must patch a TOML section in
place, never regenerate the whole file**, because Codex's own `config.toml`
holds settings Trellis has no business touching (models, trust levels), and
because mirasim writes to the same file independently.

- `src/adapters/codex.ts` (extended): needs a real TOML parser that
  preserves comments/formatting outside the touched section (`@iarna/toml`
  or `smol-toml` — evaluate both for round-trip fidelity before picking one;
  this is exactly the kind of "don't reinvent" call `docs/research.md`
  already commits to). Patch strategy: locate `[mcp_servers.<name>]` by
  section header, replace only that block, leave every byte outside it
  untouched.
- Collision check runs `known_host_injected` from `mcp/servers.yaml` against
  every server name about to be written; refuses to write and exits non-zero
  on collision, with the exact error class from `docs/research.md`
  (`url is not supported for stdio`) quoted in the failure message so a user
  hitting this via Trellis gets the real cause immediately instead of
  rediscovering it as a mysterious Codex crash.
- Every adapter's `plan()` filters servers through `isInScope` using each
  server's inline `agents:` field (not `scope.yaml` — see
  `docs/architecture.md` "Private / agent-specific capabilities" for why
  MCP scoping is inline) before generating anything for that agent.
- `src/adapters/claude-code.ts` / `kiro.ts` (extended): plain JSON deep-merge
  under `mcpServers`, values always emitted as `${VAR}` — never a literal,
  enforced by a check against `secrets.policy.yaml`'s `reject_patterns`
  *before* the write happens, not just audited after (P3 audits adapter
  *output*; this is a pre-write guard specific to the MCP adapter, cheaper
  to catch here than after the fact).
- **Hub mode branch** (`docs/architecture.md` "MCP hub mode"): every
  adapter checks `canonical.mcp.hub` first. If set, skip the whole
  N-server merge/patch logic above and instead ensure exactly one static
  entry (name TBD, e.g. `trellis-hub`) pointing at `hub.url` exists —
  Codex still patches in place, Claude/Kiro still JSON-merge, just one
  entry instead of N. The collision check still runs, just against that
  one name instead of every server name.

### P2 acceptance

Reproduce the exact Codex incident from `docs/research.md` in a sandboxed
`config.toml` (a stdio server statically defined, then a same-name `url`
server "injected" via `-c` the way mirasim does) and confirm Trellis's
collision check refuses the write *before* attempting it, rather than
letting Codex fail to start. Separately, with `hub.url` set in the fixture's
`servers.yaml`, confirm each agent's generated config contains exactly one
MCP entry regardless of how many servers are defined.

---

## P3 — `trellis secrets audit`

> **Done and archived** (`openspec/changes/archive/2026-09-12-trellis-secrets-audit-p3/`).
> Section kept as a historical note only — see `docs/roadmap.md` for the
> actual outcome. Built as planned, with no dependency added: env-var-name
> extraction turned out to need only real `JSON.parse` (Claude Code/Kiro)
> and a five-line regex over one TOML line shape (Codex), not a general
> parser or a reused write-path module. Don't edit this section further.

- `src/commands/secretsAudit.ts`: reads every adapter's *actual output file*
  (not the canonical source — the point is catching what actually landed on
  disk) and runs `secrets.policy.yaml`'s `reject_patterns` against it.
- Must catch, as regression tests, the two real incidents already on
  record: a GitLab PAT stored under the wrong variable name (this is a
  *naming* bug the pattern-match alone won't catch — audit also needs an
  "unexpected variable name" check against `allowed_vars`, not just a
  literal-value regex) and a literal token value embedded directly in a
  generated config (the regex case).

## P4 — pi MCP bridge extension

> **Done and archived** (`openspec/changes/archive/2026-09-12-trellis-pi-mcp-bridge-p4/`).
> Section kept as a historical note only — see `docs/roadmap.md` for the
> actual outcome. Built largely as sketched (a symlinked extension, no
> settings.json write, `registerTool` per MCP tool), but the delivered
> file had to become a fully bundled, dependency-free build output
> (`dist/pi-bridge/bundle.js` via `esbuild`) rather than raw TypeScript
> source — a real sandbox run against the actual `pi` binary showed a
> symlinked file's own imports resolve relative to the symlink's path,
> not its target, so an unbundled file could never resolve its
> dependencies once placed in a real user's home directory. Don't edit
> this section further.

**MCP only** — pi's skills/instructions adapter is P1's `src/adapters/pi.ts`
(same symlink shape as every other agent, see P1 above); P4 is exclusively
the MCP bridge, since pi has no native MCP client at all (docs/research.md).

§0.2's investigation resolved during P0 (design.md D5 in the archived
`trellis-doctor-p0` change): pi has a real discovery directory
(`~/.pi/agent/skills`), settling which of the two candidate shapes below
applies — the first one:

- A pi extension package, installed once, that on startup reads
  `.trellis/mcp/servers.yaml`. If `mcp.hub` is unset, it opens an
  `@modelcontextprotocol/sdk` `StdioClientTransport` per server and calls
  pi's `registerTool` for each tool the server reports; if `mcp.hub.url` is
  set, it instead opens a single `StreamableHTTPClientTransport` to that
  URL — one connection instead of N processes to keep alive, see
  `docs/architecture.md` "MCP hub mode".

This is the one adapter that is genuine runtime code, not a config
generator — budget real testing time against a live pi session, not just
unit tests of the bridging logic in isolation.

---

## Sequencing note

Build order: **Claude Code → Codex → Kiro → pi**, in that order, for every
phase through P4. Claude Code and Codex are already the best-understood
(most of `docs/research.md`'s hard-won findings are about them); Kiro is
structurally identical to Claude Code and should be fast once that shape is
validated; pi is last because it has the one open unknown (§0.2) and the one
genuinely novel engineering problem (§P4).
