#!/usr/bin/env node
/**
 * Compiles the sidecar (packages/gui/sidecar/**) into a single-file
 * native binary and places it where Tauri's `externalBin` expects it
 * (trellis-gui tasks.md 5.1/5.2). Three real steps, run in order:
 *
 * 1. `tsc -p sidecar/tsconfig.build.json` — a dedicated build tsconfig
 *    (distinct from `sidecar/tsconfig.json`, which is `noEmit: true` and
 *    only used for typechecking) with `rootDir` set to the repo root, so
 *    the compiled output tree mirrors the source tree exactly. This
 *    matters: several `src/commands/*.ts`/`src/adapters/*.ts` files
 *    resolve template/bundle assets relative to their own
 *    `import.meta.url` (`schema/secrets.policy.example.yaml`,
 *    `schema/builtin-skills/trellis-runtime/SKILL.md`,
 *    `dist/pi-bridge/bundle.js`) — bundling everything into one file
 *    (the naive approach) collapses that directory structure and breaks
 *    those lookups; mirroring the tree keeps every relative path exactly
 *    as valid after compilation as before it.
 * 2. Copy `schema/` and `dist/pi-bridge/` into the compiled tree at the
 *    same relative depth, for the same reason — these are real assets
 *    read from disk at runtime, not importable TS/JS.
 * 3. `@yao-pkg/pkg` packages the compiled entry into one native
 *    executable, then the result is renamed to Tauri's
 *    `<name>-<target-triple>` sidecar convention and copied into
 *    `src-tauri/binaries/`.
 *
 * `@clack/prompts`' ESM `exports` map fails to resolve inside pkg's
 * snapshot filesystem (a real, current `@yao-pkg/pkg` limitation, not
 * something this script works around) — fixed at the source instead:
 * `src/lib/terminalPicker.ts` now loads `@clack/prompts` lazily, inside
 * each interactive-picker function, rather than via a top-level import,
 * so the sidecar (whose `json: true` contract guarantees those functions
 * are never called) never triggers that resolution attempt. See that
 * file's own doc comment for the full explanation.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guiRoot = join(here, "..");
const repoRoot = join(guiRoot, "..", "..");
const distDir = join(guiRoot, "sidecar-dist");
const compiledDir = join(distDir, "compiled");

const TARGET_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
};
const PKG_TARGETS = {
  "darwin-arm64": "node22-macos-arm64",
  "darwin-x64": "node22-macos-x64",
};

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: cwd ?? guiRoot, stdio: "inherit" });
}

function main() {
  const platformArch = `${process.platform}-${process.arch}`;
  const triple = TARGET_TRIPLES[platformArch];
  const pkgTarget = PKG_TARGETS[platformArch];
  if (!triple || !pkgTarget) {
    throw new Error(`build-sidecar.mjs has no target-triple mapping for ${platformArch} yet (trellis-gui design.md Decision 5 scopes v1 to macOS) — extend TARGET_TRIPLES/PKG_TARGETS here when adding a platform.`);
  }

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(compiledDir, { recursive: true });

  run("npx", ["tsc", "-p", "sidecar/tsconfig.build.json"]);

  cpSync(join(repoRoot, "schema"), join(compiledDir, "schema"), { recursive: true });
  const piBridgeSrc = join(repoRoot, "dist", "pi-bridge");
  if (!existsSync(piBridgeSrc)) {
    throw new Error(`${piBridgeSrc} doesn't exist — run \`npm run build\` at the repo root first (it produces dist/pi-bridge/bundle.js, which src/adapters/pi.ts reads relative to its own compiled location at runtime).`);
  }
  cpSync(piBridgeSrc, join(compiledDir, "dist", "pi-bridge"), { recursive: true });

  const entry = join(compiledDir, "packages", "gui", "sidecar", "index.js");
  const pkgOutput = join(distDir, "trellis-gui-sidecar");
  const pkgConfig = join(distDir, "pkg.config.json");
  cpSync(join(here, "pkg.config.json"), pkgConfig);

  run("npx", [
    "--yes", "@yao-pkg/pkg", entry,
    "--targets", pkgTarget,
    "--output", pkgOutput,
    "--config", pkgConfig,
  ]);

  const binariesDir = join(guiRoot, "src-tauri", "binaries");
  mkdirSync(binariesDir, { recursive: true });
  const finalPath = join(binariesDir, `trellis-gui-sidecar-${triple}`);
  renameSync(pkgOutput, finalPath);
  execFileSync("chmod", ["+x", finalPath]);
  console.log(`Sidecar binary ready: ${finalPath}`);
}

main();
