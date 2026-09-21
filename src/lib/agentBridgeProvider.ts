import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentId } from "../core/types.js";
import { DEFAULT_MAX_DELEGATION_DEPTH, loadAgentBridgeConfig, readDelegationDepth, runDelegatedCall, type AgentBridgeTargetConfig } from "./agentBridge.js";
import type { RuntimeContext, TrellisProvider } from "./mcpRuntime.js";

function toolNameFor(agentId: AgentId): string {
  return `trellis.agent_bridge.run_${agentId.replaceAll("-", "_")}`;
}

function toolFor(agentId: AgentId, target: AgentBridgeTargetConfig): Tool {
  const tagText = target.tags?.length ? ` Good for: ${target.tags.join(", ")}.` : "";
  const resumeText = target.resumeArgs
    ? " Pass a prior call's returned sessionId to continue that exact conversation."
    : " Does not support resuming a prior conversation — every call starts fresh.";
  return {
    name: toolNameFor(agentId),
    description: `Delegate a one-shot prompt to "${agentId}"'s own non-interactive mode and return its result.${tagText} Optionally set "persona" to shape how it responds for this call.${resumeText} Requires explicit confirm=true — this spawns a real subprocess with real side effects, not a read-only lookup.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        persona: { type: "string", description: "Overrides this target's default persona/role for this call only." },
        sessionId: { type: "string", description: "Resume a prior call's conversation instead of starting fresh; requires the target to support resuming." },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
        confirm: { type: "boolean" },
      },
      required: ["prompt", "confirm"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  };
}

function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Exposes every `agent-bridge.yaml` target — other than the calling
 * Agent itself — as one MCP tool per target Agent. Routing which target
 * to call stays with the caller's own model, exactly like ordinary MCP
 * tool selection; this provider only executes the call once chosen, and
 * refuses one that would exceed the configured delegation depth before
 * ever spawning a process. */
export class AgentBridgeProvider implements TrellisProvider {
  readonly id = "agent_bridge";
  private readonly toolTargets = new Map<string, AgentId>();

  listTools(context: RuntimeContext): Tool[] {
    const config = loadAgentBridgeConfig(context.homeDir);
    this.toolTargets.clear();
    const tools: Tool[] = [];
    for (const [agentId, target] of Object.entries(config.targets) as Array<[AgentId, AgentBridgeTargetConfig]>) {
      if (agentId === context.agentId) continue;
      const tool = toolFor(agentId, target);
      this.toolTargets.set(tool.name, agentId);
      tools.push(tool);
    }
    return tools;
  }

  async callTool(name: string, args: unknown, context: RuntimeContext): Promise<CallToolResult> {
    const input = (args ?? {}) as Record<string, unknown>;
    const targetAgent = this.toolTargets.get(name);
    if (!targetAgent) return failure(`unknown agent bridge tool "${name}"`);
    if (input.confirm !== true) return failure(`agent bridge call "${name}" requires confirm=true — it spawns a real subprocess with real side effects`);
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) return failure("prompt must not be empty");

    const config = loadAgentBridgeConfig(context.homeDir);
    const target = config.targets[targetAgent];
    if (!target) return failure(`agent "${targetAgent}" is no longer configured for delegation`);

    const maxDepth = config.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
    const currentDepth = readDelegationDepth();
    if (currentDepth >= maxDepth) {
      return failure(`delegation depth limit reached (${currentDepth}/${maxDepth}) — refusing to call "${targetAgent}" to avoid a delegation cycle`);
    }

    try {
      const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
      const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
      const persona = typeof input.persona === "string" && input.persona.trim() ? input.persona : undefined;
      const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId : undefined;
      const outcome = await runDelegatedCall(targetAgent, target, prompt, { cwd, timeoutMs, persona, sessionId, depth: currentDepth });
      return result(outcome);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}
