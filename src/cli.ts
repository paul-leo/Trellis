#!/usr/bin/env node
/**
 * Entry point. Stays a thin dispatcher; real logic lives in
 * src/commands/*.ts so it stays testable without going through argv. See
 * docs/roadmap.md for what's implemented.
 */

import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runMigrateWorkspace } from "./commands/migrateWorkspace.js";
import { runOnboard } from "./commands/onboard.js";
import { runSync } from "./commands/sync.js";
import { runMcpSync, runMcpList, runMcpAdd, runMcpRemove, runMcpSetAuth, runMcpScope, parseMcpAddArgs, parseMcpSetArgs } from "./commands/mcp.js";
import { parseScopeArgs } from "./lib/scopeSelection.js";
import { runMcpImport } from "./commands/mcpImport.js";
import { parseMcpGatewayArgs, runMcpGateway, runMcpRuntime } from "./commands/mcpGateway.js";
import { runMcpAuth } from "./commands/mcpAuth.js";
import { runMcpRenew } from "./commands/mcpRenew.js";
import { runSecretsAudit } from "./commands/secretsAudit.js";
import { runRollback } from "./commands/rollback.js";
import { runSkillList, runSkillAdd, runSkillRemove, runSkillScope, runSkillUpdateBuiltin } from "./commands/skill.js";
import { runRemoteSkillAdd, runRemoteSkillList, runRemoteSkillUpdate } from "./commands/remoteSkill.js";
import { collectMemoryList, runMemoryExtraction, runMemorySync } from "./commands/memory.js";
import { parseManageArgs, runManage } from "./commands/manage.js";
import { runKimi } from "./commands/kimi.js";
import { TRELLIS_VERSION } from "./lib/cliMetadata.js";
import { flagValue } from "./lib/cliArgs.js";
import { parseSyncArgs } from "./lib/syncArgs.js";

const KNOWN_COMMANDS = ["onboard", "init", "migrate", "doctor", "sync", "mcp", "mcp-gateway", "mcp-runtime", "skill", "add", "update", "memory", "manage", "kimi", "secrets", "rollback"] as const;

