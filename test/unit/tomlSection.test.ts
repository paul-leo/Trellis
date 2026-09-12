import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codexBearerTokenEnvVar,
  currentServerSectionText,
  findSection,
  removeSection,
  renderServerSection,
  upsertSection,
} from "../../src/lib/tomlSection.js";

const FIXTURE = `# top comment
model = "gpt-5.6-sol" # inline comment
instructions = "/root/.codex/instructions.md"

[mcp_servers.gitlab]
command = "npx"
args = ["-y", "@zereight/mcp-gitlab"]
env_vars = ["GITLAB_PERSONAL_ACCESS_TOKEN"]

[some_other_setting]
foo = "bar"
`;

test("findSection: locates an existing section's exact line range", () => {
  const range = findSection(FIXTURE, "mcp_servers.gitlab");
  assert.ok(range);
  const lines = FIXTURE.split("\n");
  assert.equal(lines[range!.start], "[mcp_servers.gitlab]");
  assert.equal(lines[range!.end], 'env_vars = ["GITLAB_PERSONAL_ACCESS_TOKEN"]');
});

test("findSection: returns null when the header doesn't exist", () => {
  assert.equal(findSection(FIXTURE, "mcp_servers.nonexistent"), null);
});

test("upsertSection: adding a new server preserves every other line byte-for-byte", () => {
  const result = upsertSection(FIXTURE, "sample-server", { transport: "stdio", command: "node", args: ["server.js"] });
  for (const line of FIXTURE.split("\n")) {
    assert.ok(result.includes(line), `expected untouched line to survive: ${line}`);
  }
  assert.ok(result.includes("[mcp_servers.sample-server]"));
  assert.ok(result.includes('command = "node"'));
});

test("upsertSection: updating an existing section replaces only its own lines", () => {
  const result = upsertSection(FIXTURE, "gitlab", { transport: "stdio", command: "different-command", args: [] });
  assert.ok(result.includes("# top comment"));
  assert.ok(result.includes("[some_other_setting]"));
  assert.ok(result.includes('foo = "bar"'));
  assert.ok(result.includes('command = "different-command"'));
  assert.ok(!result.includes('command = "npx"'), "old command must be gone, not just appended alongside");
  assert.ok(!result.includes("GITLAB_PERSONAL_ACCESS_TOKEN"), "old env_vars line must be replaced, not left behind");
});

test("removeSection: deletes only the target section, leaves everything else untouched", () => {
  const result = removeSection(FIXTURE, "gitlab");
  assert.ok(!result.includes("[mcp_servers.gitlab]"));
  assert.ok(!result.includes("GITLAB_PERSONAL_ACCESS_TOKEN"));
  assert.ok(result.includes("# top comment"));
  assert.ok(result.includes("[some_other_setting]"));
  assert.ok(result.includes('foo = "bar"'));
});

test("removeSection: a no-op when the section doesn't exist (idempotent)", () => {
  const result = removeSection(FIXTURE, "nonexistent");
  assert.equal(result, FIXTURE);
});

test("upsertSection then removeSection round-trips back to equivalent content", () => {
  const added = upsertSection(FIXTURE, "sample-server", { transport: "stdio", command: "node" });
  const removed = removeSection(added, "sample-server");
  assert.equal(removed, FIXTURE);
});

test("regression: a nested-array continuation line elsewhere never terminates the section early (tasks.md 2.8)", () => {
  const withNestedArray = `[mcp_servers.gitlab]
command = "npx"
args = ["-y", "@zereight/mcp-gitlab"]

[weird_unrelated_setting]
matrix = [
  [1, 2],
  [3, 4]
]
`;
  const range = findSection(withNestedArray, "mcp_servers.gitlab");
  assert.ok(range);
  const lines = withNestedArray.split("\n");
  // The gitlab section must end at its own last real line (args), not
  // extend past [weird_unrelated_setting] or get confused by "[1, 2],"
  // looking bracket-like.
  assert.equal(lines[range!.end], 'args = ["-y", "@zereight/mcp-gitlab"]');

  const result = removeSection(withNestedArray, "gitlab");
  assert.ok(result.includes("[weird_unrelated_setting]"));
  assert.ok(result.includes("[1, 2],"));
  assert.ok(result.includes("[3, 4]"));
});

test("renderServerSection: quotes a server name that isn't a valid bare TOML key", () => {
  const section = renderServerSection("my server", { transport: "stdio", command: "node" });
  assert.equal(section.split("\n")[0], '[mcp_servers."my server"]');
});

