# Spec Delta

## ADDED Requirements

### Requirement: Bridge delivery is limited to pi older than 1.1.0

Every requirement in this capability describes the fallback delivery for
pi versions without a native MCP client. When the probed pi version is
1.1.0 or newer, sync SHALL NOT create the bridge symlink, SHALL remove
an existing Trellis-owned bridge symlink per `mcp-server-sync`'s
migration requirement, and SHALL deliver MCP configuration natively via
`~/.pi/agent/mcp.json` instead. The bridge code, its build step, and
this capability are scheduled for deletion by a follow-up change one
release later.

#### Scenario: pi 1.1.0 or newer receives no bridge

- **WHEN** `trellis sync` plans pi delivery and the probed pi version is
  1.1.0 or newer
- **THEN** no bridge symlink is created, and an existing Trellis-owned
  bridge symlink is planned for removal per `mcp-server-sync`

#### Scenario: Older pi keeps the bridge

- **WHEN** the probed pi version is older than 1.1.0 or cannot be
  determined
- **THEN** every requirement in this capability applies unchanged and no
  mcp.json write is planned
