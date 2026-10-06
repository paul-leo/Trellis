# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## OAuth browser verification

`npm run test:oauth-browser` uses installed Google Chrome headlessly and a local
OAuth fixture. It verifies native/hosted credential separation, real browser
CORS, PKCE callback, cancellation, retry and ownership confirmation. No personal
credential is used. Run this before desktop packaging alongside `test:smoke`,
`sidecar:test` and the frontend/sidecar typechecks.
