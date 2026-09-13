#!/usr/bin/env node
/**
 * `--real` sandbox mode's prep step (trellis-real-sandbox-verification):
 * copies only `REAL_HOME_ALLOWLIST`'s paths (src/lib/realHomeSnapshot.ts)
 * from a real `$HOME` into a scratch directory, then refuses — no docker
 * build, nothing handed to `sandbox.sh` — if `trellis secrets audit`
 * finds anything in that copy. A snapshot that fails Trellis's own
 * existing secrets check has no business being containerized. Only ever
 * invoked by `scripts/sandbox.sh --real`, never by any unattended script
 * (npm test, CI) — copying a real machine's real dotfiles is always an
 * explicit, human-initiated action.
 */
import { buildRealHomeSnapshot } from "../src/lib/realHomeSnapshot.js";
import { collectInitReport } from "../src/commands/init.js";
import { runSecretsAudit } from "../src/commands/secretsAudit.js";

async function main(): Promise<void> {
  const [sourceHome, destHome] = process.argv.slice(2);
  if (!sourceHome || !destHome) {
    console.error("Usage: tsx scripts/prepare-real-sandbox.ts <sourceHome> <destHome>");
    process.exit(1);
  }

  const copied = buildRealHomeSnapshot(sourceHome, destHome);
  console.log(`Copied ${copied.length} allowlisted path(s) from ${sourceHome}:`);
  for (const rel of copied) console.log(`  ${rel}`);

  // Fills in only what's missing (trellis init's own contract) — never
  // overwrites a `.trellis/` this machine already had and just copied in.
  await collectInitReport(destHome);

  const { exitCode } = await runSecretsAudit({ homeDir: destHome });
  if (exitCode !== 0) {
    console.error("\nsecrets audit found something in this snapshot — refusing to hand it to the sandbox container.");
    process.exit(exitCode);
  }
  console.log("\nsecrets audit clean — snapshot ready.");
}

main();
