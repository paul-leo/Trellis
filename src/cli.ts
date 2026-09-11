#!/usr/bin/env node
/**
 * Pre-alpha entry point. No command does real work yet — see
 * docs/roadmap.md. This stub exists so the package structure (bin, adapter
 * contract, canonical types) is real and typechecked from day one, instead
 * of arriving all at once with the first feature.
 */

const KNOWN_COMMANDS = ["doctor", "sync", "mcp", "secrets"] as const;

function printUsage(): void {
  console.log(`trellis - a single source of capability for every coding agent

Usage:
  trellis <command>

Commands:
  doctor    Scan Claude Code / Codex / Kiro / pi for drift (not yet implemented)
  sync      Distribute skills/instructions to each agent (not yet implemented)
  mcp       Manage the canonical MCP server list (not yet implemented)
  secrets   Audit adapter output for leaked credentials (not yet implemented)

See docs/roadmap.md for what's built vs. planned.`);
}

function main(argv: string[]): void {
  const [command] = argv;

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

  console.error(
    `\`trellis ${command}\` is not implemented yet — this is a pre-alpha scaffold.\nSee docs/roadmap.md for status.`,
  );
  process.exitCode = 1;
}

main(process.argv.slice(2));
