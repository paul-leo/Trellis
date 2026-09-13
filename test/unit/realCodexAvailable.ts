/**
 * Shared by codexProbe.test.ts and migrateSources.test.ts — both spawn
 * the real, locally-installed `codex` binary deliberately (this
 * project's own "verify against real tooling, not fixtures" discipline).
 * That binary is a real, optional external dependency of the *test
 * environment*, not of Trellis itself — a machine without it installed
 * must see these specific tests skip with a clear reason, not fail with
 * a misleading assertion mismatch (empty results, not a thrown error,
 * since every caller here already tolerates a missing binary as "no MCP
 * servers").
 */
import { execFileSync } from "node:child_process";

let cached: boolean | undefined;

export function isCodexAvailable(): boolean {
  if (cached === undefined) {
    try {
      execFileSync("codex", ["--version"], { stdio: "ignore", timeout: 5_000 });
      cached = true;
    } catch {
      cached = false;
    }
  }
  return cached;
}

export const SKIP_NO_CODEX = isCodexAvailable() ? false : "codex CLI is not installed on this machine — these tests exercise the real binary, not a fixture";
