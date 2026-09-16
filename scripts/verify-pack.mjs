#!/usr/bin/env node
/**
 * Installs the real, publishable npm tarball into an isolated scratch
 * directory (no devDependencies — the same as any real consumer's
 * `npm install`) and runs the built CLI against it.
 *
 * Why this exists and `npm test` can't replace it: `tsx --test` resolves
 * every import against this repo's own full `node_modules`, which has
 * both `dependencies` and `devDependencies` installed — so a package
 * declared in the wrong section is invisible to every test, typecheck,
 * and build run in dev. It only breaks the moment someone else installs
 * the published package, which strips devDependencies. That's exactly
 * how v0.6.2 shipped with `@modelcontextprotocol/sdk` only in
 * devDependencies: `src/commands/mcpGateway.ts` imports it at runtime,
 * `cli.ts` imports `mcpGateway.ts` unconditionally, so every
 * globally-installed `trellis` invocation crashed with
 * `ERR_MODULE_NOT_FOUND` — while every check in this repo's own CI/dev
 * tree passed cleanly (see git history for the fix). Run automatically
 * as part of `prepublishOnly`, so a missing runtime dependency can no
 * longer reach npm silently.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf-8", ...opts });
}

/** A bare CLI invocation already forces every static top-level import
 * `cli.ts` makes (including every subcommand module) to resolve before a
 * single line of its body runs — that alone is what would have caught
 * v0.6.2's bug. `doctor --json` and `onboard --json` are included too,
 * as cheap insurance against a future *lazy* (`await import()`) module
 * this bare-invocation check wouldn't otherwise exercise. */
const SMOKE_COMMANDS = [[], ["doctor", "--json"], ["onboard", "--json"]];

const CRASH_SIGNATURE = /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|ERR_UNSUPPORTED_ESM_URL_SCHEME/;

console.log("[verify-pack] packing the real publishable tarball...");
const packOutput = run("npm", ["pack", "--silent"]);
const tarballName = packOutput.trim().split("\n").pop();
const tarballPath = join(repoRoot, tarballName);

const installDir = mkdtempSync(join(tmpdir(), "trellis-verify-pack-"));
const scratchHome = mkdtempSync(join(tmpdir(), "trellis-verify-pack-home-"));

let failed = false;
try {
  console.log(`[verify-pack] installing ${tarballName} into an isolated dir (no devDependencies, same as a real consumer)...`);
  run("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", installDir, tarballPath]);

  const cliPath = join(installDir, "node_modules", "agent-trellis", "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`expected ${cliPath} to exist after install — package.json's "files" field may be missing something`);
  }

  for (const args of SMOKE_COMMANDS) {
    const label = `trellis ${args.join(" ")}`.trim() || "trellis (no args)";
    console.log(`[verify-pack] running: ${label}`);
    let output;
    try {
      output = execFileSync("node", [cliPath, ...args], {
        cwd: installDir,
        encoding: "utf-8",
        env: { ...process.env, HOME: scratchHome },
      });
    } catch (err) {
      // A non-zero exit is fine (e.g. onboard reporting no agents present)
      // — only a module-resolution crash is what this check exists to
      // catch, and that shows up in stdout/stderr either way.
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    if (CRASH_SIGNATURE.test(output)) {
      console.error(`[verify-pack] ❌ ${label} failed to resolve a module:\n${output}`);
      failed = true;
    }
  }

  if (failed) {
    throw new Error("verify-pack: the published tarball is broken for a real consumer — see the module-resolution failure(s) above");
  }
  console.log("[verify-pack] ✅ the real tarball installs and runs cleanly with devDependencies excluded.");
} finally {
  rmSync(tarballPath, { force: true });
  rmSync(installDir, { recursive: true, force: true });
  rmSync(scratchHome, { recursive: true, force: true });
}
