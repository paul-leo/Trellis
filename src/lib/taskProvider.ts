import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentId } from "../core/types.js";
import { claimTask, createTask, handoffTask, listTasks, readTask, updateTask, type TaskStatus } from "./taskStore.js";
import type { RuntimeContext, TrellisProvider } from "./mcpRuntime.js";

const LIST: Tool = { name: "trellis.tasks.list", description: "List safe Trellis handoff tasks.", inputSchema: { type: "object", properties: { status: { type: "string" }, toAgent: { type: "string" } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
const READ: Tool = { name: "trellis.tasks.read", description: "Read one Trellis handoff task and its audit history.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
const CREATE: Tool = { name: "trellis.tasks.create", description: "Create a safe durable handoff task. Requires explicit confirm=true and never launches another Agent.", inputSchema: { type: "object", properties: { objective: { type: "string" }, toAgent: { type: "string" }, context: { type: "object" }, constraints: { type: "array", items: { type: "string" } }, confirm: { type: "boolean" } }, required: ["objective", "confirm"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
const CLAIM: Tool = { name: "trellis.tasks.claim", description: "Claim one pending handoff task with an exclusive lease. Requires explicit confirm=true.", inputSchema: { type: "object", properties: { id: { type: "string" }, leaseMs: { type: "number" }, confirm: { type: "boolean" } }, required: ["id", "confirm"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
const UPDATE: Tool = { name: "trellis.tasks.update", description: "Update a claimed task status without launching another Agent. Requires explicit confirm=true.", inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" }, note: { type: "string" }, result: { type: "string" }, confirm: { type: "boolean" } }, required: ["id", "status", "confirm"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
const HANDOFF: Tool = { name: "trellis.tasks.handoff", description: "Hand a task to another managed Agent as data only. Requires explicit confirm=true.", inputSchema: { type: "object", properties: { id: { type: "string" }, toAgent: { type: "string" }, note: { type: "string" }, confirm: { type: "boolean" } }, required: ["id", "toAgent", "confirm"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };

function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function failure(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

export class TaskProvider implements TrellisProvider {
  readonly id = "tasks";
  listTools(): Tool[] { return [LIST, READ, CREATE, CLAIM, UPDATE, HANDOFF]; }

  async callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult> {
    const input = (args ?? {}) as Record<string, any>;
    try {
      if (name === LIST.name) {
        const status = input.status as TaskStatus | undefined;
        const toAgent = input.toAgent as AgentId | undefined;
        return result({ tasks: listTasks(context.homeDir, { status, toAgent }) });
      }
      if (name === READ.name) return result(readTask(context.homeDir, String(input.id ?? "")));
      if (input.confirm !== true) return failure(`task mutation "${name}" requires confirm=true; no Agent is launched automatically`);
      if (name === CREATE.name) return result(createTask(context.homeDir, { objective: String(input.objective ?? ""), fromAgent: context.agentId, ...(input.toAgent ? { toAgent: input.toAgent } : {}), ...(input.context ? { context: input.context } : {}), ...(input.constraints ? { constraints: input.constraints } : {}) }));
      if (name === CLAIM.name) return result(claimTask(context.homeDir, String(input.id ?? ""), context.agentId, input.leaseMs));
      if (name === UPDATE.name) return result(updateTask(context.homeDir, String(input.id ?? ""), context.agentId, input.status, input.note, input.result));
      if (name === HANDOFF.name) return result(handoffTask(context.homeDir, String(input.id ?? ""), context.agentId, input.toAgent, input.note));
      return failure(`unknown task tool "${name}"`);
    } catch (error) {
      return failure(error);
    }
  }
}
