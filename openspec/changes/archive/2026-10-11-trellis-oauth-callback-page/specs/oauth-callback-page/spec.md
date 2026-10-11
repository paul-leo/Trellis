# Spec Delta

## Purpose

Give users recognizable and accurate browser feedback when an OAuth provider returns to Trellis's local callback, while keeping authorization parameters private and preserving the existing grant lifecycle.

## ADDED Requirements

### Requirement: Callback feedback identifies Trellis and the selected server

The callback page SHALL display the existing Trellis mark, product name, and escaped server label in a responsive layout with Chinese or English copy selected from the browser's preferred language.

#### Scenario: A Chinese browser receives an authorization response

- **WHEN** a browser preferring Chinese reaches a valid callback path with a code
- **THEN** the page identifies Trellis and the selected server with Chinese instructions

### Requirement: Callback receipt does not claim completed authorization

The page SHALL describe code receipt as intermediate and direct the user to Trellis or the terminal for the final result. It SHALL distinguish cancellation, provider failure, and a response missing a code without changing the underlying OAuth validation or exchange.

#### Scenario: The callback arrives before exchange completes

- **WHEN** a callback code is received
- **THEN** the page says the response was received and does not claim credentials were saved

#### Scenario: The user denies authorization

- **WHEN** the callback carries `access_denied`
- **THEN** the page gives cancellation feedback and explains how to start again from Trellis

### Requirement: Browser feedback is private and self contained

The response SHALL load no external assets, forbid caching and referrer disclosure, and escape untrusted display data. When JavaScript is available it SHALL remove callback query and fragment data from the current browser history entry. The page SHALL NOT render callback codes, states, tokens, or raw provider descriptions.

#### Scenario: A callback contains credentials and hostile text

- **WHEN** the callback query contains synthetic code/state values or a provider description containing markup
- **THEN** those values are absent from the rendered page and the executed page removes the query and fragment from its URL

### Requirement: Closing the page remains usable when browser closing is blocked

The page SHALL offer a keyboard-accessible close action and manual-close guidance. Status and fallback instructions SHALL remain readable without JavaScript or at a narrow viewport.

#### Scenario: A regular browser tab cannot be closed programmatically

- **WHEN** the user activates the close action and the browser keeps the tab open
- **THEN** the page displays instructions to close the tab manually without losing the status message
