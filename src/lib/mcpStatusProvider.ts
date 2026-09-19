import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayBackend } from "./gatewayBackend.js";
import type { RuntimeContext, TrellisProvider } from "./mcpRuntime.js";

const STATUS_TOOL: Tool = {
  name: "trellis.mcp.status",
  description: "Show MCP upstream availability and the safe next action for authentication or configuration failures.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export class McpStatusProvider implements TrellisProvider {
  readonly id = "mcp";

  constructor(private readonly backend: GatewayBackend) {}

  listTools(): Tool[] {
    return [STATUS_TOOL];
  }

  async callTool(name: string, _args: unknown, _context: RuntimeContext): Promise<CallToolResult> {
    if (name !== STATUS_TOOL.name) return { content: [{ type: "text", text: `unknown MCP status tool "${name}"` }], isError: true };
    const statuses = this.backend.listStatus?.() ?? [];
    return {
      content: [{ type: "text", text: JSON.stringify({ servers: statuses }, null, 2) }],
      structuredContent: { servers: statuses },
    };
  }
}
