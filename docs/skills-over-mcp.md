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
`size` is their length. The same reader produces the manifest and the
`resources/read` response, so they cannot disagree. Invalid UTF-8 is returned as
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

## The extension is not declared yet

The extension is declared through `server/discover`, introduced with protocol
revision 2026-07-28. The MCP SDK Trellis uses speaks at most 2025-11-25 and has
neither `server/discover` nor `skills/*`, and the specification defines no
declaration for the `initialize` handshake. Declaring it in another field would
invent a protocol, and a conforming client only issues `skills/list` after
observing a declaration anyway.

So on today's SDK the runtime declares nothing, answers `skills/list` and
`skills/get` through the SDK's fallback for unregistered methods, and serves
`skill://` as ordinary resources — which the specification expressly allows. Once
the SDK exposes `server/discover`, the declaration is a one-place change. Any other
unknown method still gets JSON-RPC `-32601`.

## Relaying skills from upstream servers is not implemented

Today an upstream server's skills are not relayed — the gateway backend
aggregates tools only. When a change adds that, it must:

- identify a skill by (upstream label, URI) together, never by URI alone, with a
  namespace per upstream;
- never let an upstream skill shadow a canonical skill or another upstream's;
- bind reads to the originating upstream, with no cross-upstream reads;
- pass the upstream manifest through unchanged or re-derive it from the relayed
  bytes — never pair an upstream digest with different bytes;
- not write an upstream skill into `~/.trellis/skills` automatically. The
  specification requires per-skill user approval before such content is used, and
  materializing it would bypass that.
