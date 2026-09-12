## 1. Bridge lifecycle

- [ ] 1.1 Extend the duck-typed pi API with an optional `session_shutdown` event hook.
- [ ] 1.2 Track connected MCP clients and close them idempotently on shutdown.
- [ ] 1.3 Close a connected client when `tools/list` fails.
- [ ] 1.4 Keep connection failures isolated and preserve the existing per-server diagnostics.

## 2. Verification

- [ ] 2.1 Add unit coverage for shutdown cleanup, repeated shutdown, and discovery-failure cleanup.
- [ ] 2.2 Build the dependency-free pi bridge bundle and verify the real pi symlink still loads it.
- [ ] 2.3 Run the local pi CLI with the migrated MCP configuration and verify no bridge child processes remain after exit.
- [ ] 2.4 Run typecheck and the full test suite.

## 3. Documentation and closeout

- [ ] 3.1 Record the lifecycle behavior and local pi verification in the architecture/roadmap documentation.
- [ ] 3.2 Validate and archive the OpenSpec change, then commit with the personal Git identity.
