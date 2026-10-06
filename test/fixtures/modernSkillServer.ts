import { Server, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { digestOf } from "../../src/lib/skillManifest.js";

let supporting = process.argv.includes("--large") ? "x".repeat(11 * 1024 * 1024) : "check correctness\n";
const withTools = process.argv.includes("--tools");
function entry(name: string) {
  const files = {
    [`skill://${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Review code\nmetadata:\n  team: upstream\n---\nRead references/checklist.md\n`,
    [`skill://${name}/references/checklist.md`]: supporting,
  };
  return { uri: `skill://${name}/SKILL.md`, frontmatter: { name, description: "Review code", metadata: { team: "upstream" } }, resources: Object.entries(files).map(([uri, text]) => ({ uri, digest: digestOf(Buffer.from(text)), size: Buffer.byteLength(text) })), files };
}

serveStdio(() => {
  const server = new Server({ name: "modern-skill-fixture", version: "1" }, { capabilities: { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} }, ...(withTools ? { tools: {} } : {}) } });
  server.setRequestHandler("skills/list", { params: z.looseObject({}), result: z.looseObject({}) }, async () => {
    const { files: _files, ...skill } = entry("review");
    return { skills: [skill], ttlMs: 0, cacheScope: "private" };
  });
  server.setRequestHandler("skills/get", { params: z.object({ uri: z.string() }), result: z.looseObject({}) }, async ({ uri }) => {
    const name = uri === "skill://hidden/SKILL.md" ? "hidden" : "review";
    const { files: _files, ...skill } = entry(name);
    if (skill.uri !== uri) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "unknown skill");
    return { skill, ttlMs: 0, cacheScope: "private" };
  });
  server.setRequestHandler("resources/list", async () => ({ resources: Object.keys(entry("review").files).map((uri) => ({ uri, name: uri.split("/").at(-1)! })) }));
  server.setRequestHandler("resources/read", async ({ params: { uri } }) => {
    const text = { ...entry("review").files, ...entry("hidden").files }[uri];
    if (text === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "unknown file");
    return { contents: [{ uri, text }] };
  });
  if (withTools) {
    server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "mutate", inputSchema: { type: "object" } }] }));
    server.setRequestHandler("tools/call", async () => { supporting = "changed bytes\n"; return { content: [{ type: "text", text: "changed" }] }; });
  }
  return server;
}, { legacy: "reject" });
