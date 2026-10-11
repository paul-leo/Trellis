# Proposal

## Why

The OAuth loopback callback renders unstyled HTML, so users cannot clearly identify it as Trellis or tell what to do next. The browser response arrives before token exchange and persistence, and must accurately describe that intermediate state.

## What Changes

- Provide a self-contained Trellis page with the existing mark, a centered status, one short instruction, and a compact close action on a white background with a cobalt accent.
- Show clear received, cancelled, failure, and incomplete-response messages in Chinese or English, with the server label and an accessible close action.
- Explain that the final authorization result remains in Trellis or the terminal; do not claim that callback receipt means credentials were saved.
- Remove callback query/fragment data from browser history after rendering and prevent caching, referrer leakage, external assets, and untrusted markup.
- Verify actual callback rendering, browser behavior, narrow-screen layouts, and the existing PKCE/issuer/cancellation flow.

## Capabilities

### New Capabilities

- `oauth-callback-page`: branded, accessible, localized, private browser feedback for the existing loopback OAuth callback.

### Modified Capabilities

None. OAuth ownership, code validation, exchange, credential persistence, and callback lifetime remain unchanged.

## Impact

Core OAuth callback rendering, its focused tests, browser acceptance, and authorization documentation. No GUI migration, dependencies, package version bump, or changes to local production credentials are required.
