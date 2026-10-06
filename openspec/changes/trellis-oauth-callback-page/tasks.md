# Tasks

## 1. Implement browser feedback

- [x] 1.1 Add a self-contained branded renderer with localized received/cancelled/error states; verify hostile labels and descriptions cannot become markup or credential text.
- [x] 1.2 Integrate rendering into the existing loopback listener with nonce CSP and privacy headers; verify callback semantics, PKCE/issuer rejection, and token exchange remain intact.
- [x] 1.3 Add history cleanup and accessible close fallback; verify narrow layouts and browser-blocked closing in a real Chromium browser.

## 2. Validate and deliver

- [x] 2.1 Extend focused callback and browser coverage with synthetic local grants; verify core OAuth tests, typecheck/build, and desktop browser grant/cancel/retry acceptance.
- [ ] 2.2 Inspect desktop/mobile screenshots and update callback behavior documentation; verify strict OpenSpec and clean diff, then submit the product change for review.
