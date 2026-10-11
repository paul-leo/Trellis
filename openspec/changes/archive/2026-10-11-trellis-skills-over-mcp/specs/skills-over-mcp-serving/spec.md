# Spec Delta

## Purpose

This capability makes Trellis's canonical Skills readable by a host that follows
the Skills-over-MCP convention, with a manifest a host can verify, without
claiming conformance that the negotiated protocol revision cannot express.

## ADDED Requirements

### Requirement: In-scope skills are served as `skill://` resources

The runtime SHALL, for each canonical skill in the requesting agent's scope,
serve `skill://<name>/SKILL.md` and each supporting file at
`skill://<name>/<relative-path>` through `resources/list` and `resources/read`,
in addition to the existing `trellis://skills/<name>/SKILL.md` resources and
tools, which SHALL remain unchanged. A skill outside the requesting agent's scope
SHALL NOT be listed or readable.

#### Scenario: A convention-aware host reads a skill

- **WHEN** an in-scope skill `review` exists and a client reads
  `skill://review/SKILL.md`
- **THEN** the response contains the `SKILL.md` text with `text/markdown`

#### Scenario: Scope is enforced on every request

- **WHEN** a skill is scoped away from the requesting agent
- **THEN** neither `resources/list` nor `resources/read` exposes it, including
  by direct URI

#### Scenario: Existing surfaces are unchanged

- **WHEN** an agent uses `trellis.skills.read` or a `trellis://skills/` resource
- **THEN** it receives the same result as before this change

### Requirement: Each skill has a manifest computed from the bytes served

The system SHALL describe every served skill with a manifest listing each file's
URI, a `sha256:` digest of 64 lowercase hex characters, and the raw byte size,
computed from exactly the bytes `resources/read` returns for that file. A file
the reader refuses to serve SHALL be absent from the manifest.

#### Scenario: Manifest matches content

- **WHEN** a client reads a file listed in a manifest
- **THEN** the byte length and SHA-256 of what it received equal the manifest's
  `size` and `digest`

#### Scenario: A refused file is not advertised

- **WHEN** a skill directory contains a secret-shaped or oversized file
- **THEN** that file appears in neither the manifest nor `resources/read`

#### Scenario: An oversized skill is not partially advertised

- **WHEN** a skill exceeds 512 files or 16 MiB
- **THEN** it is omitted from `skills/list` and reported in diagnostics, and no
  partial manifest is published for it

### Requirement: `skills/list` and `skills/get` return the specified entries

The runtime SHALL implement `skills/list` and `skills/get`. Each entry SHALL
contain `uri`, the verbatim `frontmatter` including `name` and `description`, and
the complete manifest as `resources`; each result SHALL contain
`resultType: "complete"`, `ttlMs`, and `cacheScope`. `skills/get` SHALL succeed
for every served skill independently of listing, and SHALL return JSON-RPC error
`-32602` for an unknown or out-of-scope URI.

#### Scenario: Listing

- **WHEN** a client sends `skills/list`
- **THEN** it receives one entry per in-scope, servable skill with the required
  fields and cache fields

#### Scenario: Lookup by URI

- **WHEN** a client sends `skills/get` with `skill://review/SKILL.md`
- **THEN** it receives that skill's entry under `skill`

#### Scenario: Unknown or out-of-scope URI

- **WHEN** the URI names no served skill, or one outside the agent's scope
- **THEN** the response is error `-32602`

### Requirement: A skill is served only under a valid name

The system SHALL serve a skill under `skill://` only when its directory name
equals the `name` in its `SKILL.md` frontmatter and the frontmatter contains a
`description`, and SHALL otherwise omit it from `skill://` and report the reason.

#### Scenario: Name mismatch

- **WHEN** directory `review` has frontmatter `name: code-review`
- **THEN** it is not served under `skill://` and a diagnostic names the mismatch

### Requirement: The extension is declared only where it can be carried

The runtime SHALL declare `io.modelcontextprotocol/skills` only through a
mechanism the negotiated protocol revision defines for extension declaration. On
a revision that defines none, the runtime SHALL NOT declare the extension in any
other field, and SHALL behave as an ordinary resource server.

#### Scenario: Current protocol revision

- **WHEN** a client connects using a protocol revision without `server/discover`
- **THEN** the server's capabilities contain no skills extension declaration and
  `skill://` resources remain readable as ordinary resources

### Requirement: Relaying upstream skills is out of scope and constrained

This change SHALL NOT relay, cache, or materialize skills from upstream MCP
servers. The design SHALL record the constraints a later change must satisfy:
identity by upstream and URI together, no shadowing, no cross-upstream reads,
manifest integrity, and no automatic materialization into the local skills
directory.

#### Scenario: Upstream skills are not silently adopted

- **WHEN** an upstream server publishes `skill://` resources
- **THEN** they are not written into `~/.trellis/skills` and are not merged into
  the served catalog by this change
