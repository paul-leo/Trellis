# Tasks

- [x] 1.1 Add explicit `auth: oauth` canonical typing, YAML round-trip, MCP
      listing, and `trellis mcp add/set` CLI support.
- [x] 1.2 Refactor MCP planning so gateway/runtime routes return one ordinary
      gateway edge plus direct entries for eligible OAuth servers.
- [x] 1.3 Filter OAuth servers from gateway/runtime upstream resolution.
- [x] 1.4 Update Pi bridge to use the mixed plan and Trellis OAuth token
      refresh only for its direct OAuth connections.
- [x] 2.1 Add unit tests for classification, CLI updates, mixed plans, OAuth
      filtering, and direct OAuth failure isolation.
- [x] 2.2 Update schema/docs, run full tests, build/package verification, and
      test the real local Pi/Claude managed setup with explicit OAuth markers.
