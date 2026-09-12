## ADDED Requirements

### Requirement: The canonical source is importable without the CLI
`agent-trellis` SHALL export `loadCanonicalSource` and its supporting
canonical-source types from the package's root entry point, resolvable
via a plain `import` with no subprocess or CLI invocation involved.

#### Scenario: A consumer imports and calls loadCanonicalSource directly
- **WHEN** a Node program runs `import { loadCanonicalSource } from
  "agent-trellis"` and calls it against a directory containing a valid
  `~/.trellis/`-shaped tree
- **THEN** it receives the same `CanonicalSource` object shape every
  built-in adapter already consumes, without spawning the `trellis`
  binary

#### Scenario: The package's own compiled output resolves the export correctly
- **WHEN** the package is built (`npm run build`) and its root entry is
  imported the way a real consumer's `node_modules` resolution would
  (Node's package `"exports"` algorithm, not a source-relative import)
- **THEN** the import succeeds and `loadCanonicalSource` is a callable
  function

### Requirement: The exported surface excludes adapter and command internals
The SDK barrel SHALL NOT re-export anything from `src/adapters/*` or
`src/commands/*` — only canonical-source loading and its type surface.

#### Scenario: Adapter/write-path internals are not part of the public surface
- **WHEN** inspecting `src/sdk.ts`'s exports
- **THEN** none of `planSymlinks`, `resolveMcpPlan`, `applyJsonMcp`,
  `upsertSection`, or any adapter class (`ClaudeCodeAdapter`,
  `CodexAdapter`, `KiroAdapter`, `PiAdapter`) appear among them
