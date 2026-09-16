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
import { runMcpSync, runMcpList, runMcpAdd, runMcpRemove, parseMcpAddArgs } from "./commands/mcp.js";
import { parseMcpGatewayArgs, runMcpGateway } from "./commands/mcpGateway.js";
import { runMcpAuth } from "./commands/mcpAuth.js";
import { runSecretsAudit } from "./commands/secretsAudit.js";
import { runRollback } from "./commands/rollback.js";
import { runSkillList, runSkillAdd, runSkillRemove } from "./commands/skill.js";
import { runMemoryExtraction, runMemorySync } from "./commands/memory.js";
import { parseSyncArgs } from "./lib/syncArgs.js";

const KNOWN_COMMANDS = ["onboard", "init", "migrate", "doctor", "sync", "mcp", "mcp-gateway", "skill", "memory", "secrets", "rollback"] as const;

function printUsage(): void {
  console.log(`trellis - a single source of capability for every coding agent

Usage:
  trellis <command>

Commands:
  onboard   Guided flow: init -> detect agents -> pick a migration source ->
            pick which agents to manage -> migrate -> sync -> mcp sync ->
            secrets audit, in one command. Source (read from) and managed
            set (written to) are independent; the source is not managed
            by default.
              --agent <agent>       non-interactive migration-source
                                    choice (required with 2+ candidates
                                    and no terminal to prompt in)
              --manage <ids|none>   non-interactive managed-set choice,
                                    e.g. --manage pi,codex ; --manage none
                                    means "add nothing new this run"
                                    (required with no terminal to prompt
                                    in, e.g. --json)
              --dry-run             preview the whole flow, write nothing
              --json                machine-readable output, no report text
  init      Create ~/.trellis/ with a minimal valid skeleton if missing
              (never overwrites an existing file — fills in only what's
              missing) and prints which agents are present
              --json    machine-readable output, no report text
  migrate --from <agent>
            Import an existing agent's real skills/instructions/MCP
            servers into canonical source (claude-code | codex | kiro |
            pi — pi has no static MCP config, mcp migrate-in is a no-op
            for it). Never overwrites differing content — reports a
            conflict instead.
              --only skills|instructions|mcp   restrict to one category
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
              (create/repair, plus ownership-ledger-gated removal — an
              entry is only ever removed when it's still exactly what
              Trellis itself last wrote there; see docs/roadmap.md)
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  mcp list  List canonical MCP servers (transport, scope, enabled;
              never prints resolved secret values)
              --json    machine-readable output, no report text
  mcp add <name> --transport stdio|http|sse ...
            Add a canonical MCP server (refuses on an existing name,
              no overwrite): --command <cmd> [--args a,b] (stdio) or
              --url <url> (http/sse); [--headers k=v,...]
              [--env NAME,...] [--static-env k=v,...] [--agents id,...]
              [--enabled true|false]
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  mcp auth <server-name>
            Authorize a remote (http/sse) MCP server that uses OAuth —
              opens a browser once, stores the result 0600 under
              ~/.trellis/mcp/oauth/. A still-valid token is a no-op; an
              expired one is refreshed without a browser. The gateway
              refreshes silently on its own and never prompts.
              --force   re-authorize even if the stored token is valid
              --json    machine-readable output, no report text
  mcp remove <name>
            Remove a canonical MCP server (canonical-side only — does
              not touch any agent's already-synced native config)
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  skill list
            List canonical skills with resolved scope
              --json    machine-readable output, no report text
  skill add <name> --from <path>
            Import a real skill directory into canonical (refuses on
              an existing name with different content, no overwrite)
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  skill remove <name>
            Remove a canonical skill (the next sync auto-removes the
              now-stale symlink on every managed agent)
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  memory sync
            Ingest canonical memories/*.md into the shared-memory MCP
              server's own on-disk knowledge-graph file (requires a
              "memory" server with static_env.MEMORY_FILE_PATH set in
              servers.yaml — see schema/servers.example.yaml; a no-op,
              not an error, if unconfigured). Never touches an entity
              or relation this didn't create.
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  memory extract
            The reverse direction: read the same graph file's real,
              non-Trellis entities (agent-accumulated content, never
              Trellis's own) and write each as a new canonical
              memories/*.md file — readable markdown, not meant to
              round-trip byte-for-byte back through memory sync.
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  secrets audit
            Scan each present agent's real MCP config for leaked
            credentials and unexpected env var names
              --json    machine-readable output, no report text
  rollback [<run-id>]
            Undo one recorded sync/mcp-sync/onboard run (every real write
              it performed is backed up first, under
              ~/.trellis/backups/) — omit <run-id> for the most recent
              run. Refuses per-path (a conflict, not overwritten) if the
              path changed since that run.
              --list       show available backup runs, don't restore
              --dry-run    preview what would be restored, write nothing
              --json       machine-readable output, no report text

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
    const manageIndex = rest.indexOf("--manage");
    const manage = manageIndex >= 0 ? rest[manageIndex + 1] : undefined;
    const { exitCode } = await runOnboard({ agent, manage, dryRun: rest.includes("--dry-run"), json: rest.includes("--json") });
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
    const onlyIndex = rest.indexOf("--only");
    const only = onlyIndex >= 0 ? rest[onlyIndex + 1] : undefined;
    const { exitCode } = await runMigrate({ from, only, dryRun: rest.includes("--dry-run"), json: rest.includes("--json") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "doctor") {
    const { exitCode } = await runDoctor({ json: rest.includes("--json"), probeMcp: rest.includes("--probe-mcp") });
    process.exitCode = exitCode;
    return;
  }

  // Spawned by an agent, never typed by a person: stdout is the MCP
  // protocol stream for the rest of this process's life, so nothing here
  // may print to it (trellis-mcp-gateway-hosting design.md D2).
  if (command === "mcp-gateway") {
    const parsed = parseMcpGatewayArgs(rest);
    if ("error" in parsed) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    const { exitCode } = await runMcpGateway({ agentId: parsed.agentId });
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
    const [subcommand, ...mcpRest] = rest;
    const json = mcpRest.includes("--json");
    const dryRun = mcpRest.includes("--dry-run");

    if (subcommand === "sync") {
      const { exitCode } = await runMcpSync({ json, dryRun });
      process.exitCode = exitCode;
      return;
    }
    if (subcommand === "list") {
      process.exitCode = runMcpList({ json }).exitCode;
      return;
    }
    if (subcommand === "add") {
      const [name] = mcpRest;
      process.exitCode = runMcpAdd(name, parseMcpAddArgs(mcpRest), { json, dryRun }).exitCode;
      return;
    }
    if (subcommand === "remove") {
      const [name] = mcpRest;
      if (!name) {
        console.error("Usage: trellis mcp remove <name>");
        process.exitCode = 1;
        return;
      }
      process.exitCode = runMcpRemove(name, { json, dryRun }).exitCode;
      return;
    }

    if (subcommand === "auth") {
      const [serverName] = mcpRest;
      if (!serverName || serverName.startsWith("--")) {
        console.error("Usage: trellis mcp auth <server-name>");
        process.exitCode = 1;
        return;
      }
      const { exitCode } = await runMcpAuth({ serverName, force: mcpRest.includes("--force"), json });
      process.exitCode = exitCode;
      return;
    }

    console.error(`Unknown mcp subcommand: ${subcommand ?? "(none)"}\nUsage: trellis mcp sync|list|add <name>|remove <name>|auth <name>\n`);
    process.exitCode = 1;
    return;
  }

  if (command === "skill") {
    const [subcommand, ...skillRest] = rest;
    const json = skillRest.includes("--json");
    const dryRun = skillRest.includes("--dry-run");

    if (subcommand === "list") {
      process.exitCode = runSkillList({ json }).exitCode;
      return;
    }
    if (subcommand === "add") {
      const [name] = skillRest;
      const fromIndex = skillRest.indexOf("--from");
      const from = fromIndex >= 0 ? skillRest[fromIndex + 1] : undefined;
      if (!name || !from) {
        console.error("Usage: trellis skill add <name> --from <path>");
        process.exitCode = 1;
        return;
      }
      process.exitCode = runSkillAdd(name, from, { json, dryRun }).exitCode;
      return;
    }
    if (subcommand === "remove") {
      const [name] = skillRest;
      if (!name) {
        console.error("Usage: trellis skill remove <name>");
        process.exitCode = 1;
        return;
      }
      process.exitCode = runSkillRemove(name, { json, dryRun }).exitCode;
      return;
    }
    console.error(`Unknown skill subcommand: ${subcommand ?? "(none)"}\nUsage: trellis skill list|add <name> --from <path>|remove <name>\n`);
    process.exitCode = 1;
    return;
  }

  if (command === "memory") {
    const [subcommand, ...memoryRest] = rest;
    const json = memoryRest.includes("--json");
    const dryRun = memoryRest.includes("--dry-run");
    if (subcommand === "sync") {
      process.exitCode = runMemorySync({ json, dryRun }).exitCode;
      return;
    }
    if (subcommand === "extract") {
      process.exitCode = runMemoryExtraction({ json, dryRun }).exitCode;
      return;
    }
    console.error(`Unknown memory subcommand: ${subcommand ?? "(none)"}\nUsage: trellis memory sync|extract\n`);
    process.exitCode = 1;
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

  if (command === "rollback") {
    const list = rest.includes("--list");
    const dryRun = rest.includes("--dry-run");
    const json = rest.includes("--json");
    const runId = rest.find((arg) => !arg.startsWith("--"));
    const { exitCode } = await runRollback({ runId, list, dryRun, json });
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
