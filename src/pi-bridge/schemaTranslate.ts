/**
 * Pure translation between MCP's protocol shapes and pi's own extension
 * API shapes (trellis-pi-mcp-bridge-p4 design.md D3/D4/D5). No I/O, no
 * MCP client, no pi runtime — everything here is unit-testable in
 * isolation from both.
 */

import { Type, type TSchema } from "typebox";

/** MCP's `tools/call` result content item, narrowed to the fields this
 * bridge actually reads — not the full protocol union. */
export type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name: string };

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type PiContent = PiTextContent | PiImageContent;

/** Wraps a raw MCP JSON Schema as a TypeBox `TSchema` via `Type.Unsafe` —
 * the schema was already authored as valid JSON Schema by the MCP server,
 * so it needs no TypeBox builder semantics applied to it, only a type
 * that satisfies `ToolDefinition.parameters`'s `TSchema` bound
 * (design.md D4). */
export function toParametersSchema(inputSchema: unknown): TSchema {
  return Type.Unsafe(inputSchema as TSchema);
}

/** Text/image pass through unchanged; audio/resource/resource_link
 * degrade to a text summary rather than being dropped silently — pi's
 * own `AgentToolResult.content` has no representation for them
 * (design.md D3). */
export function toPiContent(items: McpContentItem[]): PiContent[] {
  return items.map((item): PiContent => {
    switch (item.type) {
      case "text":
        return { type: "text", text: item.text };
      case "image":
        return { type: "image", data: item.data, mimeType: item.mimeType };
      case "audio":
        return { type: "text", text: `[audio content omitted, mimeType=${item.mimeType} — pi has no native audio tool-result type]` };
      case "resource":
        return { type: "text", text: `[resource content omitted, uri=${item.resource.uri} — pi has no native resource tool-result type]` };
      case "resource_link":
        return { type: "text", text: `[resource link omitted: ${item.name} (${item.uri}) — pi has no native resource tool-result type]` };
    }
  });
}

/** `${serverName}__${toolName}` — deterministic, collision-free across
 * servers sharing pi.registerTool()'s single flat namespace (design.md D5). */
export function bridgedToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}
