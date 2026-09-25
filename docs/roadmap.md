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
covers create/repair and, after the ownership-ledger parity follow-up,
ownership-safe removal: a bare TOML/JSON key is removable only when the
ledger proves Trellis still owns the exact rendered entry. A hand-edited entry
is preserved. Two write mechanisms
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

**P6 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-memory-p6/`;
living spec at `openspec/specs/memory-defaults/`). `@modelcontextprotocol/server-memory`
is the documented default (`schema/servers.example.yaml`), confirmed by
the user over `totalrecallai` — a real, third-party memory server found
statically configured on this machine's Kiro install only (Claude
Code/Codex had none at all). No new adapter code: an unscoped `memory`
entry reaches all three native-config agents via P2's existing pipeline
and pi via P4's bridge, verified end-to-end in the real sandbox with the
actual `@modelcontextprotocol/server-memory` package name (never
spawned — `mcp sync` only writes config). One real wrinkle corrected
along the way: the schema example already lists `memory` under
`known_host_injected` (a genuine, empirically-grounded P0 finding about
mirasim's own runtime injection, not a stale guess), so the new default
entry ships commented out with guidance on which of the two situations
applies, rather than shipping an example that self-collides with
Trellis's own guard. Deliberately out of scope: auto-ingesting
`~/.trellis/memories/*.md` content into the running memory server's
store — a real, separate problem left as an open question, not silently
resolved.

**P7 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-secrets-env-management-p7/`;
living specs at `openspec/specs/secret-env-resolution/`, plus
modifications to `pi-mcp-bridge` and `secrets-audit`). Two real gaps
found testing the pi bridge against this real machine, not assumed: (1)
`secrets audit` only ever checked declared env var *names* against an
allow-list, never whether a name actually resolves to a value — a
machine migration could carry every name across while every value stayed
unset, silently, until some agent's tool call 401'd; (2) the pi bridge's
`connectStdio` already read real secret values (unavoidable — it's
Trellis's own code spawning the MCP subprocess, unlike Claude Code/
Codex/Kiro's own native clients resolving `${VAR}` in their own process),
but did so unconditionally from ambient `process.env` — every credential
the parent `pi` process's shell exported, not just the one or two names
the active server declared. Fixed with one shared, dependency-free
resolver (`src/lib/secretEnv.ts`) both the bridge and the audit call, and
one new optional `secrets.policy.yaml` field, `env_file`: when set, it's
the *sole* source for a declared name (no fallback to ambient — a silent
fallback would defeat the isolation this exists to offer), read via a
narrow hand-rolled `KEY=VALUE` parser, same "no new dependency" reasoning
as P3's `envVarNames.ts`. Verified with a real spawned MCP subprocess
(not a mock) reading back its own env by name
(`test/unit/piBridge.test.ts`), proving `env_file`'s value wins even when
ambient holds a different one — and separately in the real (non-pi)
Docker sandbox, `trellis secrets audit` correctly reporting
`missing-env-value` and exiting non-zero. Deliberately scoped down from
the original plan: no second `pi`-sandbox rebuild, since the bridge's own
unit test already exercises the exact changed code path with the same
rigor, and P4's own sandbox pass already covers the pi-extension-loading
surface this change never touches (tasks.md 5.1 records the reasoning,
not a silent skip). Honestly scoped non-goal, stated rather than
discovered later: `missing-env-value` is authoritative for pi, but only a
best-effort proxy for Claude Code/Codex/Kiro — those three resolve
`${VAR}` in their own process, which this audit cannot observe directly.

**P8 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-kiro-approved-env-vars/`;
living spec at `openspec/specs/kiro-env-var-approval/`). A real,
already-shipped correctness gap, found by reading Kiro's own installed
extension source directly
(`kiro.kiro-agent/dist/extension.js`'s `expandEnvironmentVariables`):
Kiro's `${VAR}` substitution is gated by a workspace/user setting,
`kiroAgent.mcpApprovedEnvVars` — a name absent from that list is
silently left as the literal, unresolved string, no error. On this real
machine that list was entirely empty, which is exactly why the one real
Kiro server needing a secret (`mcp-router`) held a literal token instead
of a `${VAR}` reference. Every Kiro MCP server Trellis had ever
generated with a `${VAR}` reference was, by default, silently broken —
P2 never knew this second gate existed. Fixed: the Kiro adapter now
also ensures every env name it references is present in
`kiroAgent.mcpApprovedEnvVars`, in Kiro's own global, VS-Code-style
`settings.json` (a different file from `~/.kiro/settings/mcp.json`,
shared with hundreds of unrelated editor preferences) — additive only,
parses the whole file and preserves every other key, refuses to touch a
file it can't parse. Verified in the real sandbox twice: a clean machine
gets the file created with exactly the needed name; an already-correct,
pre-seeded machine (including an unrelated key) produces zero writes and
comes out byte-identical. Deliberately narrow: only covers `env` names
(not the not-yet-built `headers` field), and only macOS's settings path
(Linux/Windows equivalents are the well-known convention but unverified
against a real install, stated as an open question).

**P9 is done and archived** (`openspec/changes/archive/2026-09-12-trellis-mcp-transport-auth/`;
living specs at modifications to `mcp-server-sync`, `pi-mcp-bridge`,
`secrets-audit`, and `kiro-env-var-approval`). `McpServerDef` gains
`headers?: Record<string,string>` (`${VAR}` references, same discipline
as `env`) and `Transport` gains `"sse"`; the dead `auth?: "oauth" |
"bearer-env"` field — never read anywhere in the codebase — is removed.
Four real, verified per-agent schemas (CLI `--help` output, Kiro's own
installed extension source, the MCP SDK's real `.d.ts`) converged on:
Claude Code and Kiro accept the identical plain headers map, rendered
verbatim; Codex has no generic headers concept at all, only a single
purpose-built `bearer_token_env_var` field (matching what its own `mcp
add --bearer-token-env-var` generates) — a server needing more than one
header is refused for Codex specifically (a real conflict, not a silent
drop or lossy approximation) while still reaching every other agent; the
pi bridge passes resolved headers into both `connectHttp` and a new
`connectSse` via the SDK's `requestInit.headers`. Real OAuth (browser
redirect, token refresh) is explicitly not built anywhere — all three
native-config agents already have their own working flow (`claude mcp
add --client-id`, `codex mcp login`, Kiro's own `oauth` schema fields);
pi has none and gains none here, a stated limitation. A cross-cutting
fix shipped alongside the feature rather than after: both P7's
`missing-env-value` check and P8's Kiro approved-env-vars list now see
names embedded in `headers` values too, via one shared
`declaredEnvNames` helper — shipping `headers` without teaching both of
them about it would have reproduced P8's own root cause for a new
field. Verified with a real, unmocked network test (a plain `node:http`
server capturing the bridge's actual outbound request headers) and in
the real Docker sandbox: both a bearer-token-shaped and a
two-header-shaped fixture server, confirming Claude Code/Kiro render
`headers` verbatim, Codex renders `bearer_token_env_var` or refuses with
the exact expected conflict message, and `secrets audit` catches a
headers-embedded name both on the canonical side and in a real,
already-written agent config file.

**Post-P9 hardening, done and archived**
(`openspec/changes/archive/2026-09-12-trellis-mcp-connect-timeout/`;
modifies `pi-mcp-bridge`). Found live, not hypothesized: a real, still-
published MCP server CLI (`@harness-fe/cli mcp`) that exits in under a
second with `stdio: "ignore"` but, spawned exactly the way a real stdio
MCP client must (a readable stdin pipe attached), never writes a byte
and never exits — indistinguishable from "still starting up" without a
bound. The pi bridge's `Promise.all` over every configured server had
no timeout on `client.connect()`, so one such server stalled the entire
extension load, plus every other configured server's tool registration
with it. Each of `connectStdio`/`connectHttp`/`connectSse` (and
`listTools()` after a successful connect) now races against a fixed
10-second timeout — the same constant `doctor --probe-mcp`'s
`mcpProbe.ts` already used independently, confirmed by reading it, not
assumed. Fixing this surfaced a second, real bug beyond the plan: a
timed-out `connectStdio` was leaking its spawned child process forever
(discovered when a test run took 12-19s instead of the expected ~300ms,
and confirmed by a live orphaned process still in `ps` after the test
exited) — every connect function now calls `transport.close()` on any
failure, timeout or otherwise, which for a stdio transport kills the
underlying process. Verified three ways: a dedicated hanging-server
fixture (two modes — silent from the first byte, and silent only after
a real `initialize` reply) proves the isolation and the process-leak
fix in the unit suite; the real Docker pi sandbox re-ran end to end
with the fix in place, hitting the exact timeout path for real (a
`memory` server's `npx` cold-start exceeding 10s), while two other,
differently-broken servers failed fast and pi still reached its own
unrelated "no API key" stage — proof nothing stalled. A pre-existing,
unrelated gap was found (not fixed here, out of this change's scope):
none of `sync skills`/`sync instructions`/`mcp sync`'s target filters
cover the bridge extension symlink's `kind: "extension"` — only bare
`trellis sync` delivers it.

**`pi-bridge-lifecycle`, done and archived**
(`openspec/changes/archive/2026-09-12-pi-bridge-lifecycle/`; modifies
`pi-mcp-bridge`). The bridge now owns the full lifecycle of every MCP
client it connects — a `clients: Set<Client>` tracked from a successful
`connectStdio`/`connectHttp`/`connectSse`, closed (idempotently, best-
effort) on pi's `session_shutdown` event or when `tools/list` fails
after connecting. Started as an open proposal carried forward from
earlier work with only 1 of 3 declared scenarios under test; closed out
here by adding the two missing ones — multiple connected servers are
*all* released on shutdown (not just the first), and calling shutdown
twice is a no-op on the second call, not an error or a double-close —
both verified against real spawned subprocesses, not mocks. The fourth
declared scenario ("a server that never connects is not cleaned
twice") needed no dedicated test: it's enforced by control flow, not a
runtime check — a failed connect never reaches `clients.add(client)`,
so it was never a candidate for cleanup in the first place, and
`trellis-mcp-connect-timeout`'s own tests already exercise that exact
failure path. Real pi-sandbox verification was judged already covered
by `trellis-mcp-connect-timeout`'s own Docker run, which exercised this
same session_shutdown/`closeAllClients` code path with no dedicated
second real-CLI run needed.

**`trellis-cli-init`, done and archived**
(`openspec/changes/archive/2026-09-12-trellis-cli-init/`; adds
`canonical-source-bootstrap`, modifies `capability-drift-detection`).
New `trellis init` command: creates `~/.trellis/agents.md`,
`mcp/servers.yaml` (`servers: {}`, `known_host_injected: []`), and
`secrets.policy.yaml` (`reject_patterns` read live from
`schema/secrets.policy.example.yaml`, not retyped) whenever they don't
already exist — per file, never overwriting real content — then prints
which of the four agents are present, each pointing at `trellis migrate
--from <agent>` (next). Turns `sync`/`mcp sync`/`secrets audit`'s
existing "no canonical source, create it" refusal into something an
actual command satisfies, closing a gap this session's own real pi
onboarding had to route around entirely by hand (`mkdir`, hand-copied
skills, hand-written `scope.yaml`). Found and fixed alongside it, not
separately: `doctor`'s collision check had been permanently stuck on a
hardcoded `DEFAULT_KNOWN_HOST_INJECTED` list since before canonical
source loading existed — `collectDoctorReport` already accepted an
override, but `src/cli.ts` never passed one, so `doctor` and `mcp
sync`'s own collision refusal (which does read canonical) could
disagree about what counts as a collision on any machine whose real
host-injected connectors differ from this project's own development
machine. `doctor` now resolves `known_host_injected` from canonical
when it exists, falling back to the hardcoded default only when it
doesn't (unchanged P0 behavior). Verified in the real Docker sandbox —
and that run caught a second real, unrelated bug of its own: neither
`docker/sandbox.Dockerfile` nor `docker/pi-sandbox.Dockerfile` copied
`schema/` into the image, so `init` crashed on `ENOENT` reading
`schema/secrets.policy.example.yaml` the first time it ran inside a
container — both Dockerfiles fixed, `package.json`'s own `files` array
also gained `schema` for the same underlying reason (the published npm
package didn't ship it either, and README already told users to read
it).

**`trellis-cli-migrate`, done and archived**
(`openspec/changes/archive/2026-09-12-trellis-cli-migrate/`; adds
`canonical-source-migration`). `trellis migrate --from <agent>`: probes
the named agent, then per real (non-symlinked, case-correct) skill and
per real instructions file, plans one of `create` (no canonical entry
yet), `already-migrated` (byte-identical to what's already in
canonical — `src/lib/dirEquals.ts`, a real recursive directory-content
comparison, not a name/mtime/hash shortcut), or `conflict` (differs —
reported, never overwritten). A symlinked or case-broken skill is
skipped and reported rather than migrated, since there's nothing real
of that agent's own to import. Canonical `agents.md` still at `trellis
init`'s placeholder is treated the same as "doesn't exist yet" so a
first real migrate always lands. No `scope.yaml` entry is ever written
— a migrated skill stays unscoped (visible to all agents), matching
`sync`'s own default. `--dry-run` computes and prints the same plan
with zero writes. This closes `trellis init`'s own per-agent pointer
message (`trellis migrate --from <agent>` — next), completing the
init → migrate → sync → mcp sync → secrets audit onboarding path for a
user who already has real content in one of the four agents. Verified
in the real Docker sandbox in the sequence a real user would actually
run it: `migrate --from claude-code` against the fixture home correctly
created a new canonical skill from claude-code's real content and
correctly conflicted on instructions (fixture's canonical `agents.md`
already has real content); a subsequent `trellis sync` in the same
container then correctly symlinked the newly migrated skill out to
kiro and pi (byte-identical content confirmed via `diff`), while
correctly reporting conflicts — not overwriting — on claude-code and
codex, since both already have their own real, non-canonical
`sample-skill` at that exact path.

**Agent auto-install scope decision, addendum to `trellis-cli-migrate`:**
`trellis init` prints each undetected agent's real, currently-correct
install command/URL (`npm install -g @anthropic-ai/claude-code`,
`npm install -g @openai/codex`, `npm install -g
@earendil-works/pi-coding-agent`, and `https://kiro.dev/downloads/`
for Kiro — a desktop IDE with no CLI package) — never spawns an
installer itself. A global package install or IDE download is exactly
the kind of system-wide, hard-to-reverse action this project's own
safety discipline requires an explicit human "yes" for, not a silent
side effect of running `trellis init`; a detect-and-print pointer
delivers "help me install the agents you support" without that risk.

**`trellis-cli-onboard`, done and archived**
(`openspec/changes/archive/2026-09-12-trellis-cli-onboard/`; adds
`onboarding-flow`). `trellis onboard` chains `init` → detect all four
agents (skill names/count, real-instructions presence — the exact
subset `migrate` can act on, nothing about MCP) → resolve a single base
agent → `migrate --from <base>` → `sync`, purely by calling each
command's own already-tested plan/apply functions — no new skill-copy,
symlink, or conflict-detection judgment exists in `onboard.ts` itself.
Base-agent resolution: zero present prints every agent's install
hint and stops (exit 0 — not a failure, a correct stopping point);
exactly one present auto-selects with no prompt; two or more resolve
via `--agent <id>` (the scriptable/sandbox/`--json` path) or an
interactive `node:readline/promises` prompt when stdin is a real
terminal, refusing cleanly with the present-agent list rather than
guessing when neither is available. `--json` never prompts even if
stdin happens to be a TTY, matching the same principle
`scripts/sandbox.sh` already uses for its own `-it`/`-i` branching.
Found and fixed alongside it: `trellis sync` itself had no dry-run
mode at all before this change (`collectSyncReport` always called
`adapter.apply()` unconditionally) — added as `RunSyncOptions.dryRun`,
independently useful on its own (`trellis sync --dry-run`) and a
prerequisite for `onboard --dry-run`'s own true-no-writes guarantee
across the whole chain. Verified in the real Docker sandbox: `trellis
onboard --agent claude-code` against the fixture home (which has
multiple present agents) produced the identical real result to running
`migrate --from claude-code` then `sync` by hand — same canonical
`sample-skill` created, same instructions conflict correctly reported
and left untouched, same real distribution of the migrated skill out
to kiro and pi.

**Merge mode — named future work, not a silent gap:** today, two or
more present agents with genuinely *different* real content still
resolves to "pick one as the base"; the others' own differing content
stays exactly as `migrate`/`sync` already report it (conflict,
untouched — never silently dropped or overwritten). Actually merging
differing skills/instructions from more than one agent into one
canonical result is real, separate design work (whose content wins per
file? per skill? does the user review a diff before it's written?) —
deliberately out of scope for `trellis-cli-onboard`, tracked here as an
explicit next step rather than something a user has to discover is
missing.

**Pre-release closed-loop audit, before first publish.** A full,
skeptical review of the whole new-user path — every command's usage
text against its real implementation, every doc claim against the
actual code, `package.json`'s shipped files against everything read at
runtime — found and fixed five real issues, none caught by the
existing test suite because each lived in code path or a doc claim
nothing exercised directly:
- `trellis sync --dry-run` was broken as a flags-first invocation:
  `src/cli.ts`'s target parsing only ever checked `rest[0]`, so a flag
  placed before a target (or with no target at all) was misread as an
  unknown target named e.g. `"--dry-run"`. Fixed by parsing the whole
  `rest` array for a recognized target instead of assuming position,
  and the parsing logic (`parseSyncArgs`) was pulled out into its own
  small, directly unit-tested function (`test/unit/cli.test.ts`) —
  `src/cli.ts` previously had zero direct test coverage of its own argv
  dispatch, which is exactly why a pure-parsing bug like this shipped
  unnoticed. Adding that test surfaced a second real issue: importing
  `cli.ts` for the pure function ran the whole CLI against the test
  runner's own argv as an unguarded side effect (`main(...)` had no
  entrypoint check) — fixed with the standard `import.meta.url ===
  file://${process.argv[1]}` guard.
- `sync --dry-run` was undocumented in `printUsage()`, `README.md`, and
  `docs/getting-started.md` despite being real and (once fixed) working
  — all three now document it.
- `onboard.ts` had its own, second copy of `migrate`'s and `sync`'s
  report-printing logic, and that copy was missing `migrate.ts`'s own
  "nothing to migrate" empty-plan case — a real gap for exactly the
  fresh-Claude-Code-install scenario this project's own new-user
  persona represents (config present, zero skills, no instructions
  file). Fixed by exporting and reusing `migrate.ts`'s `printPlan` and
  `sync.ts`'s `printReport` directly instead of a second copy that
  could silently drift.
- `package.json`'s `files` shipped `dist` and `schema` but not `docs` —
  every globally-installed user's local `README.md` (which *is*
  shipped) links to `docs/getting-started.md`, `docs/architecture.md`,
  and `docs/roadmap.md`, none of which existed on their machine. Same
  root cause `trellis-cli-init`'s own entry already fixed once for
  `schema/` — the fix pattern (add it to `files`) applied again here.
- `docs/architecture.md`'s canonical-schema diagram listed
  `trellis.lock.json` with no "not built yet" annotation, unlike every
  other not-yet-built thing described in the same document — annotated.

**A near-miss caught by re-running the real installed-tarball check, not
by the test suite:** the first fix for `parseSyncArgs`'s test coverage
gap put the pure function in `src/cli.ts` itself and guarded that
file's top-level `main()` call with `import.meta.url ===
file://${process.argv[1]}` so importing the function for a test
wouldn't run the whole CLI as a side effect. That guard is not
symlink-safe: npm's `bin` entry is a symlink, and a symlink's
`import.meta.url` (resolved) never equals its own symlink path
(`process.argv[1]`, unresolved) — so the real, installed `trellis`
binary silently did nothing and exited 0 on every invocation. `npm
test` stayed green throughout, because nothing in the unit suite runs
through an actual symlinked bin — only `scripts/verify-cli-install.sh`
does, and it caught this immediately on the very next run. Fixed
properly by moving `parseSyncArgs` to its own zero-side-effect module
(`src/lib/syncArgs.ts`) instead of trying to make the entrypoint guard
symlink-safe — the reminder here: a real installed-package check is
not a redundant formality alongside the unit suite, it's the only
thing in this project that exercises the actual `bin` symlink at all.

**`trellis-managed-agents`, done and archived**
(`openspec/changes/archive/2026-09-13-trellis-managed-agents/`; adds
`agent-management-scope`, modifies `onboarding-flow`,
`skill-instructions-sync`, `mcp-server-sync`, `secrets-audit`). Fixes a
real gap found using `onboard` for its first real migration (Claude Code
→ pi, on this project's own developer machine): `sync`/`mcp sync`/
`secrets audit` acted on **every present agent** unconditionally, with no
way to say "only manage these ones." New persisted state,
`~/.trellis/managed.yaml` — absent or `agents: []` both mean zero managed
agents, never "everyone" (a deliberate pre-1.0 default reversal, no
back-compat shim). `resolveScope`'s no-scope fallback changed from
`ALL_AGENTS` to the managed set, and an item's own explicit scope is now
intersected with it, never used verbatim — the managed set is the hard
outer boundary every other scoping decision lives inside.

`onboard` splits what used to be one "pick a base agent" choice into two
independent ones: a **migration source** (read-only, at most one, same
resolution rules as before) and a **managed set** (zero or more, written
to). The source is offered in the managed-set prompt but starts
unchecked by default — importing from Claude Code no longer implies
Trellis should also manage Claude Code. Selecting an agent that isn't
installed yet (e.g. pi) is itself the authorization to install it — one
confirmation, then a real `npm install -g <package>` (`src/lib/
installAgent.ts`), never silent even under `--manage`; Kiro has no CLI
package and is refused with its download URL instead. Re-running
`onboard`'s managed-set selection is a union with whatever was already
in `managed.yaml`, never a replacement — otherwise a later run adding
codex, forgetting to reselect pi out of habit, would silently unmanage
it. `~/.agents` (Codex's own `~/.ai-config`-sourced skill convention) is
now a directly tested non-goal rather than an incidental consequence of
the ownership-conflict fix below.

Found and fixed a second real bug in the same investigation, upstream of
this change's own scope but caught while diagnosing "did the first real
`onboard` run corrupt anything": `src/adapters/symlinkPlan.ts` treated
*any* existing symlink at a target path as safe to repair, without
checking whether its stored target was actually inside Trellis's own
canonical source. A real `onboard` run silently repointed
`~/.codex/instructions.md` and `~/.kiro/steering/CLAUDE.md` — both
previously symlinks into a separate, user-owned `~/.ai-config` setup —
at `~/.trellis/agents.md` instead, with zero warning. Fixed by checking
the existing symlink's raw `readlink` target against `canonicalRoot`
before treating it as repairable; anything pointing elsewhere is now a
`"conflict"`, left untouched, same as a real non-symlink file always
was. Verified against the real machine: the two symlinks were restored
by hand, the fix confirmed via `sync instructions --dry-run` reporting
conflicts instead of creates, and 194→197 tests passing throughout.

Verified in the real Docker sandbox: baseline `sync` with all four
fixture agents listed in `managed.yaml` reproduces the exact same output
this project's earlier sandbox runs documented (no regression), then a
narrowed `managed.yaml` (`agents: [pi]`) reproduces zero writes and zero
report lines for the other three, and a full `onboard --agent
claude-code --manage pi` run reproduces this session's own real
use case end to end — migrate from claude-code, manage only pi, source
left completely untouched.

Then run for real, once, on this project's own developer machine (not a
sandbox): `onboard --agent claude-code --manage pi` genuinely installed
pi (`npm install -g @earendil-works/pi-coding-agent`, real confirmation
prompt, real 132-package install), wrote `managed.yaml` as `agents:
[pi]`, re-ran `migrate --from claude-code` idempotently against already-
migrated canonical, and left claude-code, codex, and kiro completely
untouched — including confirming codex's and kiro's instructions files
are still real symlinks into the developer's own `~/.ai-config`, not
touched by this run. Surfaced one genuine, undocumented boundary in the
process: `sync`/`mcp sync` still reported pi as "not installed"
immediately after the install, because pi's own presence probe
(`src/probes/pi.ts`) checks for `~/.pi/agent/settings.json` or `~/.pi/
agent/skills` on disk — neither of which `npm install` creates. pi only
writes those itself on its own first real invocation (confirmed by
reading its installed source: `pi list` bootstraps `~/.pi/auth.json` and
`~/.pi/models-store.json`, but not the `agent/` subdirectory — that
appears to need pi's own first-time-setup flow, which is interactive and
out of scope for Trellis to force). This isn't a bug to patch around —
faking presence would violate this project's own "verify, don't assume"
principle — but it is a real onboarding-order gap worth documenting: run
the newly-installed agent once yourself before `trellis sync` can do
anything for it.

**`trellis-backup-rollback`, done and archived**
(`openspec/changes/archive/2026-09-13-trellis-backup-rollback/`; adds
`backup-and-rollback`, modifies `skill-instructions-sync`,
`mcp-server-sync`, `onboarding-flow`). Direct follow-up to
`trellis-managed-agents`' own real regression (a foreign symlink silently
repointed with zero warning): that fix made the *known* unsafe case a
`conflict` instead, but `mcp sync`'s native-config writes were never
provably safe the same way — `~/.claude.json`, `~/.codex/config.toml`,
and Kiro's two settings files are read, merged or TOML-section-patched,
and rewritten in place, and a bug in that merge/patch logic produces a
clean write with silently wrong output, not a `conflict` any existing
check would catch. Two earlier archived changes (`trellis-sync-p1`,
`trellis-mcp-sync-p2`) each waved at "rollback" by pointing at their own
create/remove mechanics; `mcp-sync-p2`'s story didn't actually hold —
automatic MCP server removal still isn't built, so there was no real
undo path for an `mcp sync` mistake besides hand-editing the file.

Every real write `sync`/`mcp sync` perform is now recorded, before it
happens, into a structured, timestamped run under `~/.trellis/backups/`
(new `src/lib/backup.ts`) — enough per operation to invert it exactly:
a file's prior bytes for an overwrite, a symlink's prior target for a
repair or removal, or just "this didn't exist before" for a create. The
write itself moved *into* the backup session (`session.writeFile`/
`createSymlink`/`repairSymlink`/`removeSymlink`) rather than the session
being an optional thing call sites remember to also invoke — the same
lesson `trellis-managed-agents`' symlinkPlan bug taught: a safety check
that's opt-in gets skipped eventually. `TrellisAdapter.apply()` gained a
mandatory `BackupSession` parameter across all four adapters; there is no
code path left that writes one of these files without going through it.

New `trellis rollback [<run-id>] [--list] [--dry-run] [--json]`: restores
one recorded run, but only where the current on-disk state still matches
what that run itself left behind — a path touched again since (another
sync, a hand edit) is a `conflict`, reported and left untouched, same
"verify, never guess" posture every other conflict in this project
already holds itself to. One path's conflict never blocks any other path
in the same rollback. `onboard` opens one session and shares it across
its whole chained `sync`+`mcp sync` run rather than one per stage, so a
single `trellis rollback` undoes an entire `onboard` invocation.
`migrate` is explicitly out of scope — it only ever creates a new
canonical entry or refuses on conflict, never overwrites existing
canonical content, so there's nothing real to lose there.

Verified in the real Docker sandbox against `test/fixtures/home`: a real
`mcp sync` run rewrote `.claude.json`/`.codex/config.toml`/
`.kiro/settings/mcp.json` with several new servers, `trellis rollback`
restored all three to their exact original bytes, confirmed byte-for-
byte; then a second run, followed by a hand-edit simulating something
else touching `.claude.json` after the fact, confirmed rollback reports
exactly that one path as a `conflict` (exit 1) while still correctly
restoring the other two, untouched, unaffected paths in the same
invocation.

**`trellis-mcp-static-env-and-disabled-servers`, implemented and
sandbox-verified** (modifies `mcp-server-sync`). Found by dogfooding
`mcp sync` against a real machine's actual, actively-used Codex
`config.toml` rather than a fixture: `[mcp_servers.supabase_db]` had
`enabled = false` (a definition kept on hand, deliberately off — no way
to represent that in canonical short of deleting it), and
`[mcp_servers.tanka]` used a hardcoded literal `env` table, not the
`env_vars` name-forwarding array every other real server on the same
machine uses. Migrating `tanka` as-is into the old names-only model
would have had `mcp sync` rewrite a working config into a broken one —
`TANKA_EMAIL`/`TANKA_ENV` were never real process env vars, just plain
values written straight into the file — and neither `mcp sync` nor
`secrets audit` would have caught it before the write happened.

`McpServerDef` gained `enabled?: boolean` (filtered in `resolveMcpPlan`
itself, the one choke point every adapter already funnels through — a
disabled server gets no write and no conflict, not just on Codex but on
every agent) and `staticEnv?: Record<string, string>` for a value that
was never a secret in the first place — Codex renders it as an adjacent
`[mcp_servers.<name>.env]` table (extending `tomlSection.ts`'s section
boundary logic to treat the pair as one atomic create/repair/remove
unit), Claude Code/Kiro merge it into the same `env` map their `${VAR}`
references already use. `resolveMcpPlan` also gained a mandatory fourth
`policy: SecretsPolicy` parameter: before writing any name-only `env`
entry, it now resolves it through the same `resolveSecretEnv` `secrets
audit`/the pi bridge already call, refusing (as a new conflict scoped to
just that server, on just that agent) a name that wouldn't actually
resolve — the exact silent-breakage scenario `tanka` would have hit.

The on-disk YAML key is `static_env` (snake_case, matching every other
multi-word key across `.trellis/*.yaml` — `known_host_injected`,
`allowed_vars` — translated to camelCase in `loadServersYaml`), a real
gap the design doc missed until implementation: `McpServerDef` had
always been parsed as-is with zero field translation, since every prior
field name happened to already be a single word.

Sandbox-verified, not just unit-tested: reproducing this machine's exact
`tanka`/`supabase-db` shapes in `test/fixtures/home` and running a real
`mcp sync` inside `scripts/sandbox.sh` produced Codex's two-table output
byte-for-byte identical to the real, working config this change was
motivated by — and surfaced one more real regression before it could
ship: the sandbox's own pre-existing fixture servers declare `env` names
that don't resolve inside the container, which the new pre-write check
would have refused outright. Fixed by exporting their fixture values in
`docker/entrypoint.sh`, matching what a real working setup would
actually have — found only because the fixture was actually run, not
just reasoned about.

Also removed a dead field from `schema/servers.example.yaml`: the
`figma` example's `auth: oauth` was never a real property on
`McpServerDef`, never read by any adapter, and never asserted by any
spec — the YAML parser has no field validation, so it silently did
nothing. No real OAuth support exists; the line taught a capability that
was never there.

**P11 is done and archived**
(`openspec/changes/archive/2026-09-13-trellis-migrate-category-selection/`;
modifies `canonical-source-migration` and `onboarding-flow`). `trellis
migrate --from <agent>` always planned skills and instructions
together, one unit, no subset selection — no CLI flag, and no
interactive picker for this choice either. `--only skills|instructions`
now restricts a run to just one category, filtered inside
`collectMigratePlan` itself (not computed then discarded) — the
excluded kind is never read for comparison and never appears in the
plan. `trellis onboard`'s migrate step gained a checkbox reusing
`src/lib/terminalPicker.ts` (the same module `trellis-onboard-
interactive-picker` built), but only offered when the resolved source
actually has both real skills and real instructions — a source with
only one real kind, or `--json`, or a terminal that can't support the
picker all default silently to migrating whichever kind(s) actually
have content, with no second, numbered-text fallback UI built, since
this choice never existed before this change to have a fallback for. An
empty selection is a valid, distinct outcome ("migrate skipped — no
categories selected"), not an error, and doesn't stop sync/mcp sync/
secrets audit from running. A real gap named rather than silently
folded in: `codex`/`pi`/`kiro` as migration sources remain untested —
`test/unit/migrate.test.ts` only ever exercises `claude-code`, despite
`collectMigratePlan`'s own dispatch being fully symmetric by design.
That's P13's job. Verified with 22 new unit tests (275/275 project-wide,
zero regressions) — no sandbox pass needed, this change touches no
adapter or native-config write path.

**P12 (✅ done, archived
[2026-09-13-trellis-canonical-cli-crud](../openspec/changes/archive/2026-09-13-trellis-canonical-cli-crud/)):
canonical CRUD via CLI.** Neither skills nor MCP servers had any
command-line add/remove/list surface — `cli.ts`'s `mcp` command
recognized exactly one subcommand, `sync`, and there was no `skill`
command at all. `trellis skill list/add/remove` and `trellis mcp
list/add/remove` are new, canonical-side-only commands (a new
`canonical-content-management` capability): `skill add`/`mcp add`
refuse (no write, no `--force`) on an existing name with different
content, mirroring `migrate`'s own conflict posture exactly, reusing
the same comparison logic via a newly-extracted
`decideDirImport(sourceDir, canonicalDir)` (src/lib/dirEquals.ts),
which also replaced `migrate.ts`'s own inline check
(behavior-preserving, confirmed by its full pre-existing suite passing
unmodified). `servers.yaml`'s new writer (`upsertServerYaml`/
`removeServerYaml` in `canonical.ts`) uses the `yaml` package's
`Document`-based `parseDocument`/`setIn`/`deleteIn`/`toString`, never a
full parse-then-restringify, specifically so a hand-authored file's
comments and untouched entries survive byte-for-byte — verified with a
dedicated test asserting exactly that. `skill remove` needed zero new
removal-propagation code: skills already carry an ownership marker (the
symlink itself), so `sync`'s pre-existing stale-symlink detection
un-syncs a removed skill automatically on the next run (proven
end-to-end in a test). `mcp remove` stays canonical-only by design —
MCP has no such marker yet, so an already-synced agent's native config
is untouched until P14 closes that gap. `mcp list` never resolves a
secret: `env` entries print as bare names (never read from
`process.env`), while `static_env` values print in full since they were
never secrets by `McpServerDef`'s own contract. Verified with 21 new
unit tests (296/296 project-wide, zero regressions) plus manual
smoke-testing of every subcommand (list/add/remove, conflict/
already-present/invalid-input, `--dry-run`, `--json`) against a
throwaway sandbox `$HOME` — no sandbox-container pass needed, this
change touches no adapter or native-config write path.

**P13 (✅ done, archived
[2026-09-13-trellis-real-sandbox-verification](../openspec/changes/archive/2026-09-13-trellis-real-sandbox-verification/)):
sandbox verification against this machine's real state.** Every sandbox
run before this (`scripts/sandbox.sh`, `docker/entrypoint.sh`) mounted
the same single, git-tracked synthetic fixture (`test/fixtures/home`).
Compounding this, `test/unit/migrate.test.ts` only ever exercised
`"claude-code"` as a migration source — codex/pi/kiro had never been
verified as sources even though `collectMigratePlan`'s `PROBES:
Record<AgentId, ...>` dispatch is fully symmetric by design (claude-code
was, however, already covered as a sync/mcp-sync *target*, in
`test/unit/sync.test.ts`/`test/unit/mcp.test.ts` — the earlier draft of
this entry claimed otherwise; corrected here after checking, not
assumed). `scripts/sandbox.sh --real` builds a throwaway snapshot from a
real `$HOME` using an **allowlist**, not the denylist first sketched here
— every path each probe (`src/probes/*.ts`) is already confirmed to
read, and nothing else, since this project has no complete knowledge of
where third-party agents' own real OAuth token flows store credentials
(design.md D1 explains the reasoning). Actually running this against a
real, in-use machine (not just reasoning about it) found two real bugs
before it could even complete: `sync`'s own real output is a symlink
back into `~/.trellis/`, which a naive symlink-preserving copy leaves
dangling once mounted into a container with no such path — fixed by
dereferencing during copy; and a case-insensitive filesystem (macOS
default) collides two of pi's own case-sensitive instructions-file
candidates (`AGENTS.md`/`AGENTS.MD`), which needed a
dest-already-exists guard to avoid a crash. Before any Docker build, the
snapshot is gated through `trellis secrets audit`'s own, already-shipped
`homeDir` seam — on the actual real-machine run, this correctly found 5
genuine `unexpected-var-name` findings and refused to proceed, exactly
as designed; clearing that machine's own `secrets.policy.yaml` gap and
running a full container pass against it remains a separate,
human-initiated action, not something this change forced through.
codex/kiro/pi as migrate sources are now covered in
`test/unit/migrateSources.test.ts`, using each probe's own confirmed
real dotfile paths. Verified with 10 new unit tests (306/306
project-wide) plus the fixture-based (default, non-`--real`)
`scripts/sandbox.sh` re-run end-to-end against Docker to confirm zero
regression to the existing path.

**P14 (✅ done — removal half only, archived
[2026-09-13-trellis-mcp-sync-removal](../openspec/changes/archive/2026-09-13-trellis-mcp-sync-removal/);
migrate-in remains open, see below): MCP server lifecycle parity with
skills.** Skills have a full migrate (import) + sync (create/repair) +
conflict story; MCP had sync only. This was always two distinct, real
gaps, not one — this change closed the harder, more clearly-specified
half: `resolveMcpPlan` was deliberately create/repair-only
(`mcpPlan.ts`'s own stated reasoning: a bare TOML/JSON key has no
ownership marker to prove Trellis, not the user, put it there), so
removing a server from `servers.yaml` never removed it from any
agent's native config. A new `src/lib/mcpOwnership.ts` ledger
(`~/.trellis/mcp/ownership.json`) records, per agent and server name,
the exact rendered value Trellis itself last wrote; on a later sync, a
name gone from canonical is only actually removed from an agent's
native config if that config's current entry still exactly matches
what the ledger recorded — a hand-edited entry is left alone,
indefinitely, never forced. Reused rather than rebuilt:
`src/lib/tomlSection.ts`'s `removeSection` (built earlier for the
static-env atomic-range work, never wired into an actual removal path
until now) for Codex, and each JSON agent's own existing `deepEqual`
for the "unchanged since" check. **Still genuinely open, not done
here:** MCP *migrate-in* (importing an already-hand-configured server
into canonical) — each static-config probe (`codex.ts`/`claude-code.ts`/
`kiro.ts`) still discards a server's complete real definition (e.g.
`codex mcp list --json`'s `CodexMcpEntry`, with `command`/`args`/
`env_vars` intact) down to `{name, transport, probe}`
(`AgentSnapshotMcpServer`) before anything downstream sees it, and
there is still no conversion from that discarded, richer shape into
canonical's `McpServerDef`. pi has no static config to read at all —
inherently import-less; P12's CLI remains its only route in. A real
gap, named rather than silently dropped, left for a future change.
Verified with 3 new/rewritten unit tests across both Claude Code's JSON
path and Codex's TOML path (308/308 project-wide, zero regressions).

**P15 (✅ done — ingestion half only, archived
[2026-09-13-trellis-memory-sync](../openspec/changes/archive/2026-09-13-trellis-memory-sync/);
per-agent extraction remains open, see below): shared memory — real
ingestion and per-agent extraction.** `memories` was parsed
(`canonical.ts`) into `CanonicalSource.memories: MemoryEntry[]` and
consumed nowhere — no adapter, no command, no `trellis memory` CLI
surface existed at all. P6 explicitly left "auto-ingesting
`~/.trellis/memories/*.md` content into the running memory server's
store" out of scope; `trellis memory sync` closes that gap (A): each
canonical memory file becomes one entity
(`entityType: "trellis-memory"`) in `@modelcontextprotocol/
server-memory`'s own on-disk JSON-lines graph file (the exact file that
server itself reads at startup — Trellis never spawns or talks to a
running server process, a plain file write like everything else this
project does), requiring `mcp/servers.yaml`'s `memory` server to set
`static_env.MEMORY_FILE_PATH` explicitly (the server's own unset-env
default resolves relative to wherever `npx` cached the package, not a
predictable location). The in-band `entityType` tag is the ownership
marker — deliberately not a separate ledger file like P14's MCP
removal, since (unlike per-agent MCP config) every agent connected to
this one server shares the exact same graph, so there's no per-agent
render to track. Every entity/relation Trellis didn't create is left
completely untouched, unconditionally; a name collision with a
non-Trellis-tagged entity is a conflict, never overwritten. **Still
genuinely open, not done here (B):** extracting an agent's own
already-accumulated memory content back into canonical — e.g. Claude
Code's own per-project memory feature. Investigated, not attempted, for
two concrete reasons: that content lives under
`~/.claude/projects/<project-slug>/memory/`, a path
`trellis-real-sandbox-verification`'s own allowlist already deliberately
excludes (mixed with real session transcripts); and the project-slug
encoding scheme Claude Code uses to derive that path from a working
directory has no authoritative documented source this project could
verify against, so it was not guessed at (this project's own "verify,
don't assume" discipline). Kiro's `totalrecallai` (SQLite + local vector
embeddings) is a further, genuinely different data shape, and was never
in scope for this half either. A real gap, named rather than silently
dropped, left for a future change. Verified with 14 new unit tests
(322/322 project-wide, zero regressions).

**P16 (✅ done, archived
[2026-09-13-trellis-migrate-mcp-servers](../openspec/changes/archive/2026-09-13-trellis-migrate-mcp-servers/)):
MCP migrate-in — the gap P14 named.** `trellis migrate --from <agent>`
gains a third `--only` value, `mcp`: claude-code, kiro, and codex each
get a new, purpose-built reader (`src/lib/mcpMigrateRead.ts`) that
converts that agent's real, already-configured MCP servers into
canonical's `McpServerDef` shape — kept entirely separate from each
probe's own thin `AgentSnapshotMcpServer` (`doctor`'s read path, left
untouched). Same conflict posture as skill/instructions migration
throughout: identical is a no-op, a differing definition under the same
name is a conflict, never overwritten. pi is still never a migrate-in
source — no static config to read, unchanged from P14's own framing.
Two fidelity limits, found by actually running each agent's real
tooling rather than assumed, are handled by refusing rather than
guessing: **Codex is stdio-transport only at first** (closed as a
same-day follow-up, see below) — `codex mcp list --json` had no
evidence in this codebase for any other transport shape at design time;
a real, one-off run against a locally-installed `codex-cli 0.154.0`
during implementation *did* observe a `streamable_http` shape (`url`,
`bearer_token_env_var`, plus three further undocumented fields) for a
hand-written `url`-based server — recorded as a concrete lead for a
future change, not built at first, since one data point from one
version isn't a contract; a non-stdio Codex server was reported
`skip-unsupported`, named, not silently dropped. **Codex's `static_env`**
is recovered by reading `[mcp_servers.<name>.env]` directly from
`config.toml` (a new `readServerEnvTable` in `tomlSection.ts`, the exact
inverse of that module's own existing writer) since `codex mcp list
--json` only ever reports variable *names*, never the literal table
Trellis itself renders separately. **`headers`** — missing from both
`claude-code.ts`'s and `kiro.ts`'s own probe-facing JSON types despite
being a real field Trellis's own writer (`jsonMcp.ts`) already produces
for http/sse servers — is recovered via a parallel, richer local type
scoped only to this new reader module, leaving both probes' existing,
`doctor`-tested types untouched. Verified with 19 new unit tests,
including one exercising the real, locally-installed `codex` binary
end-to-end against a scratch, HOME-scoped `.codex/config.toml` (341/341
project-wide, zero regressions). One related, pre-existing gap
surfaced but deliberately not fixed at first (out of scope for this
change, named instead): `src/probes/codex.ts`'s own `probe()` never
scoped its `codex mcp list --json` subprocess call to a passed-in
`homeDir` via `HOME` env override the way this change's own new reader
did — meaning that probe's MCP listing always reflected the real
machine's real codex config regardless of what `homeDir` a caller passed
it, an inconsistency with the rest of `probe()`'s own home-scoped reads.

**Same-day follow-up, both of the above closed (not a separately
numbered phase — direct fixes to already-shipped, already-specced
behavior, not new requirements, so no new OpenSpec change):**
`src/probes/codex.ts`'s `probe()` now scopes both of its `execFileSync`
calls to the passed-in `homeDir` the same way — verified with a new
regression test (`test/unit/codexProbe.test.ts`) using two distinct
scratch homes with two distinct MCP servers, confirming neither leaks
into the other; confirmed the test actually catches the bug by reverting
the fix and watching it fail against this real machine's real MCP
servers before restoring it. Separately, `buildCodexMcpReadResult`
(`src/lib/mcpMigrateRead.ts`) now converts a non-stdio Codex server when
it uses only `url` and, optionally, `bearer_token_env_var` — verified
this exact shape against the real `codex` binary a second time
(including with a real `bearer_token_env_var` set, not just a bare
`url`) — while a server using any of the three still-unexplained header
fields (`http_headers`/`env_http_headers`/`http_headers_helper`, all
`null` when unused, confirmed by the same real run) still refuses rather
than guesses. A migrated remote Codex server is always labeled `http`,
never `sse` — not a guess: Codex's own `config.toml` schema has no field
distinguishing the two (`upsertSection`'s own codex TOML rendering is
byte-identical for both transports, now covered by its own test), so
that distinction was never stored in the first place. 350/350 tests
passing.

**P17 (✅ done, archived
[2026-09-13-trellis-onboard-mcp-memory](../openspec/changes/archive/2026-09-13-trellis-onboard-mcp-memory/)):
`onboard` catches up to P15/P16 — mcp and memory were never wired into
its own orchestration.** Found by live dogfooding on a real machine:
`onboard`'s migrate-category picker hardcoded `["skills",
"instructions"]` — `mcp` was invisible to it regardless of how many real
MCP servers the source agent had — and `trellis memory sync` was never
called anywhere in `onboard`'s chain at all, despite its own docstring
naming a complete chain. `OnboardAgentSummary` gains an
`mcpServerCount`, computed via the already-exported
`collectMigratePlan(agent, homeDir, ["mcp"])` rather than a second reader
dispatch — so it always agrees with what `migrate` itself would do, and
an agent whose only real content is MCP servers is now a valid migration
source (previously invisible to `hasContent` entirely).
`resolveMigrateCategories` was rewritten from a fixed two-slot structure
to a dynamically-built list of whichever of skill/instructions/mcp have
real content, offering the checkbox only when two or more do — not a
bolted-on special case for a third option. `memory sync` runs as a new
final chained stage, after `mcp sync` and before `secrets audit`,
independent of the resolved managed-agent set (the memory server is
shared, not per-agent); `runMemorySync`'s inline printing was extracted
into an exported `printMemorySyncResult` so `onboard` reuses the exact
same output format rather than a second, drifting copy of it —
`memory.ts`'s own standalone command behavior is unchanged, confirmed by
its existing tests passing unmodified. No change to `migrate.ts`,
`mcp.ts`, or `memory.ts`'s own command behavior — purely `onboard`'s
orchestration layer catching up to commands that already existed. 357/357
tests passing.

| Phase | Deliverable | Depends on |
|---|---|---|
| P0 | ✅ `trellis doctor` — read-only, opt-in-for-handshakes scan of all four agents' current skills/MCP/instructions state, reports drift and duplicates | nothing |
| P1 | ✅ `trellis sync skills` / `trellis sync instructions` — symlink-based distribution to Claude Code, Codex, Kiro, and pi | P0 |
| P2 | ✅ `trellis mcp sync` — incremental, in-place adapters for Claude Code (JSON merge), Codex (TOML section patch), Kiro (JSON merge); collision check against known host-injected server names | P1 |
| P3 | ✅ `trellis secrets audit` — scans every adapter's output for literal credential patterns and unexpected env var names, fails non-zero on any hit | P2 |
| P4 | ✅ pi bridge extension — MCP tool registration via `registerTool`, sourced from the same `mcp/servers.yaml` | P2 |
| P5 | ✅ `@trellis/sdk` — read-only API over the canonical source, for third-party agents to consume without depending on the CLI | P1–P4 stable |
| P6 | ✅ Memory: document and wire the `server-memory` default; write the mem0/OpenMemory upgrade guide | P2 |
| P7 | ✅ Secrets/env management: shared `resolveSecretEnv` + `secrets.policy.yaml`'s `env_file`, pi bridge stops reading raw ambient env, `secrets audit` gains a `missing-env-value` check | P3, P4 |
| P8 | ✅ Kiro `${VAR}` fix: adapter also manages `kiroAgent.mcpApprovedEnvVars`, without which Kiro silently never substitutes any env reference Trellis writes | P2 |
| P9 | ✅ MCP transport/auth expansion: `headers` field for static bearer/API-key remote auth (Claude Code/Codex/Kiro/pi bridge, each via its own real schema), `sse` transport; real OAuth flows explicitly delegated to each agent's own native support, not reimplemented | P2, P4, P8 |
| P10 | ✅ GUI: decided against embedding into an existing dashboard — `@trellis/gui` (Tauri v2 + React, `openspec/changes/trellis-gui/`) is an independent read-write desktop app whose Node sidecar imports `agent-trellis`'s internal command modules directly (workspace-relative, not the read-only `@trellis/sdk` barrel) and reuses the exact same plan/confirm/backup mechanics the CLI already has. Sidecar core, all read/write endpoints (including the `mcp add`/`mcp remove`/`skill add`/`skill remove` backup-tracking gap this work found and fixed — see P5's own SDK note below, a `agent-trellis`-wide fix, not GUI-only), live file-watch + WebSocket updates, macOS binary packaging, Tauri `externalBin` spawning, the React read/write views, MCP import, the real brand mark, and a real ad-hoc-signed `.dmg` (`npx tauri build`, release) are all built and verified (real HTTP/WS integration tests throughout, plus real headless-DOM tests of the write-confirmation and import flows). Also added: a "Chat" tab for real multi-turn streaming conversation with any configured CLI Agent (typewriter effect, tool-call/tool-result bubbles for Claude Code's `stream-json` shape, one-time-per-session confirmation, in-memory-only history — never persisted, since it may carry secrets), built on `trellis-agent-bridge`'s delegated-call primitive upgraded to stream (`runDelegatedCallStreaming`). Domestic-CLI coverage researched and documented per-CLI rather than assumed uniform, then upgraded from doc-only to `--help`-confirmed once Qoder and MiniMax Code were actually installed (`npm install -g @qoder-ai/qodercli @minimax-ai/code`, both verified as the real official packages first): Qoder, Kimi Code, and MiniMax Code all ship verified starter configs with `stream-json` output and session-resume flags — Qoder's `stream-json` shape was confirmed byte-identical to Claude Code's by actually running it (zero cost: it failed cleanly on an unauthenticated status check before reaching a model), while MiniMax Code's flags are confirmed real but its exact `stream-json` line shapes are not (same zero-cost auth-failure situation, but the call never got as far as producing one). ZCode (Z.ai/智谱) and Trae are both explicitly **not** shipped — real products, but no documented non-interactive CLI mode was found for either's official binary after checking their own docs/`--help` (don't confuse ZCode with the similarly-named but unofficial and different `zcode-cli` forks, which do document prompt flags but aren't the product being asked about). Also added: a real demo sandbox (`/tmp/trellis-gui-sandbox`) populated with real MCP servers/Skills/Memory files, and English/Chinese UI support (hand-rolled `I18nProvider`/`useI18n()`, no new runtime dependency — every view's UI chrome is translated, real backend data like agent ids/paths/commands never is, language persisted to `localStorage`). Ships as an ad-hoc-signed `.dmg`, accepted as the final distribution state — full Apple Developer ID signature + notarization was assessed and explicitly deprioritized (not a code gap, and not worth the credential/process overhead for this release) | P3–P9 |
| P11 | ✅ Migrate category selection: `--only skills\|instructions` on `migrate`, same interactive picker `onboard` already uses | P1 |
| P12 | ✅ Canonical CRUD via CLI: `trellis skill add/remove/list`, `trellis mcp add/remove/list` | P1, P2 |
| P13 | ✅ Sandbox verification against this machine's real, structurally-relevant state (not just fixtures); every agent verified as both migrate source and sync/mcp-sync target | P0–P2 |
| P14 | ✅ MCP server lifecycle parity with skills: ownership-tracked safe removal on sync (migrate-in closed separately by P16) | P2, P13 |
| P15 | ✅ Shared memory: ingest canonical `memories/*.md` into the `server-memory` store's own graph file (per-agent extraction into canonical remains a separate, open gap) | P6 |
| P16 | ✅ MCP migrate-in: `trellis migrate --only mcp` for claude-code/kiro/codex (codex remote transport + probe HOME-scoping closed same-day, see prose above), closing the gap P14 named | P12, P14 |
| P17 | ✅ `onboard` orchestration catches up to P15/P16: three-way migrate-category selection (mcp added), `memory sync` wired in as a chained stage | P15, P16 |
| P18 | ✅ `envAliases`: a migrated `${NAME}` env reference whose name differs from its own key (found via live dogfooding — a real Notion MCP server crashing pi after migrate, not a hypothetical) is now recognized as a reference, not silently shipped as literal unexpanded placeholder text. New `McpServerDef.envAliases` field, threaded through migrate-read (both JSON and Codex TOML sources), every adapter's write path, the pre-write unresolvable-env refusal guard, the pi bridge's runtime resolution, and canonical's own `env_aliases`/`envAliases` on-disk round-trip | P16 |
| P19 | ✅ Migrate reclassify-repair: found immediately after P18 shipped — re-running migrate on data migrated *before* a classification fix didn't pick the fix up at all, since `planMcpServer`'s conflict check was plain `deepEqual` (any structural difference, real customization or not, was refused as "resolve by hand"). New narrow `isSafeReclassification` check + `"reclassify"` migrate action: applied automatically when a value only moved between `staticEnv`/`env`/`envAliases` while resolving to the exact same literal/reference text, everything else identical; any real difference still conflicts, unchanged. Verified for real on this machine: `migrate --from claude-code --only mcp` correctly reclassified notion's stale entry and left all 8 other already-migrated servers untouched | P18 |
| P20 | ✅ Memory extraction: closes P15's own explicitly-named "per-agent extraction into canonical remains a separate, open gap." New `trellis memory extract` — the reverse of `memory sync` — reads the shared graph's real, non-`trellis-memory` entities (the same ownership marker `memory sync` already uses to leave agent-created content untouched, read the other direction) and writes each as a new canonical `memories/*.md` file: readable markdown, not a serialization format, not meant to round-trip byte-for-byte back through `memory sync`. Same create/no-op/conflict discipline as every other Trellis write; not wired into `onboard`'s automatic chain (a deliberate, occasional action, like `migrate`) | P15 |
| P21 | ✅ MCP gateway hosting: collapses each agent's MCP config to ONE native stdio entry (`trellis mcp-gateway --agent <id>`) that Trellis itself spawns — no Docker, no daemon, no lifecycle command. Four third-party gateways were evaluated and excluded on hard constraints (MetaMCP is Docker-only; mcp-local-hub is Windows-only today; `@samanhappy/mcphub` is a 43-dependency authenticated web product with no importable SDK surface; `@pcandido/mcphub` has correct OAuth but zero `${VAR}` expansion in its stdio `env`, verified by inspecting what a spawned child actually received — adopting it would mean plaintext secrets or a second resolution path outside `secrets audit`). Built instead on `pi-bridge`'s already-proven connect logic, extracted to `src/lib/mcpConnect.ts`, behind a `GatewayBackend` seam so the confirmed next step — one shared service for all agents, with the per-session process becoming a thin MCP-over-Unix-socket client — is a substitution at one construction site, with every agent's written config identical either way. Includes Trellis's own OAuth client (RFC 8414/9728 discovery, RFC 7591 DCR, RFC 7636 PKCE S256, refresh), tested against a hand-built Authorization Server that *enforces* those RFCs rather than rubber-stamping them; tokens live 0600 one-file-per-server outside canonical, never the OS keychain (macOS `security add-generic-password` measurably fails exit 152/154 with no GUI session — the gateway's exact context). Two bugs the design caught before shipping: the MCP SDK's stdio transport reports no EOF, so without explicit teardown every agent session would leak a gateway plus its whole upstream process set; and concurrent OAuth refresh silently kills a rotated refresh token, so it is serialized by a per-server lock. Remaining: the shared service itself (v2) | P2 |
| P22 | ✅ Onboard closed loop: onboard used to stop the moment files were written, never checking whether any of it took effect, and never telling the user how the run went — a real run with a genuine sync conflict still ended its printed output on a later stage's unrelated green line. Two distinct fixes, not one: a **self-verification re-plan** (the mechanism that actually closes the loop) runs `sync`/`mcp sync` a second time, dry-run, immediately after their real apply, and treats anything still outstanding as its own blocking finding — `trellis doctor` was tried first and rejected for this job, since its six detectors compare agents against each other and never read canonical, so they cannot prove a write took effect even in principle. Doctor still runs, last, as a secondary whole-machine health scan (never `--probe-mcp` — the worst moment to spawn every configured MCP server is a user's first run of this command), with findings on an unmanaged agent demoted to a warning rather than hidden. Every stage's conflicts and findings normalize into one `VerdictItem[]`, printed as a terminal verdict block that is always the last thing on screen and always agrees with the exit code, each blocking item carrying a concrete remediation instead of a restatement of the problem. Also adds stage progress to stderr (never stdout, so `onboard > report.txt` stays exactly the report) and, on a real terminal, a `--dry-run` that ends by offering to apply (declining is the default; accepting re-plans against current state rather than replaying a now-stale preview) | P0 |
| P23 | ✅ Onboard MCP mode + memory toggle: closes the last hand-editing gap — turning on gateway or hub mode, or the shared memory server, meant directly editing `~/.trellis/mcp/servers.yaml`'s top-level `hub`/`gateway` keys or its commented-out `memory:` example, since no command wrote them (`trellis mcp add`'s flags are all per-server). New `writeMcpModeYaml` in `src/core/canonical.ts` (`Document`-based, mirrors `upsertServerYaml`'s comment-preserving edit) plus `trellis onboard --mcp-mode direct\|hub\|gateway` (`--hub-url`, `--gateway-agents`) and `--memory on\|off` close it. Both follow onboard's existing managed-set idempotency shape rather than a new one: read current state first, omitting the flag always preserves it untouched with zero prompting — identical on a first run (nothing configured) and a later one (something already is), which is the actual point: one command for both, not a setup path and a separate reconfigure path. Deliberately flag-only, never an interactive picker (a mode change reroutes every managed agent's MCP transport at once — too wide a blast radius for Enter-mashing through a prompt sequence to trigger by accident); a one-line, non-prompting status line on a real terminal keeps the flags discoverable anyway. `--memory on` refuses outright if `"memory"` is already in `known_host_injected`, rather than writing a definition the very next `mcp sync` would refuse to propagate to any agent. Because mode/memory resolution runs before onboard's existing `mcp sync`/`memory sync` stages in the same chain, `trellis onboard --memory on` enables the server, syncs it to every managed agent, and populates it from canonical `memories/*.md` — all in one run | P17, P21, P22 |
| P24 | ✅ Migrate static-env secret extraction: found via real-machine dogfooding — kiro's own real `mcp-router` server had its token hardcoded as a literal (not a `${VAR}` reference), which the existing literal-secret guard correctly refused to import, but the only path forward was three manual hand-edits across two files. A `staticEnv` match specifically (its own dict key is already a natural variable name) is now extracted automatically instead of refused: the real value moves to `~/.trellis/mcp/servers.local.env` (a sibling of `servers.yaml`, or an already-configured `secrets.policy.yaml` `env_file` if one exists — respecting a prior explicit choice rather than repointing it), canonical gets a `${NAME}` reference, `secrets.policy.yaml` gains the name in `allowed_vars`, and `~/.trellis/.gitignore` is ensured to protect the new file, all ensured lazily at the moment of the first real write, never as unconditional `init` bootstrap. `migrate` still never writes to the source agent's own file — kiro's real config keeps its literal forever, and `secrets audit` correctly keeps flagging it; extraction normalizes to a `warning` in onboard's verdict, not `blocked`, with a remediation naming that the source was left untouched. A literal found anywhere other than `staticEnv` (`command`/`url`/`args`/`headers` — no natural name to extract to) still refuses exactly as before. `findLiteralSecret` (`src/adapters/mcpPlan.ts`) now reports which field and dict key a match came from, closing a previously-undocumented spec gap for the unaffected refusal path in the same change. Also found via the same dogfooding, one commit later: extraction alone doesn't make the `${VAR}` reference `mcp sync` writes into an agent's native config actually resolve — that only happens once the name is in the environment that agent's own runtime reads from, which `servers.local.env` alone never reaches. `ensureShellEnvSource` (mirrors `ensureGitignoreEntry`'s idempotent marker-block shape) now appends one generic `set -a; source ...; set +a` pointer block to the user's shell rc (`~/.zshrc`/`~/.bash_profile`/`~/.profile` by `$SHELL`) — never a literal secret line — every real `migrate` run whenever `env_file` is set, retroactively wiring a machine that extracted before this existed. Separately, fixed a real incident this surfaced: no subcommand branch in `src/cli.ts` recognized `--help`/`-h`, so a stray `--help` silently ran the real command instead of printing usage — now short-circuits to usage text before any parsing, for every command. One more round: real-machine research (`mcpConnect.ts`, `jsonMcp.ts`, `tomlSection.ts`) found no `${VAR}` resolution mechanism proven across every consumer for `command`/`url`/`args`, and `headers` unverified for claude-code/kiro specifically — so `command`/`url`/`args`/`headers` literals are now *accepted* into canonical as ordinary config (both at `migrate`'s import boundary and `resolveMcpPlan`'s sync-out boundary), never refused and never faked into an unresolvable reference; `secrets audit` now also scans canonical's own `servers.yaml` for this (`agent: "canonical"`) so it's never silent. `staticEnv` extractions are now named `TRELLIS_<SERVER>_<KEY>` rather than the bare source key, to rule out cross-server or ambient-environment collisions — an already-extracted server (this project's own real `mcp-router`) is recognized as already-migrated by the *value* an existing reference resolves to, not by re-deriving today's naming scheme, so it keeps working under its original bare name without being renamed or re-extracted | P16, P18 |

| P25 | ✅ Onboard prompt TUI: replaces Trellis's hand-written raw-mode picker and ANSI redraw logic with `@clack/prompts`, preserving non-TTY fallbacks, `--json`, stream-injected tests, stderr-only interactive chrome, and compact agent summaries that show counts instead of enumerating skills. Full-screen TUI runtimes remain out of scope; onboarding stays visible in terminal scrollback | P22 |
| P26 | ✅ Fine-grained capability selection: item-level skill/MCP/memory selection from a serializable selection file or searchable TUI, per-agent MCP route overrides with direct/gateway/hub precedence, selected-memory sync without implicit native-memory import, and explicit unsupported-reader diagnostics | P17, P21, P22, P25 |
| P27 | 🚧 Trellis MCP Runtime phase 1 ✅: one provider registry and agent-facing MCP edge; SkillProvider and the read-only CanonicalMemoryProvider expose scoped progressive-disclosure tools/resources, runtime delivery supports native/mcp/both per agent, selected upstream tools mount through the existing GatewayBackend, and doctor checks runtime drift. Remaining: upstream resource/prompt backend, real pi/Kiro model smoke, and real Claude model smoke (Claude remains intentionally deferred) | P21, P25, P26 |
| P28 | 🚧 Kimi Code Runtime-first adapter: Kimi is recognized as a managed Agent, receives one deferred `trellis` Runtime entry in `~/.kimi-code/mcp.json`, and `trellis kimi` isolates native Skill discovery for Runtime-only delivery. The Runtime Skill is available through SkillProvider; remaining: real Kimi model-session smoke and upstream resource/prompt consumption | P27 |
| P29 | ✅ ZCode Runtime-first adapter: `zcode` is a managed Agent with profile-aware static configuration (`~/.zcode/cli/config.json` for official profiles and `setting.json` for the local community CLI), a single owned Runtime MCP entry, scoped-Skill isolation, safe instruction/MCP migration, doctor/onboarding coverage, and public-CLI chat/delegation parsing for ZCode's `response`/`sessionId` stream envelope. Desktop-private runtime paths are never process-host entry points. | P27, P28 |

**Cross-machine / cloud sharing — confirmed future direction, not yet
scoped as a phase.** Surveyed 2026-09-15 (`docs/research.md`'s "Cross-
machine / cloud sharing" section): keeping `~/.trellis` consistent across
a person's own multiple machines, and separately, providing a smoother/
shared runtime substrate for agents to actually execute in, are both
confirmed as real, wanted future capabilities — not yet broken into a
numbered phase because the substrate choice needs its own validation pass
first (git-based sync for the config side; `dagger/container-use` as a
zero-new-code MCP server entry for safer per-task sandboxing; `awslabs/
cli-agent-orchestrator` as a candidate for actual cross-machine
coordination, evaluated only after the simpler pieces are proven). See
`docs/research.md` for the full survey, including why `cloudflare/computer`
and `daytonaio/daytona` were both evaluated and not adopted (preview-only
API instability, and unmaintained-as-of-June-2026, respectively).

No dates. This is scoped by verification milestones, not calendar time.
Execution order for P11–P16: P11 → P12 → P13 → P14 → P15 → P16 — CRUD
(P12) lands before the larger features (P14, P15, P16) so each can be
adjusted via command line instead of hand-edited files while it's being
built, and the realistic sandbox (P13) lands before all three so each
gets verified against real data once, immediately, instead of against
another synthetic fixture.
