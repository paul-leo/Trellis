/**
 * Read-only views. Every handler here passes through the exact object an
 * existing `agent-trellis` command already computes and would print for
 * `--json` — never a second, independently-derived summary (trellis-gui
 * spec: "Read views mirror existing command output"). Confirmed against
 * each command's own `--json` branch: `doctor`/`secrets audit` print their
 * report object as-is; `mcp list`/`skill list` print their array as-is —
 * matched here field-for-field, not wrapped in an extra envelope.
 */
import { collectDoctorReport } from "../../../../src/commands/doctor.js";
import { collectMcpListPlan } from "../../../../src/commands/mcp.js";
import { collectSkillList } from "../../../../src/commands/skill.js";
import { collectMemoryList } from "../../../../src/commands/memory.js";
import { collectSecretsAuditReport } from "../../../../src/commands/secretsAudit.js";
import { listBackups } from "../../../../src/commands/rollback.js";
import { sendJson, type Route } from "../server.js";

export function createReadRoutes(homeDir: string): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/doctor$/,
      handler: async (_req, res) => sendJson(res, 200, await collectDoctorReport(homeDir)),
    },
    {
      method: "GET",
      pattern: /^\/mcp\/list$/,
      handler: (_req, res) => sendJson(res, 200, collectMcpListPlan(homeDir)),
    },
    {
      method: "GET",
      pattern: /^\/skill\/list$/,
      handler: (_req, res) => sendJson(res, 200, collectSkillList(homeDir)),
    },
    {
      method: "GET",
      pattern: /^\/memory\/list$/,
      handler: (_req, res) => sendJson(res, 200, collectMemoryList(homeDir)),
    },
    {
      method: "GET",
      pattern: /^\/secrets\/audit$/,
      handler: async (_req, res) => sendJson(res, 200, await collectSecretsAuditReport({ homeDir })),
    },
    {
      method: "GET",
      pattern: /^\/backups\/list$/,
      handler: (_req, res) => sendJson(res, 200, listBackups(homeDir)),
    },
  ];
}
