# Proposal

## Why

Interactive onboarding currently exposes internal terms such as `direct`,
`gateway`, and `hub` without explaining who runs the MCP service or whether
the user needs another service. A user who only wants Trellis to manage local
agents can therefore choose an external Hub accidentally, or miss the safer
local Gateway choice.

## What Changes

- Add concise plain-language descriptions to each interactive onboarding
  decision.
- Mark the context-appropriate default/recommended choice in every picker.
- Make the MCP route picker explain the operational difference between direct,
  gateway, and hub modes.
- Recommend local Gateway for Trellis-managed local use, while clearly stating
  that Hub is only for an already-running external MCP service.
- Keep explicit CLI flags and selection files authoritative; recommendations
  apply only to interactive prompts.
- Preserve existing configuration on a normal re-run when no mode choice is
  requested.

## Capabilities

### New Capabilities

- `onboard-choice-guidance`: contextual recommendations and plain-language
  explanations for interactive onboarding choices.

### Modified Capabilities

- None.

## Impact

- Interactive labels/messages in `src/commands/onboard.ts` and picker support
  for default selection text.
- Unit tests for recommendation labels and MCP mode explanations.
- No changes to canonical schema, non-interactive CLI semantics, or write
  ownership behavior.
