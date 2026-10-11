# Design

## D1 — Additive: `skill://` next to `trellis://`, tools unchanged

Existing agents use the three `trellis.skills.*` tools and the
`trellis://skills/` resources. Removing or renaming either would break
working setups for no gain. The new `skill://` resources are a second view of the
same data, so a convention-aware host works and every current host is untouched.

## D2 — The manifest is computed from served bytes

The specification requires the manifest to be computed from the bytes served,
not from metadata. The provider reads each file once through the same bounded,
non-secret, no-traversal, no-symlink-escape reader the existing tools use, and
derives `size` and `sha256` from exactly those bytes. A file the reader refuses
(secret-shaped, oversized, escaping) is absent from the manifest and from
`resources/read` alike — the two can never disagree.

A skill exceeding the extension's SHOULD-NOT limits (512 files or 16 MiB) is
served without a manifest-incomplete state: it is omitted from `skills/list` and
reported in the provider's diagnostics rather than served with a partial
manifest, because a partial manifest is a false claim of completeness.

## D3 — `name` equals the final path segment, enforced at serve time

`skill://<name>/SKILL.md` requires the directory name to equal the frontmatter
`name`. Canonical skills whose frontmatter name differs are not served under
`skill://` and are reported, instead of being served under a URI the
specification says is invalid.

## D4 — Declaration is gated on what the protocol can carry

The extension is declared via `server/discover`. The runtime's SDK has no such
method and negotiates `initialize`. Writing the declaration into some other
field (`experimental`, or an `extensions` key the handshake does not define)
would invent a protocol the specification does not describe, and a client that
issues `skills/list` only after observing a declaration would never use it
anyway. So on the current SDK the runtime does not declare the extension, still
registers the handlers, and serves `skill://` as ordinary resources. When the SDK
exposes `server/discover`, the declaration is added there — a one-place change.

## D5 — Digests describe consistency, not trust

The extension is explicit that digests are unsigned and that an intermediary can
rewrite entry and content together. Trellis serves its own canonical files, so the
digest tells a host the bytes match the manifest; it makes no claim about the
content's safety. Documentation says so, and no code treats a digest match as an
authorization.

## D6 — Constraints for relaying upstream skills (recorded, not implemented)

A later change that lets the gateway relay an upstream server's skills must:

- key skills by the pair (upstream label, URI), never by URI alone, and namespace
  per upstream so two servers' `skill://code-review/SKILL.md` cannot collide;
- never let an upstream skill shadow a canonical or another upstream's skill of
  the same name;
- keep reads bound to the originating upstream, with no cross-upstream read;
- pass the upstream's manifest through unchanged, or re-derive it from the bytes
  relayed — never mix an upstream digest with different bytes;
- not materialize an upstream skill into `~/.trellis/skills` automatically, since
  that would bypass the per-skill approval the specification requires.

## Risks

- The `skills/list` and `skills/get` handlers are unreachable by a conforming
  client until a declaration can be made. They are cheap and tested, but their
  value arrives with the SDK upgrade; this is stated rather than hidden.
- A client may treat `skill://` resources as skills without negotiating the
  extension. That is the convention the extension standardizes, and the content
  is the same read-only, non-secret data the tools already return.
