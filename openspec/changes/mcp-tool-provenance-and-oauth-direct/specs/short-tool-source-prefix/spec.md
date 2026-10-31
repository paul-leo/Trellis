# Spec Delta

## REMOVED Requirements

### Requirement: Short exposed tools carry compact source context
Removed: the conditional 12-character prefix rule is obsolete. The gateway
now prefixes every upstream tool with its server name unconditionally
(see `mcp-tool-name-preservation`), which fully covers the short-tool
ambiguity this requirement existed to solve.

### Requirement: Short-name prefixing preserves existing safety guarantees
Removed: its guarantees (normalization, max length, deterministic
allocation, correct routing) are preserved by the unconditional-prefix
requirement in `mcp-tool-name-preservation`.
