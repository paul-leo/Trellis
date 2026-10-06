# Design

## Context

The one-shot loopback listener responds before PKCE state/issuer checks, code exchange, and credential persistence. It also closes when that existing flow ends. The page therefore reports receipt rather than offering an unsupported live final-status endpoint.

## Goals / Non-Goals

**Goals:** recognizable Trellis branding, precise intermediate feedback, Chinese/English copy, narrow-screen and keyboard support, and self-contained rendering.

**Non-Goals:** new OAuth lifecycle states or endpoints, automatic browser closing, deep links not supported by the app, changes to credentials or Agent ownership.

## Decisions

- Add an isolated HTML renderer shared by CLI and desktop callback handling. Reuse the existing SVG mark with a small inline service label, one centered status, one short instruction, and a compact close action. Use a white background and cobalt accent; omit cards, detail rows, decorative status icons, and footers.
- Choose Chinese when the browser's preferred language is Chinese, otherwise English. Keep critical status and manual-close instructions usable without JavaScript.
- Treat code receipt as intermediate, `access_denied` as cancellation, other errors as failure, and missing code as an incomplete response. Never display a success claim about token exchange or storage.
- Display only an escaped server label and fixed localized messages. Provider error descriptions remain available to the existing flow but are not injected into browser HTML.
- Use per-response nonces for the inline stylesheet/script, no external resources, no-store and no-referrer headers. Replace the callback URL query/fragment in browser history without fetching another URL.
- A close button attempts `window.close`; if the browser keeps the tab open, display keyboard-accessible manual-close guidance. No countdown or automatic close.

## Risks / Trade-offs

- Closing a normal browser tab may be blocked → reveal manual-close guidance.
- Callback receipt is not final success → direct users to Trellis or their terminal for the final result.
- The listener is short lived → no reload-based language toggle or polling.
- Untrusted labels or provider responses → escape labels and use fixed status copy.

## Validation

Use a local fake authorization server and synthetic codes only. Verify the actual callback response and headers, keep state/issuer rejection tests, and inspect desktop/mobile Chinese/English pages in Chrome or a compatible Chromium browser. Existing real-browser desktop OAuth coverage continues to exercise grant persistence, cancellation, and retry.
