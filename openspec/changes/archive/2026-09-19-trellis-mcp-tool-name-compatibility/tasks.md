# Tasks

- [x] 1.1 Add a shared Agent-safe tool-name allocator with character
      normalization, 64-character bounded hashing, and deterministic collision
      handling while retaining raw source identities.
- [x] 1.2 Refactor `McpToolRegistry` to use the allocator for Gateway output
      and routing without changing canonical or upstream names.
- [x] 1.3 Refactor `BuiltinRegistry` to expose normalized Runtime tool names
      while dispatching calls with the original provider tool names.
- [x] 1.4 Refactor the Pi bridge to batch successful upstream tool discovery,
      allocate names through the shared registry, and preserve raw labels.
- [x] 2.1 Add unit tests for invalid characters, unique short names, duplicate
      names, long names, normalized collisions, built-in Runtime dispatch, and
      Pi bridge routing.
- [x] 2.2 Run typecheck, full tests, build/package verification, and a real
      Pi offline startup against the rebuilt bridge to confirm the Codex-style
      tool-name validation error is gone.
