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
| P10 | GUI: evaluate embedding into mcp-router's or skills-hub's existing interface before building anything new | P3–P9 |

No dates. This is scoped by verification milestones, not calendar time.