test("upsertSection: an http transport def renders a url, not command/args", () => {
  const result = upsertSection("", "figma", { transport: "http", url: "https://mcp.figma.com/mcp" });
  assert.ok(result.includes('url = "https://mcp.figma.com/mcp"'));
  assert.ok(!result.includes("command"));
});

test("codexBearerTokenEnvVar: recognizes the single Authorization/Bearer/${VAR} shape", () => {
  assert.equal(codexBearerTokenEnvVar({ transport: "http", url: "x", headers: { Authorization: "Bearer ${MY_TOKEN}" } }), "MY_TOKEN");
});

test("codexBearerTokenEnvVar: undefined for no headers", () => {
  assert.equal(codexBearerTokenEnvVar({ transport: "http", url: "x" }), undefined);
});

test("codexBearerTokenEnvVar: undefined for more than one header", () => {
  assert.equal(
    codexBearerTokenEnvVar({ transport: "http", url: "x", headers: { Authorization: "Bearer ${A}", "X-Api-Key": "${B}" } }),
    undefined,
  );
});

test("codexBearerTokenEnvVar: undefined for a non-Authorization header", () => {
  assert.equal(codexBearerTokenEnvVar({ transport: "http", url: "x", headers: { "X-Api-Key": "${A}" } }), undefined);
});

test("codexBearerTokenEnvVar: undefined for a value not matching Bearer ${VAR} exactly", () => {
  assert.equal(codexBearerTokenEnvVar({ transport: "http", url: "x", headers: { Authorization: "Token ${A}" } }), undefined);
  assert.equal(codexBearerTokenEnvVar({ transport: "http", url: "x", headers: { Authorization: "Bearer literal-value" } }), undefined);
});

test("renderServerSection: a bearer-token-shaped headers field renders bearer_token_env_var, no headers line", () => {
  const section = renderServerSection("remote", { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MY_TOKEN}" } });
  assert.ok(section.includes('bearer_token_env_var = "MY_TOKEN"'));
  assert.ok(!section.includes("headers"));
});

test("renderServerSection: a non-bearer-token headers shape renders no bearer_token_env_var line", () => {
  const section = renderServerSection("remote", { transport: "http", url: "https://example.com/mcp", headers: { "X-Api-Key": "${A}" } });
  assert.ok(!section.includes("bearer_token_env_var"));
});

test("currentServerSectionText: matches renderServerSection's own output for an unchanged entry, differs after a real change", () => {
  const def = { transport: "stdio" as const, command: "npx", args: ["-y", "@zereight/mcp-gitlab"], env: ["GITLAB_PERSONAL_ACCESS_TOKEN"] };
  const current = currentServerSectionText(FIXTURE, "gitlab");
  assert.equal(current, renderServerSection("gitlab", def));

  const changed = currentServerSectionText(FIXTURE, "gitlab");
  assert.notEqual(changed, renderServerSection("gitlab", { ...def, command: "different" }));
});

test("currentServerSectionText: null when the server doesn't exist yet", () => {
  assert.equal(currentServerSectionText(FIXTURE, "nonexistent"), null);
});

test("regression: a comment block introducing the NEXT header is excluded from the PREVIOUS section's range (found via sandbox: a real update would have deleted it)", () => {
  const withLeadingComment = `[mcp_servers.sample-server]
command = "node"
args = ["/fixtures/sample-mcp-server.js"]

# Deliberate fixture: "sentry" also appears in known_host_injected.
# This comment documents the NEXT section, not this one.
[mcp_servers.sentry]
command = "node"
args = ["/fixtures/fake-sentry-stdio.js"]
`;
  const range = findSection(withLeadingComment, "mcp_servers.sample-server");
  assert.ok(range);
  const lines = withLeadingComment.split("\n");
  assert.equal(lines[range!.end], 'args = ["/fixtures/sample-mcp-server.js"]');

  const current = currentServerSectionText(withLeadingComment, "sample-server");
  const rendered = renderServerSection("sample-server", { transport: "stdio", command: "node", args: ["/fixtures/sample-mcp-server.js"] });
  assert.equal(current, rendered, "an already-correct section must compare equal — no spurious update");

  const result = upsertSection(withLeadingComment, "sample-server", { transport: "stdio", command: "different" });
  assert.ok(result.includes('# This comment documents the NEXT section, not this one.'), "comment must survive an update to the prior section");
  assert.ok(result.includes("[mcp_servers.sentry]"));
});
