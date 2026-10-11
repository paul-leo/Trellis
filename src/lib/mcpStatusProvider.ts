import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { GatewayBackend } from "./gatewayBackend.js";
import type { RuntimeContext, TrellisProvider } from "./mcpRuntime.js";
import { describeStoredToken, remediationFor, type OAuthRenewStatus } from "./oauth/renew.js";

const STATUS_TOOL: Tool = {
  name: "trellis.mcp.status",
  description: "Show MCP upstream availability, credential health for OAuth-classified direct-routed servers, and the safe next action for authentication or configuration failures.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export interface McpStatusProviderOptions {
  /** Where the OAuth token store lives. Omitted, the `oauth` section of
   * the report is empty — the provider stays usable by callers with no
   * home directory, the same contract `LocalBackend` exposes. */
  homeDir?: string;
  /** Names of OAuth-classified servers routed as direct native entries
   * for this agent. The gateway never owns their connections, so nothing
   * connection-shaped can be reported for them — only the health of the
   * stored credential, which is the part Trellis actually owns
   * (trellis-mcp-status-credential-health design.md D1). */
  oauthServers?: readonly string[];
}

/** One OAuth-classified server's credential health. `credential` — not
 * `status` — because the gateway cannot observe a direct-routed server's
 * connection state; claiming "ready" would be a lie (design.md D1). */
export interface OAuthCredentialReport {
  name: string;
  credential: OAuthRenewStatus;
  /** ISO 8601, when the stored token carries an expiry at all. */
  expiresAt?: string;
  /** Present only when there is an action to take. */
  remediation?: string;
}

export class McpStatusProvider implements TrellisProvider {
  readonly id = "mcp";

  constructor(
    private readonly backend: GatewayBackend,
    private readonly options: McpStatusProviderOptions = {},
  ) {}

  listTools(): Tool[] {
    return [STATUS_TOOL];
  }

  async callTool(name: string, _args: unknown, _context: RuntimeContext): Promise<CallToolResult> {
    if (name !== STATUS_TOOL.name) return { content: [{ type: "text", text: `unknown MCP status tool "${name}"` }], isError: true };
    const statuses = this.backend.listStatus?.() ?? [];
    // Strictly read-only (design.md D3): classification reads the token
    // files and nothing else — no token endpoint, no refresh, no writes.
    // The readOnlyHint annotation on the tool depends on that staying true.
    const oauth: OAuthCredentialReport[] = this.options.homeDir
      ? (this.options.oauthServers ?? []).map((serverName) => {
          const { status, expiresAt } = describeStoredToken(this.options.homeDir as string, serverName);
          const remediation = remediationFor(status, serverName);
          return {
            name: serverName,
            credential: status,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            ...(remediation !== "" ? { remediation } : {}),
          };
        })
      : [];
    const report = { servers: statuses, oauth };
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      structuredContent: report,
    };
  }
}
