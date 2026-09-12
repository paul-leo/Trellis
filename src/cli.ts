#!/usr/bin/env node
/**
 * Entry point. Only `doctor` (P0) is implemented — see docs/roadmap.md for
 * the rest. This stays a thin dispatcher; real logic lives in
 * src/commands/*.ts so it stays testable without going through argv.
 */

import { runDoctor } from "./commands/doctor.js";
import { runSync } from "./commands/sync.js";
import { runMcpSync } from "./commands/mcp.js";

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
  sync [skills|instructions]
            Distribute skills/instructions to each agent (omit target for both)
              --json    machine-readable output, no report text
  mcp sync  Distribute MCP servers to each agent's native config
              (create/repair only — no automatic removal, see docs/roadmap.md)
              --json    machine-readable output, no report text
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

  if (command === "sync") {
    const [maybeTarget] = rest;
    const target = maybeTarget === "skills" || maybeTarget === "instructions" ? maybeTarget : undefined;
    if (maybeTarget && !target && maybeTarget !== "--json") {
      console.error(`Unknown sync target: ${maybeTarget}\n`);
      printUsage();
      process.exitCode = 1;
      return;
    }
    const { exitCode } = await runSync({ target, json: rest.includes("--json") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "mcp") {
    const [subcommand] = rest;
    if (subcommand !== "sync") {
      console.error(`Unknown mcp subcommand: ${subcommand ?? "(none)"}\nUsage: trellis mcp sync\n`);
      process.exitCode = 1;
      return;
    }
    const { exitCode } = await runMcpSync({ json: rest.includes("--json") });
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
