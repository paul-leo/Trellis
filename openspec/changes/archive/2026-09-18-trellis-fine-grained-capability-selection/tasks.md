## 1. Inventory and selection model

- [x] 1.1 Add `CapabilityInventory` and `CapabilitySelection` types without
      removing existing migrate contracts.
- [x] 1.2 Build item inventories from the existing migrate plans and canonical
      memory state, including unsupported native-memory diagnostics.
- [x] 1.3 Add selection-file parsing with schema validation and secret-safe
      diagnostics.

## 2. Fine-grained migration

- [x] 2.1 Extend migrate planning to filter skills, MCP servers, and supported
      memory entries by selected names.
- [x] 2.2 Preserve `--only` behavior as a compatibility shortcut.
- [x] 2.3 Add explicit non-interactive flags or selection-file wiring.
- [x] 2.4 Add item-level verdicts, backup coverage, and partial-apply tests.

## 3. Per-agent MCP routes

- [x] 3.1 Extend canonical MCP parsing/writing with optional per-agent routes.
- [x] 3.2 Define precedence between routes and existing hub/gateway shorthand.
- [x] 3.3 Update `resolveMcpPlan` to filter the selected server subset per
      agent and route.
- [x] 3.4 Add route-aware adapter tests for direct, hub, and gateway modes.
- [x] 3.5 Add real scratch-home verification for mixed agent routes.

## 4. Onboarding TUI

- [x] 4.1 Add searchable skill and MCP multiselect flows.
- [x] 4.2 Add per-agent MCP route selection with compact summaries.
- [x] 4.3 Preserve non-TTY, `--json`, cancellation, and first/Nth-run behavior.
- [x] 4.4 Add TUI tests that never print secrets or enumerate huge payloads.

## 5. Memory boundaries

- [x] 5.1 Add explicit canonical-memory selection to the inventory and plan.
- [x] 5.2 Report native memory sources as unsupported without a reader.
- [x] 5.3 Keep provider-backed runtime memory out of automatic canonical import.
- [x] 5.4 Add tests for empty, unsupported, selected, and conflict states.

## 6. Documentation and verification

- [x] 6.1 Update onboarding documentation with item-level selection examples.
- [x] 6.2 Document route precedence and backward-compatible shorthand.
- [x] 6.3 Run the full suite, typecheck, build, package verification, and real
      scratch-home verification.
