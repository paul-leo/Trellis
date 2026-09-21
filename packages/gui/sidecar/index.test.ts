import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { proveInternalImportsWork } from "./index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function home(): string { return mkdtempSync(join(tmpdir(), "trellis-gui-sidecar-")); }

test("sidecar: internal cross-workspace imports of agent-trellis's command modules work end to end", async () => {
  const homeDir = home();
  // Real `trellis init`, not a mock — this is exactly what tasks.md 1.3
  // asks to prove: a real workspace-relative import reaching real,
  // unmodified agent-trellis internals (design.md Decision 1), not a
  // stubbed or re-implemented copy of the canonical loader.
  execFileSync("npx", ["tsx", "src/cli.ts", "init"], { cwd: repoRoot, env: { ...process.env, HOME: homeDir }, stdio: "ignore" });

  const result = await proveInternalImportsWork(homeDir);
  assert.deepEqual(result, { doctorOk: true, syncOk: true });
});
