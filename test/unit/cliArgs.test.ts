/**
 * cliArgs: the shared `--flag value` / `--flag=value` reader. Regression
 * home for the v0.15.0 real-machine smoke-test bug where `--args=-y,…`
 * was silently dropped by the old `argv.indexOf("--args")` lookups.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { flagValue, unknownFlags } from "../../src/lib/cliArgs.js";

test("flagValue: reads the space-separated form, including a value that starts with a dash", () => {
  assert.equal(flagValue(["--args", "-y,@modelcontextprotocol/server-everything"], "--args"), "-y,@modelcontextprotocol/server-everything");
});

test("flagValue: reads the = form (the smoke-test regression)", () => {
  assert.equal(flagValue(["--args=-y,@modelcontextprotocol/server-everything"], "--args"), "-y,@modelcontextprotocol/server-everything");
  assert.equal(flagValue(["--url=https://example.com/mcp"], "--url"), "https://example.com/mcp");
  assert.equal(flagValue(["--agents=codex,pi"], "--agents"), "codex,pi");
});

test("flagValue: missing flag is undefined; a trailing flag with no value is undefined; first occurrence wins", () => {
  assert.equal(flagValue(["--transport", "http"], "--args"), undefined);
  assert.equal(flagValue(["--agent"], "--agent"), undefined);
  assert.equal(flagValue(["--from", "a", "--from", "b"], "--from"), "a");
  // `--args=` is an explicit empty string, not absence
  assert.equal(flagValue(["--args="], "--args"), "");
});

test("unknownFlags: classifies only unclaimed --* tokens, by name part in the = form", () => {
  assert.deepEqual(
    unknownFlags(
      ["myserver", "--transport", "http", "--tranport", "stdio", "--args=-y,x", "--wierd=1", "--json"],
      ["--transport", "--args", "--json"],
    ),
    ["--tranport", "--wierd=1"],
    "positionals, values, and known flags (either form) are not unknown",
  );
  assert.deepEqual(unknownFlags(["name", "http"], ["--transport"]), [], "no --* tokens at all");
});
