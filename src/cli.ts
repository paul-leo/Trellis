#!/usr/bin/env node
/**
 * Entry point. Only `doctor` (P0) is implemented — see docs/roadmap.md for
 * the rest. This stays a thin dispatcher; real logic lives in
 * src/commands/*.ts so it stays testable without going through argv.
 */

import { runDoctor } from "./commands/doctor.js";

const KNOWN_COMMANDS = ["doctor", "sync", "mcp", "secrets"] as const;

function printUsage(): void {
  console.log(`trellis - a single source of capability for every coding agent

Usage:
  trellis <command>

Commands:
  doctor    Scan Claude Code / Codex / Kiro / pi for drift
              --json         machine-readable output, no table text
              --probe-mcp    also handshake every configured MCP server
                             (off by default — spawns real processes,
                             some reaching real external services)
  sync      Distribute skills/instructions to each agent (not yet implemented)
  mcp       Manage the canonical MCP server list (not yet implemented)
  secrets   Audit adapter output for leaked credentials (not yet implemented)

See docs/roadmap.md for what's built vs. planned.`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === "doctor") {
    const { exitCode } = await runDoctor({ json: rest.includes("--json"), probeMcp: rest.includes("--probe-mcp") });
    process.exitCode = exitCode;
    return;
  }

  console.error(
    `\`trellis ${command}\` is not implemented yet — this is a pre-alpha scaffold.\nSee docs/roadmap.md for status.`,
  );
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
