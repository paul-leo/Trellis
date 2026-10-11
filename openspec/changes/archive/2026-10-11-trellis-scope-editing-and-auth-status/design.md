# Design

## D1 — A dedicated `scope` subcommand, not a flag on `set`

`mcp set` is about authorization classification and requires `--auth`. Making
`--agents` an independent flag there would mean two unrelated mutations behind
one verb and one dispatcher. `skill` has no `set` at all. A symmetric
`skill scope` / `mcp scope` pair is smaller to explain and to test.

Exactly one of `--agents <ids>`, `--all`, `--none` is required. An empty
`--agents` value is refused rather than read as "nobody" — "nobody" is a real
choice and has its own spelling.

## D2 — Validation: recognized and managed

Every id must be a recognized agent id and a member of `managed.yaml`. An
unmanaged id would be accepted by the data model but ineffective (scope is
always intersected with the managed set), so writing it only creates config
that looks like it does something. The error lists the managed ids.

## D3 — Normalize "everything" to "nothing explicit"

If the selected set equals the managed set, the explicit entry is removed
(`--all` semantics). Otherwise a user ticking every box today would freeze a
list that omits the agent they manage next month. The plan reports which of the
two it chose so the UI can say so.

## D4 — Storage reuses the existing writers

- Skills: `writeSkillScopeYaml` (already used by remote Skill import), which
  edits the `skills:` map in `scope.yaml` in place and removes the key when the
  scope is cleared.
- MCP: `agents:` inline on the server entry via `upsertServerYaml`, which already
  preserves comments and neighbours.
- A built-in (package-owned) Skill is refused, same as `skill add` / `remove`.

## D5 — Apply is write plus the existing cascade sync

After the write the command runs the same sync `add` / `remove` run (skills
target / `mcp sync`), so the change takes effect rather than waiting for a manual
sync. Narrowing a skill is converged by `symlinkPlan`, which already removes a
symlink whose canonical entry is "gone or scoped away"; narrowing an MCP server
goes through the ownership ledger, so an entry Trellis did not write is never
removed. Both writes happen inside a backup session so `trellis rollback` covers
them.

## D6 — Credential state is read from the token store and nothing else

For an OAuth-classified server only (the classification stays explicit — a token
file on disk never makes a server OAuth):

| State | Meaning |
|---|---|
| `not-authorized` | no stored token |
| `authorized` | token present and not expired |
| `refreshable` | expired, but a refresh token is stored |
| `expired` | expired with no refresh token |

The list carries `authStatus` and, when known, `authExpiresAt` (epoch ms). It
never carries an access token, a refresh token, a client secret, or a client id.
This is the state of the *credential*, not of the *connection*: a server can be
`authorized` and still down, and the UI labels it as credential state so it is
not read as health.

## D7 — The sidecar offers choices; the CLI stays the source of truth

- `GET /managed` returns `{ managedAgents }` from the loaded canonical source.
- `skill-scope` and `mcp-scope` are ordinary plan/apply pairs wrapping the same
  collect/apply functions the CLI uses; the GUI adds no logic the CLI lacks.
- `/mcp/list` and `/skill/list` need no new route: they already return exactly
  what the CLI lists, so the new fields appear there automatically (an existing
  test asserts the two stay identical).

## D8 — GUI behaviour

- Each skill and MCP card shows a toggle per managed agent; changes are staged,
  not applied on click. "Save" opens the existing confirm modal with the plan.
- Only managed agents are offered. A card whose effective scope is already all
  managed agents shows every toggle on.
- MCP cards show the credential badge; a server that is not authorized shows the
  exact command to run (`trellis mcp auth <name>`) instead of a button, because
  the flow needs a browser and a loopback listener that belong to a person at a
  terminal.
- Doctor findings render the agent as a tag, and findings that name no agent
  (drift across several agents) render without one.

## Risks

- The affected views carry uncommitted migration work. Edits are limited to the
  card body and a small shared agent-toggle component.
- Scope edits can remove a symlink or an MCP entry from a real agent config.
  The confirm modal shows the plan, the write is backed up, and removal of MCP
  entries stays gated by the ownership ledger.
