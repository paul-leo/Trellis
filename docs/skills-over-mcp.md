# Skills over MCP — what Trellis serves, and what it does not claim

The MCP Skills extension (`io.modelcontextprotocol/skills`, SEP-2640, Final)
defines how a server publishes Agent Skills through the Resources primitive.
Trellis's runtime serves its canonical skills in that shape. This page records
the exact behavior, including what is deliberately *not* done.

## What is served

For each canonical skill in the requesting agent's scope:

- `skill://<name>/SKILL.md` and every supporting file at
  `skill://<name>/<relative-path>`, through `resources/list` and
  `resources/read`.
- `skills/list` and `skills/get`, returning the specified entry: the skill's
  `uri`, its frontmatter verbatim, and a complete manifest of
  `{ uri, digest, size }` per file, with `resultType`, `ttlMs` and `cacheScope`.
  `cacheScope` is `private` because the catalog differs per agent.

The existing surface is unchanged: `trellis.skills.search|read|read_file` and
`trellis://skills/<name>/SKILL.md` keep working exactly as before. The
`skill://` view is a second, additive view of the same data.

## The manifest is computed from the bytes served

`digest` is `sha256:` plus 64 lowercase hex characters of the raw bytes;
`size` is their length. The manifest and `resources/read` use the same bounded
byte reader. Hosts still verify the retained manifest: a file can change between
listing and reading. Invalid UTF-8 is returned as
a base64 `blob` rather than lossy `text`, so the bytes a host verifies are the
bytes that were hashed.

A file the reader refuses — secret-shaped path, hidden file or directory,
`node_modules`, anything resolving outside the skill root, oversized — is absent
from the manifest and unreadable, both. A skill with more than 512 files or
16 MiB is omitted whole and reported on stderr, never published with a partial
manifest.

A skill is served under `skill://` only when its directory name equals its
frontmatter `name`, that name is a valid Agent Skills name (lowercase letters,
digits, single hyphens), and it has a non-empty `description`. Otherwise it is
omitted and the reason is reported once. It stays reachable through the existing
tools.

## A digest is consistency, not trust

The extension is explicit that digests are unsigned and that an intermediary can
rewrite entry and content together. A matching digest tells a host the bytes
match the manifest; it says nothing about whether the content is safe. Nothing in
Trellis treats a match as an authorization.

## Discovery and protocol compatibility

The runtime uses the official TypeScript SDK v2 serving entry. Modern clients
discover resources and the `io.modelcontextprotocol/skills` extension through
`server/discover`; legacy clients can still initialize and call existing tools
and resources. Merely constructing a v2 Server is not sufficient: the runtime
explicitly uses `serveStdio` to select modern or legacy behavior.

Skills list/get are registered custom methods with parameter/result schemas.
The SDK handles modern request metadata, result discrimination and server
identity. Unknown methods still return JSON-RPC `-32601`. A legacy host can use
ordinary resources/tools even if it does not understand the Skills extension.

## Upstream resources and skills

The gateway negotiates modern or legacy upstream behavior. Legacy HTTP+SSE uses
its existing transport. An upstream with resources but no tools remains valid.
Declared modern Skills catalogs are paginated, validated and relayed:

- URIs use a reversible `trellis-upstream://` namespace per source, preserving
  final path segments and relative references. Provenance records the original
  server label and URI. Canonical and equal-named upstream skills stay distinct.
- Listing does not fetch file content. Supporting files become readable from a
  complete manifest, even when absent from `resources/list`; direct `skills/get`
  also works for unlisted skills.
- Reads go back to the registered source and preserve exact bytes, digest and
  size. Skill content is rejected if digest, size or SKILL.md frontmatter differ
  from the entry. Refresh the entry before reading changed content.
- Dynamic skill manifests are currently declined with a diagnostic. Manifests
  are bounded to 512 files and 16 MiB per skill; unsupported or malformed entries
  do not remove other skills.
- No upstream skill is installed into `~/.trellis/skills`, activated, or given
  execution permissions by the relay. The consuming host retains its own approval
  and integrity checks.

Authorization ownership and the desktop flow are documented in
[MCP authorization ownership](mcp-authorization-ownership.md).

Protocol references: [SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
and [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview).
