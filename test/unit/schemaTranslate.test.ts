import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgedToolName, toParametersSchema, toPiContent } from "../../src/pi-bridge/schemaTranslate.js";

test("toParametersSchema: wraps a raw JSON Schema unmodified", () => {
  const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  const wrapped = toParametersSchema(inputSchema);
  // Type.Unsafe's own marker ('~unsafe') is a non-enumerable property, so
  // a deepEqual against the original schema's own (enumerable) shape
  // confirms nothing was structurally altered by the wrap.
  assert.deepEqual(wrapped, inputSchema);
});

test("toPiContent: text and image content pass through unchanged", () => {
  const result = toPiContent([
    { type: "text", text: "hello" },
    { type: "image", data: "base64data", mimeType: "image/png" },
  ]);
  assert.deepEqual(result, [
    { type: "text", text: "hello" },
    { type: "image", data: "base64data", mimeType: "image/png" },
  ]);
});

test("toPiContent: audio content degrades to a text summary, not dropped", () => {
  const result = toPiContent([{ type: "audio", data: "base64data", mimeType: "audio/wav" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "text");
  assert.ok((result[0] as { text: string }).text.includes("audio/wav"));
});

test("toPiContent: resource content degrades to a text summary naming the URI", () => {
  const result = toPiContent([{ type: "resource", resource: { uri: "file:///tmp/report.pdf" } }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "text");
  assert.ok((result[0] as { text: string }).text.includes("file:///tmp/report.pdf"));
});

test("toPiContent: resource_link content degrades to a text summary naming the link", () => {
  const result = toPiContent([{ type: "resource_link", uri: "https://example.com/doc", name: "doc" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "text");
  assert.ok((result[0] as { text: string }).text.includes("https://example.com/doc"));
});

test("toPiContent: nothing is silently dropped — output length always matches input length", () => {
  const items = [
    { type: "text" as const, text: "a" },
    { type: "audio" as const, data: "x", mimeType: "audio/mp3" },
    { type: "resource" as const, resource: { uri: "u" } },
    { type: "resource_link" as const, uri: "u2", name: "n" },
    { type: "image" as const, data: "y", mimeType: "image/jpeg" },
  ];
  assert.equal(toPiContent(items).length, items.length);
});

test("bridgedToolName: namespaces by server, preventing collisions across servers", () => {
  assert.equal(bridgedToolName("gitlab", "search"), "gitlab__search");
  assert.notEqual(bridgedToolName("gitlab", "search"), bridgedToolName("github", "search"));
});
