#!/usr/bin/env node
/**
 * Entry point. Stays a thin dispatcher; real logic lives in
 * src/commands/*.ts so it stays testable without going through argv. See
 * docs/roadmap.md for what's implemented.
 */

import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runOnboard } from "./commands/onboard.js";
import { runSync } from "./commands/sync.js";
import { runMcpSync } from "./commands/mcp.js";
import { runSecretsAudit } from "./commands/secretsAudit.js";
import { parseSyncArgs } from "./lib/syncArgs.js";

const KNOWN_COMMANDS = ["onboard", "init", "migrate", "doctor", "sync", "mcp", "secrets"] as const;

function printUsage(): void {
  console.log(`trellis - a single source of capability for every coding agent

Usage:
  trellis <command>

Commands:
  onboard   Guided flow: init -> detect agents -> pick a base agent ->
            migrate -> sync, in one command
              --agent <agent>    non-interactive base-agent choice
                                 (required with 2+ agents present and
                                 no terminal to prompt in, e.g. --json)
              --dry-run          preview the whole flow, write nothing
              --json             machine-readable output, no report text
  init      Create ~/.trellis/ with a minimal valid skeleton if missing
              (never overwrites an existing file — fills in only what's
              missing) and prints which agents are present
              --json    machine-readable output, no report text
  migrate --from <agent>
            Import an existing agent's real skills/instructions into
            canonical source (claude-code | codex | kiro | pi). Never
            overwrites differing content — reports a conflict instead.
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  doctor    Scan Claude Code / Codex / Kiro / pi for drift
              --json         machine-readable output, no table text
              --probe-mcp    also handshake every configured MCP server
                             (off by default — spawns real processes,
                             some reaching real external services)
  sync [skills|instructions]
            Distribute skills/instructions to each agent (omit target for both)
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  mcp sync  Distribute MCP servers to each agent's native config
              (create/repair only — no automatic removal, see docs/roadmap.md)
              --json    machine-readable output, no report text
  secrets audit
            Scan each present agent's real MCP config for leaked
            credentials and unexpected env var names
              --json    machine-readable output, no report text

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

  if (command === "onboard") {
    const agentIndex = rest.indexOf("--agent");
    const agent = agentIndex >= 0 ? rest[agentIndex + 1] : undefined;
    const { exitCode } = await runOnboard({ agent, dryRun: rest.includes("--dry-run"), json: rest.includes("--json") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "init") {
    const { exitCode } = await runInit({ json: rest.includes("--json") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "migrate") {
    const fromIndex = rest.indexOf("--from");
    const from = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
    const { exitCode } = await runMigrate({ from, dryRun: rest.includes("--dry-run"), json: rest.includes("--json") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "doctor") {
    const { exitCode } = await runDoctor({ json: rest.includes("--json"), probeMcp: rest.includes("--probe-mcp") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "sync") {
    const { target, unknownArg } = parseSyncArgs(rest);
    if (unknownArg) {
      console.error(`Unknown sync target: ${unknownArg}\n`);
      printUsage();
      process.exitCode = 1;
      return;
    }
    const { exitCode } = await runSync({ target, json: rest.includes("--json"), dryRun: rest.includes("--dry-run") });
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

  if (command === "secrets") {
    const [subcommand] = rest;
    if (subcommand !== "audit") {
      console.error(`Unknown secrets subcommand: ${subcommand ?? "(none)"}\nUsage: trellis secrets audit\n`);
      process.exitCode = 1;
      return;
    }
    const { exitCode } = await runSecretsAudit({ json: rest.includes("--json") });
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