function printUsage(): void {
  console.log(`trellis - a single source of capability for every coding agent

Usage:
  trellis <command>
  trellis --version
  trellis --help

Options:
  -v, --version    print the installed Trellis version
  -h, --help       show this help

Commands:
  help      Show this help
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
              --mcp-mode <direct|hub|gateway>
                                    direct = Agent 分别直连；gateway =
                                    Trellis 本机统一托管（推荐）；hub =
                                    连接已有的外部 MCP Hub
              --hub-url <url>       required with --mcp-mode hub; Trellis
                                    does not deploy an external Hub
              --gateway-agents <ids>
                                    optional with --mcp-mode gateway;
                                    omit for every managed agent
              --memory <on|off>     enable/disable the shared memory MCP
                                    server; omit to leave it untouched
              --memory-migrate <on|off>
                                    import supported native Agent memory into
                                    canonical; omit to leave it untouched
              --selection <file>   item-level YAML/JSON selection for skills,
                                    MCP servers, memories, and per-agent routes
              --dry-run             preview the whole flow, write nothing
              --json                machine-readable output, no report text
  init      Create ~/.trellis/ with a minimal valid skeleton if missing
              (never overwrites an existing file — fills in only what's
              missing) and prints which agents are present
              --json    machine-readable output, no report text
              --workspace  scaffold .agents/ in the current project instead
  migrate --from <agent>
            Import an existing agent's real skills/instructions/MCP/memory
            servers into canonical source (claude-code | codex | kiro |
            pi — pi has no static MCP config, mcp migrate-in is a no-op
            for it). Never overwrites differing content — reports a
            conflict instead.
            --only skills|instructions|mcp|memory
                                    restrict to one category
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  migrate --workspace
            Absorb the repo's existing project-level agent config (all six
            agents' MCP files + root AGENTS.md) into .agents/, then
            re-render. Plaintext secrets are intercepted into the global
            secret store as \${VAR} references, never written under
            .agents/; *.local.* files are listed, never read.
              --choose name=agentId   pick a side for a cross-agent conflict
              --dedup drop|override   identical-to-global entries: skip
                                      (default) or import as an intentional
                                      shadow
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
  add <github-source> --skill <name>
            Import one GitHub-hosted Skill into ~/.trellis/skills/, record
            immutable provenance, then sync it only to managed Agents.
              --skill, -s <name>       required unless --list
              --branch <ref>           Git branch, tag, or ref; default is
                                       the source repository's default branch
              --agent, -a <ids|*>      restrict delivery to managed Agent ids
              --list                   show discovered Skills without import
              --global, --yes          accepted skills-CLI compatibility flags
              --dry-run                fetch and preview; write nothing
              --json                   machine-readable output
  update [skills...]
            Safely refresh remotely tracked Skills. Refuses to overwrite a
            canonical Skill edited since its recorded import.
              --dry-run    preview writes only
              --json       machine-readable output
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
            [--auth oauth] [--env NAME,...] [--static-env k=v,...] [--agents id,...]
            [--workspace]  write to .agents/config.json instead of servers.yaml
            [--enabled true|false]
            --dry-run    preview the plan, write nothing
            --json       machine-readable output, no report text
  mcp import <json-file>
            Import a standard mcpServers JSON export without changing the
            source; extracts credential env values into the ignored local
            secret file, de-duplicates, and reports conflicts
            --dry-run    preview without writing
            --json       machine-readable output, no report text
  mcp set <name> --auth oauth|none
            Set or clear explicit OAuth classification; canonical only.
            --auth oauth [--auth-owner agent|trellis] [--client-id <id>] [--client-secret-env <NAME>]
                         pre-register a client for a provider that refuses
                         dynamic registration. --client-id is the PROVIDER's
                         published identifier (public by design);
                         --client-secret-env is a variable NAME resolved via
                         secrets.policy.yaml, never a secret value.
                         A bare --auth oauth keeps existing client metadata;
                         --auth none removes it along with the classification.
            --dry-run    preview the plan, write nothing
            --json       machine-readable output, no report text
  mcp scope <name> --agents <ids> | --all | --none
            Choose which managed agents reach a canonical MCP server, then
            run the same sync as mcp sync. Exactly one selector is
            required; ids must be managed agents. Selecting every managed
            agent records no explicit scope, so a newly managed agent is
            included. An entry Trellis did not write is never removed.
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  mcp auth <server-name>
            Authorize a remote (http/sse) MCP server that uses OAuth —
              opens a browser once, stores the result 0600 under
              ~/.trellis/mcp/oauth/. A still-valid token is a no-op; an
              expired one is refreshed without a browser. If the refresh
              grant is rejected, this command starts a new login. The gateway
              refreshes silently on its own and never prompts.
              --force   re-authorize even if the stored token is valid
              --json    machine-readable output, no report text
  mcp renew
            Silently refresh every Trellis-owned stored OAuth token that
              needs it —
              never opens a browser, never performs an initial grant.
              Reports per-server health and exits non-zero when any
              classified server needs 'mcp auth'. Safe under a scheduler
              (launchd): idempotent on valid tokens, refreshes serialized
              per server, overlapping runs degrade to one refresh.
              --dry-run  report status without any token-endpoint call
              --json     machine-readable output, no report text
  mcp-runtime --agent <agent>
            Internal MCP edge exposing Trellis providers and selected
            upstream capabilities; existing mcp-gateway configs remain valid
            as a compatibility alias
  mcp remove <name>
            Remove a canonical MCP server, then run the same sync as
            mcp sync so every managed agent's Trellis-owned entry for
            it is removed too
              --workspace  remove from .agents/config.json instead of
                           servers.yaml (a shadowed global entry takes
                           effect again, it is not deleted)
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  skill list
            List canonical skills with resolved scope
              --json    machine-readable output, no report text
  skill add <name> --from <path>
            Import a real skill directory into canonical (refuses on
              an existing name with different content, no overwrite)
              --workspace  copy into .agents/skills/ instead of canonical
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  skill remove <name>
  skill scope <name> --agents <ids> | --all | --none
            Choose which managed agents receive a canonical skill, then
            sync it. Same selector rules as mcp scope; a built-in skill's
            scope is not editable
              --dry-run    preview the plan, write nothing
              --json       machine-readable output, no report text
  skill update-builtin
            Refresh the package-owned trellis-runtime Skill in canonical
            source; existing native symlinks see the update
            --dry-run    preview without writing
            --json       machine-readable output, no report text
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
  manage list
            Show the canonical managed-agent write boundary.
  manage set <ids|none>
  manage add <ids>
  manage remove <ids>
            Explicitly replace, extend, or narrow the managed set. Removing
              an agent preserves its existing native state; future Trellis
              writes stop reaching it. Mutations are backup/rollback-enabled.
              --dry-run    preview current -> desired, write nothing
              --json       machine-readable output
  kimi [args...]
            Launch Kimi Code. When kimi-code Runtime delivery is \`mcp\`,
            starts Kimi with an empty --skills-dir so Skills come from
            trellis-runtime instead of native discovery.
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

function printVersion(): void {
  console.log(TRELLIS_VERSION);
}

function remoteOptionValues(args: readonly string[], flags: readonly string[]): { values: string[]; error?: string; positions: Set<number> } {
  const values: string[] = [];
  const positions = new Set<number>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const matching = flags.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (!matching) continue;
    positions.add(index);
    if (arg.startsWith(`${matching}=`)) {
      values.push(arg.slice(matching.length + 1));
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("-")) return { values, positions, error: `${matching} needs a value` };
    positions.add(index + 1);
    values.push(value);
    index += 1;
  }
  return { values, positions };
}

function remotePositionals(args: readonly string[], consumed: ReadonlySet<number>): string[] {
  return args.filter((arg, index) => !consumed.has(index) && !arg.startsWith("-"));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  if (command === "help") {
    printUsage();
    return;
  }

  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  // `--help`/`-h` anywhere in a subcommand's own args short-circuits before
  // any parsing or real action — a typo'd or exploratory flag (e.g. `mcp
  // sync --help`) must never fall through to actually running the command
  // it was asking about (real incident: `--help` isn't a flag any branch
  // recognizes, so it silently ran a real, non-dry-run `mcp sync`).
  if (command !== "kimi" && (rest.includes("--help") || rest.includes("-h"))) {
    printUsage();
    return;
  }

  if (command === "onboard") {
    const { exitCode } = await runOnboard({
      agent: flagValue(rest, "--agent"),
      manage: flagValue(rest, "--manage"),
      mcpMode: flagValue(rest, "--mcp-mode"),
      hubUrl: flagValue(rest, "--hub-url"),
      gatewayAgents: flagValue(rest, "--gateway-agents"),
      memory: flagValue(rest, "--memory"),
      memoryMigrate: flagValue(rest, "--memory-migrate"),
      selectionFile: flagValue(rest, "--selection"),
      dryRun: rest.includes("--dry-run"),
      json: rest.includes("--json"),
    });
    process.exitCode = exitCode;
    return;
  }

  if (command === "init") {
    const { exitCode } = await runInit({ json: rest.includes("--json"), workspace: rest.includes("--workspace") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "migrate") {
    if (rest.includes("--workspace")) {
      // Repeated `--choose name=agentId` flags collect into an array.
      const choose: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--choose" && rest[i + 1] !== undefined) choose.push(rest[i + 1]);
      }
      const { exitCode } = await runMigrateWorkspace({
        choose,
        dedup: flagValue(rest, "--dedup"),
        dryRun: rest.includes("--dry-run"),
        json: rest.includes("--json"),
      });
      process.exitCode = exitCode;
      return;
    }
    const { exitCode } = await runMigrate({ from: flagValue(rest, "--from"), only: flagValue(rest, "--only"), dryRun: rest.includes("--dry-run"), json: rest.includes("--json") });
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
  if (command === "mcp-gateway" || command === "mcp-runtime") {
    const parsed = parseMcpGatewayArgs(rest);
    if ("error" in parsed) {
      console.error(parsed.error);
      process.exitCode = 1;
      return;
    }
    const { exitCode } = command === "mcp-runtime"
      ? await runMcpRuntime({ agentId: parsed.agentId })
      : await runMcpGateway({ agentId: parsed.agentId });
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
    const { exitCode } = await runSync({ target, json: rest.includes("--json"), dryRun: rest.includes("--dry-run"), check: rest.includes("--check"), globalOnly: rest.includes("--global-only") });
    process.exitCode = exitCode;
    return;
  }

  if (command === "add") {
    const skill = remoteOptionValues(rest, ["--skill", "-s"]);
    const branch = remoteOptionValues(rest, ["--branch"]);
    const agents = remoteOptionValues(rest, ["--agent", "-a"]);
    const consumed = new Set([...skill.positions, ...branch.positions, ...agents.positions]);
    const positionals = remotePositionals(rest, consumed);
    const json = rest.includes("--json");
    const prohibited = rest.find((arg) => /^(--copy|--project|--local)(?:=|$)/.test(arg));
    if (prohibited) {
      const detail = "Trellis remote Skills are always imported into ~/.trellis/skills; --copy and project-local installation are not supported.";
      if (json) console.log(JSON.stringify({ action: "invalid-options", detail }, null, 2)); else console.error(detail);
      process.exitCode = 1;
      return;
    }
    if (skill.error || branch.error || agents.error || positionals.length !== 1) {
      const detail = skill.error ?? branch.error ?? agents.error ?? "Usage: trellis add <github-source> --skill <name>";
      if (json) console.log(JSON.stringify({ action: "invalid-options", detail }, null, 2)); else console.error(detail);
      process.exitCode = 1;
      return;
    }
    const source = positionals[0];
    if (rest.includes("--list")) {
      process.exitCode = (await runRemoteSkillList(source, { branch: branch.values[0], json })).exitCode;
      return;
    }
    if (skill.values.length !== 1 || branch.values.length > 1) {
      const detail = skill.values.length !== 1 ? "Use exactly one --skill value" : "Use at most one --branch value";
      if (json) console.log(JSON.stringify({ action: "invalid-options", detail }, null, 2)); else console.error(detail);
      process.exitCode = 1;
      return;
    }
    process.exitCode = (await runRemoteSkillAdd(source, skill.values[0], {
      branch: branch.values[0], agents: agents.values, dryRun: rest.includes("--dry-run"), json,
    })).exitCode;
    return;
  }

  if (command === "update") {
    const json = rest.includes("--json");
    const names = rest.filter((arg) => !arg.startsWith("-"));
    process.exitCode = (await runRemoteSkillUpdate(names, { dryRun: rest.includes("--dry-run"), json })).exitCode;
    return;
  }

  if (command === "mcp") {
    const [subcommand, ...mcpRest] = rest;
    const json = mcpRest.includes("--json");
    const dryRun = mcpRest.includes("--dry-run");

    if (subcommand === "sync") {
      const { exitCode } = await runMcpSync({ json, dryRun, check: mcpRest.includes("--check"), globalOnly: mcpRest.includes("--global-only") });
      process.exitCode = exitCode;
      return;
    }
    if (subcommand === "list") {
      process.exitCode = runMcpList({ json }).exitCode;
      return;
    }
    if (subcommand === "add") {
      const [name] = mcpRest;
      process.exitCode = (await runMcpAdd(name, parseMcpAddArgs(mcpRest), { json, dryRun, workspace: mcpRest.includes("--workspace") })).exitCode;
      return;
    }
    if (subcommand === "import") {
      const [file] = mcpRest;
      process.exitCode = (await runMcpImport(file, { json, dryRun })).exitCode;
      return;
    }
    if (subcommand === "set") {
      const [name] = mcpRest;
      process.exitCode = runMcpSetAuth(name, parseMcpSetArgs(mcpRest), { json, dryRun }).exitCode;
      return;
    }
    if (subcommand === "scope") {
      const [name] = mcpRest;
      process.exitCode = (await runMcpScope(name && !name.startsWith("--") ? name : undefined, parseScopeArgs(mcpRest), { json, dryRun })).exitCode;
      return;
    }
    if (subcommand === "remove") {
      const [name] = mcpRest;
      if (!name) {
        console.error("Usage: trellis mcp remove <name>");
        process.exitCode = 1;
        return;
      }
      process.exitCode = (await runMcpRemove(name, { json, dryRun, workspace: mcpRest.includes("--workspace") })).exitCode;
      return;
    }

    if (subcommand === "renew") {
      const { exitCode } = await runMcpRenew({ json, dryRun });
      process.exitCode = exitCode;
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

    console.error(`Unknown mcp subcommand: ${subcommand ?? "(none)"}\nUsage: trellis mcp sync|list|add <name>|set <name>|scope <name>|remove <name>|auth <name>|renew\n`);
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
      const from = flagValue(skillRest, "--from");
      if (!name || !from) {
        console.error("Usage: trellis skill add <name> --from <path>");
        process.exitCode = 1;
        return;
      }
      process.exitCode = (await runSkillAdd(name, from, { json, dryRun, workspace: skillRest.includes("--workspace") })).exitCode;
      return;
    }
    if (subcommand === "remove") {
      const [name] = skillRest;
      if (!name) {
        console.error("Usage: trellis skill remove <name>");
        process.exitCode = 1;
        return;
      }
      process.exitCode = (await runSkillRemove(name, { json, dryRun })).exitCode;
      return;
    }
    if (subcommand === "scope") {
      const [name] = skillRest;
      process.exitCode = (await runSkillScope(name && !name.startsWith("--") ? name : undefined, parseScopeArgs(skillRest), { json, dryRun })).exitCode;
      return;
    }
    if (subcommand === "update-builtin") {
      process.exitCode = runSkillUpdateBuiltin({ json, dryRun }).exitCode;
      return;
    }
    console.error(`Unknown skill subcommand: ${subcommand ?? "(none)"}\nUsage: trellis skill list|add <name> --from <path>|remove <name>|scope <name> --agents <ids>|--all|--none|update-builtin\n`);
    process.exitCode = 1;
    return;
  }

  if (command === "memory") {
    const [subcommand, ...memoryRest] = rest;
    const json = memoryRest.includes("--json");
    const dryRun = memoryRest.includes("--dry-run");
    if (subcommand === "list") {
      const entries = collectMemoryList();
      if (json) {
        console.log(JSON.stringify(entries, null, 2));
      } else if (entries.length === 0) {
        console.log("No memories in canonical source yet.");
      } else {
        for (const { name, scope } of entries) {
          console.log(`${name} — ${scope.length > 0 ? scope.join(", ") : "(no managed agent reaches it)"}`);
        }
      }
      return;
    }
    if (subcommand === "sync") {
      process.exitCode = runMemorySync({ json, dryRun }).exitCode;
      return;
    }
    if (subcommand === "extract") {
      process.exitCode = runMemoryExtraction({ json, dryRun }).exitCode;
      return;
    }
    console.error(`Unknown memory subcommand: ${subcommand ?? "(none)"}\nUsage: trellis memory list|sync|extract\n`);
    process.exitCode = 1;
    return;
  }

  if (command === "manage") {
    const parsed = parseManageArgs(rest);
    if ("error" in parsed) {
      console.error(`${parsed.error}\nUsage: trellis manage list|set <ids|none>|add <ids>|remove <ids> [--dry-run] [--json]\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = runManage(parsed).exitCode;
    return;
  }

  if (command === "kimi") {
    process.exitCode = (await runKimi(rest)).exitCode;
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
