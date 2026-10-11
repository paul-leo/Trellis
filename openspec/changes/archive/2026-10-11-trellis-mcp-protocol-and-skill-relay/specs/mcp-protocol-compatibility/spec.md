# Spec Delta

## Purpose

Allow Trellis to serve modern skill clients and connect modern upstream servers
while retaining existing initialization-based MCP integrations.

## ADDED Requirements

### Requirement: The runtime serves both supported protocol eras
The runtime SHALL support modern discovery and legacy initialization. Modern
discovery SHALL declare resources and `io.modelcontextprotocol/skills`; existing
legacy tools and resource access SHALL remain available.

#### Scenario: A modern client discovers canonical skills
- **WHEN** a modern client discovers the runtime and lists skills
- **THEN** the extension is declared and the response contains scoped skills

#### Scenario: A legacy client still calls a tool
- **WHEN** a legacy client initializes and calls an existing Trellis tool
- **THEN** initialization and tool dispatch succeed without modern metadata

### Requirement: Upstream connection negotiates compatible protocol behavior
The gateway SHALL connect modern-only and legacy upstreams through their
supported behavior, with bounded probes and cleanup of failed connections.

#### Scenario: A modern-only upstream is available
- **WHEN** an upstream supports modern discovery but rejects initialize
- **THEN** Trellis discovers it and accesses its declared capabilities

#### Scenario: A legacy upstream has no discovery
- **WHEN** an upstream responds that discovery is unsupported
- **THEN** Trellis initializes it using a compatible legacy revision
