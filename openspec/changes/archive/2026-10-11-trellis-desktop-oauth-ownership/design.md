# Design

## Context

See proposal.md. OAuth metadata currently has kind/client identity only. The
gateway excludes all OAuth servers. Runtime delivery also needs to retain native
entries for Agent-owned OAuth. The sidecar has an existing event channel.

## Goals / Non-Goals

Make authorization ownership visible and explicit. Agent-specific token
inspection/import, Keychain access and headless interactive grants are excluded.

## Decisions

1. `auth.owner` is `agent` by default; only `{kind: oauth, owner: trellis}` opts
   into hosting. CLI `mcp set --auth-owner` and desktop plan/apply can change it.
   Existing scalar/object auth shapes stay valid. Agent-owned OAuth is always a
   native entry even when runtime delivery is enabled. Hosted OAuth requires a
   runtime/gateway route; plain direct mode reports a repair action rather than
   silently writing a native entry with Trellis ownership.
2. Listing exposes `authOwner` and per-Agent authorization guidance. A native
   authorization state is unknown unless supplied by an official probe; no
   Trellis token is read to infer it. Hosted state uses the existing token store.
   Known official flows are offered as instructions, not guessed subprocesses.
3. Export a structured OAuth core function used by CLI and sidecar. Add
   AbortSignal and progress callbacks with sanitized phases. Browser URLs and
   tokens never appear in public job status. The sidecar opens the system browser.
4. `POST /oauth/start`, `GET /oauth/jobs/:id`, `POST /oauth/jobs/:id/cancel`
   manage ephemeral tasks. One active task per server, bounded timeout and
   terminal-job retention. Recheck ownership at start and before saving tokens.
   Cancellation closes the callback server and prevents late credential writes.
5. The desktop explicitly starts tasks and polls progress, showing failure and
   retry without freezing the view. Only hosted entries have a Trellis-authorize
   action; Agent-owned entries show their own Agent guidance and unknown state.
6. Authorization endpoints require an allowed desktop/development Origin;
   reject arbitrary web origins before any browser launch or state read. This
   closes the existing permissive-CORS gap for these new sensitive endpoints.
7. New grants retain resource/issuer stamps and send RFC 8707 resource indicators
   during authorization, exchange and refresh. RFC 9207 callback issuer is checked
   when supplied and required when advertised. A bound-resource mismatch requires
   a new grant. Persist under the existing refresh lock after rechecking current
   configuration and cancellation; never hold that lock while waiting in a browser.

## Risks / Trade-offs

- Native authorization cannot always be observed → display unknown and official
  guidance instead of implying that a valid Trellis token authorized an Agent.
- User changes ownership during a grant → reject persistence if ownership or
  endpoint changed. Preserve prior credentials on cancellation/failure.
- Multiple runtime processes refresh one hosted credential → reuse existing
  server-scoped refresh locks.

## Migration Plan

Existing OAuth servers remain Agent-owned; no automatic route change. Users
explicitly select hosting through plan/apply. Rollback removes the opt-in field
and resyncs native routing; no Agent credential is altered.
