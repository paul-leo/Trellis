## Context

Real-machine testing of the pi bridge (after `trellis-pi-mcp-bridge-p4`)
turned up two things no fixture caught:

- `trellis secrets audit` only ever checked variable *names* against
  `secretsPolicy.allowedVars` — never whether the name resolves to an
  actual value in the environment the audit runs in. A machine migration
  (copy `~/.trellis/` over, nothing else) would silently carry every
  *name* across while leaving every *value* unset, and nothing in
  Trellis's own tooling would say so.
- The pi bridge's `connectStdio` already reads real secret values —
  `process.env[name] ?? ""` — to build the env it hands to
  `StdioClientTransport`. That's not new exposure this change introduces;
  P4 already had to do this, because pi's bridge is Trellis's *own* code
  spawning a subprocess, unlike Claude Code/Codex/Kiro where the
  generated config is just a `${VAR}`-style reference and the *agent's
  own* native MCP client resolves and spawns in its own process. What's
  missing is that the bridge's resolution is unconditionally ambient: it
  reads whatever `process.env` the parent `pi` process happens to carry,
  which on a real, already-configured machine is every credential that
  process's shell exports — not just the one or two names the active
  server actually declared.

`schema/secrets.policy.example.yaml`'s existing comment says "Trellis
never reads, writes, or transports the values themselves." That's
accurate for the three config-*writing* adapters (Claude Code/Codex/
Kiro) — they only ever emit `${VAR}` references, never a value. It was
already not fully true for pi's bridge since P4. This change doesn't
introduce a new exception to that principle; it makes the one that
already existed narrower and opt-in-improvable, instead of leaving it as
an unexamined gap.

## Goals / Non-Goals

**Goals**
- One shared resolver so the bridge and the audit can never disagree
  about where a declared name's value comes from.
- An explicit, opt-in way to point that resolver at a single named file
  instead of ambient `process.env`, so a user who already keeps secrets
  out of their shell's global export list can keep pi's bridge that way
  too.
- A `secrets audit` finding that catches "this name is declared but has
  no value anywhere Trellis would look," independent of any specific
  agent's config file.

**Non-Goals**
- Changing Claude Code/Codex/Kiro's own resolution. Out of Trellis's
  reach entirely (see Context).
- Inventing a new Trellis-owned secrets file. `env_file` names an
  existing file; Trellis does not create, seed, or migrate it.
- Enforcing anything about where `env_file` lives (e.g., warning if it's
  inside a git-tracked tree). Real risk, deliberately left open (see Open
  Questions) rather than solved half-heartedly here.
- Any change to the three write-path adapters' own code. They're
  untouched — this change is bridge + audit only.

## Decisions

### D1 — One shared resolver (`src/lib/secretEnv.ts`), not two separate lookups

```ts
export function resolveSecretEnv(
  names: string[],
  policy: SecretsPolicy,
): Record<string, string | undefined>
```

If `policy.envFile` is set, it's parsed once (dependency-free `KEY=VALUE`
line parsing, `#`-comment and blank-line skipping — same narrow,
purpose-built parsing philosophy as P3's `envVarNames.ts`, not a new
dotenv dependency) and is the **sole** source: names not found in it
resolve to `undefined`, `process.env` is never consulted as a fallback.
If `policy.envFile` is unset, resolution falls back to `process.env[name]`
directly — today's behavior, unchanged for every user who doesn't opt in.

The "no fallback once `env_file` is set" rule is deliberate: a silent
fallback to ambient env would silently defeat the isolation this feature
exists to offer — a user who thinks they've moved every credential out of
their shell's export list needs a missing name to actually show up
missing, not quietly resolve from the ambient env they were trying to get
away from.

### D2 — The bridge switches to the shared resolver; nothing else does

Only `src/pi-bridge/index.ts`'s `connectStdio` changes
(`process.env[name] ?? ""` → `resolveSecretEnv(def.env ?? [], policy)[name] ?? ""`).
`src/adapters/claude-code.ts`/`codex.ts`/`kiro.ts` are untouched — they
never read a value in the first place, only ever emit `${VAR}`
references, and that's still correct; nothing there needs the resolver.

### D3 — `missing-env-value` is agent-agnostic, and honestly only a proxy for three of the four agents

The new `secrets audit` finding iterates every `env` name declared across
canonical `mcp.servers[*]` (deduplicated, not per-agent) and calls the
same resolver. For **pi**, this is authoritative — it's the literal
resolution the bridge itself performs. For **Claude Code/Codex/Kiro**,
it's a best-effort proxy: those agents resolve `${VAR}` in their own
process using their own ambient environment, which the audit cannot
observe directly. The proxy is accurate exactly when `env_file` (if set)
is *also* exported into the shell that launches those agents — true on
this real machine (`~/.zshenv` sources
`~/.config/agent-env/secrets.env` unconditionally for every zsh
invocation), not guaranteed in general. The finding's message says
"Trellis's own resolution has no value for this name," not "this agent
will fail" — an honest scope for what the check can actually prove.

### D4 — `env_file` format: narrow, hand-rolled, not a new dependency

Same reasoning as P3's `envVarNames.ts`: a full dotenv-parsing dependency
(quoting rules, multiline values, export-prefix handling, interpolation)
is more than this narrow need requires. The parser handles exactly:
`KEY=VALUE` per line, `#`-prefixed and blank lines skipped, no quoting,
no interpolation. A value containing a literal `#` or requiring quotes is
out of scope — document this in the schema example rather than silently
mishandling it.

## Risks / Trade-offs

- **`env_file` living inside a git-tracked directory is a real leak
  vector** — a `git add .` in a dotfiles repo containing it would commit
  plaintext secrets. Not solved here (see Open Questions); documented as
  a sharp edge in the schema example's comment.
- **The `missing-env-value` proxy for the three non-pi agents can be
  wrong in either direction**: a name Trellis resolves successfully might
  still be unset in whatever environment actually launches Claude Code/
  Codex/Kiro (false negative), and vice versa if that agent is launched
  from a differently-provisioned shell (false positive). D3's message
  wording exists specifically to not overclaim what's actually verified.

## Migration Plan

Fully backward compatible: `env_file` is optional; every existing
`secrets.policy.yaml` without it behaves exactly as before (ambient
`process.env`, no new findings unless a genuinely-missing name exists).

## Open Questions

- Should `trellis doctor` warn when `env_file` resolves to a path inside
  a git-tracked directory? Real risk, deliberately deferred — not
  resolved by silence.
- Should the `missing-env-value` check be able to target a *specific*
  agent's actual launch environment (e.g., by shelling out to how that
  agent is normally started) rather than only Trellis's own process env?
  Not attempted here — the honest proxy in D3 is the scope this change
  ships.
