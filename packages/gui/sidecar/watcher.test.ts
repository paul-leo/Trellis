import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { watchTrellisHome } from "./watcher.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function cli(homeDir: string, args: string[]): string {
  return execFileSync("npx", ["tsx", "src/cli.ts", ...args], { cwd: repoRoot, env: { ...process.env, HOME: homeDir }, encoding: "utf-8" });
}

function waitForPath(events: string[], suffix: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for an event matching "${suffix}" — saw: ${JSON.stringify(events)}`)), timeoutMs);
    const interval = setInterval(() => {
      const match = events.find((path) => path.endsWith(suffix));
      if (match) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(match);
      }
    }, 25);
  });
}

test("watchTrellisHome: a file change made by a directly-invoked `trellis sync` (not through the sidecar) fires within a bounded window", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-watcher-"));
  cli(homeDir, ["init"]);

  const events: string[] = [];
  const watcher = watchTrellisHome(homeDir, (event) => events.push(event.path), 20);
  try {
    const seen = waitForPath(events, "servers.yaml");

    // A real, external, non-sidecar write — `mcp add` writes servers.yaml
    // directly on disk, with no sidecar process involved at all. (It also
    // opens a backup session first, per src/commands/mcp.ts's tasks.md 3.5
    // fix, which touches `.trellis/backups/**` before `servers.yaml`
    // itself — waitForPath tolerates unrelated events preceding the one
    // this test actually cares about, rather than assuming servers.yaml
    // is the very first event observed.)
    cli(homeDir, ["mcp", "add", "watched-server", "--transport", "stdio", "--command", "echo", "--json"]);

    const path = await seen;
    assert.match(path, /servers\.yaml$/, "the watcher must report the real changed file's relative path");
  } finally {
    watcher.close();
  }
});

test("watchTrellisHome: rapid repeated writes to the same path collapse into one debounced event", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "trellis-gui-watcher-debounce-"));
  cli(homeDir, ["init"]);
  const targetFile = join(homeDir, ".trellis", "mcp", "servers.yaml");
  const original = readFileSync(targetFile, "utf-8");

  const events: string[] = [];
  const watcher = watchTrellisHome(homeDir, (event) => events.push(event.path), 150);
  try {
    // Three writes to the SAME path in the same tick — genuinely within
    // one 150ms debounce window (unlike three separate `execFileSync`
    // CLI invocations, each of which has its own process-spawn latency
    // far exceeding 150ms on its own) — must collapse to one event.
    writeFileSync(targetFile, `${original}# rev 1\n`);
    writeFileSync(targetFile, `${original}# rev 2\n`);
    writeFileSync(targetFile, `${original}# rev 3\n`);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const serversYamlEvents = events.filter((path) => path.endsWith("servers.yaml"));
    assert.equal(serversYamlEvents.length, 1, `expected exactly one debounced event for servers.yaml, got ${serversYamlEvents.length}`);
  } finally {
    watcher.close();
  }
});
