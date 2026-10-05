/**
 * `trellis mcp auth` (trellis-mcp-gateway-hosting tasks.md 6.3), plus the
 * gateway's silent refresh-before-connect (4.4/4.8).
 *
 * Driven end to end against the real fake Authorization Server, with the
 * browser step replaced by something that drives the AS directly — the
 * only part of the flow a test cannot perform for real.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runMcpAuth } from "../../src/commands/mcpAuth.js";
import { readToken, tokenPath, writeToken } from "../../src/lib/oauth/store.js";
import { LocalBackend } from "../../src/lib/gatewayBackend.js";
import { startFakeAuthServer, type FakeAuthServer } from "../fixtures/fakeAuthServer.js";

function scratchHome(serversYaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "trellis-mcpauth-"));
  mkdirSync(join(home, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(home, ".trellis", "agents.md"), "# instructions\n");
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), "allowed_vars: []\nreject_patterns: []\n");
  writeFileSync(join(home, ".trellis", "managed.yaml"), "agents: [claude-code]\n");
  writeFileSync(join(home, ".trellis", "mcp", "servers.yaml"), serversYaml);
  return home;
}

function homeWithRemote(as: FakeAuthServer): string {
  return scratchHome(`servers:
  remote:
    transport: http
    url: "${as.resourceUrl}"
`);
}

/** Silences the command's own report so test output stays readable. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

test("mcp auth: authorizes a remote server and stores the credential 0600", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithRemote(as);
    const { exitCode } = await quietly(() =>
      runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }),
    );

    assert.equal(exitCode, 0);
    const token = readToken(home, "remote");
    assert.match(token?.accessToken ?? "", /^access-/);
    assert.equal(statSync(tokenPath(home, "remote")).mode & 0o777, 0o600);

    // D8: nothing about this may land in canonical.
    assert.ok(!readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8").includes(token!.accessToken));
  } finally {
    await as.close();
  }
});

test("mcp auth: re-running with a valid token is a no-op, not a fresh grant", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithRemote(as);
    await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }));
    const first = readToken(home, "remote");
    const grantsAfterFirst = as.grants.length;

    const { exitCode } = await quietly(() =>
      runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }),
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(readToken(home, "remote"), first, "rotating a working credential is a way to break a working setup");
    assert.equal(as.grants.length, grantsAfterFirst);
  } finally {
    await as.close();
  }
});

test("mcp auth: --force re-authorizes even when the stored token is valid", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithRemote(as);
    await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }));
    const first = readToken(home, "remote");

    await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, force: true, openBrowser: (url) => as.authorizeViaBrowser(url) }));

    assert.notEqual(readToken(home, "remote")?.accessToken, first?.accessToken);
  } finally {
    await as.close();
  }
});

test("mcp auth: an expired-but-renewable token is refreshed without any browser", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithRemote(as);
    await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }));
    const stored = readToken(home, "remote")!;
    writeToken(home, "remote", { ...stored, expiresAt: Date.now() - 1000 });

    let browserOpened = false;
    const { exitCode } = await quietly(() =>
      runMcpAuth({
        serverName: "remote",
        homeDir: home,
        openBrowser: () => {
          browserOpened = true;
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(browserOpened, false, "a refresh needs no browser — that is why the gateway is allowed to do it");
    assert.notEqual(readToken(home, "remote")?.accessToken, stored.accessToken);
  } finally {
    await as.close();
  }
});

test("mcp auth: an unknown server name is an error, not a silent no-op", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithRemote(as);
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      const { exitCode } = await runMcpAuth({ serverName: "nonexistent", homeDir: home });
      assert.equal(exitCode, 1);
      assert.match(errors.join("\n"), /no MCP server named "nonexistent"/);
    } finally {
      console.error = original;
    }
  } finally {
    await as.close();
  }
});

test("mcp auth: a stdio server is refused with an explanation, not sent through a browser flow", async () => {
  const home = scratchHome(`servers:
  local:
    transport: stdio
    command: node
`);
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    const { exitCode } = await runMcpAuth({ serverName: "local", homeDir: home });
    assert.equal(exitCode, 1);
    // Sending someone hunting for a browser flow that does not exist is
    // worse than saying plainly where stdio credentials come from.
    assert.match(errors.join("\n"), /is a stdio server.*env_aliases/s);
  } finally {
    console.error = original;
  }
});

test("mcp auth: a server with no discoverable OAuth metadata reports that, rather than hanging", async () => {
  const home = scratchHome(`servers:
  remote:
    transport: http
    url: "http://127.0.0.1:1/mcp"
`);
  const errors: string[] = [];
  const original = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    const { exitCode } = await runMcpAuth({ serverName: "remote", homeDir: home });
    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /could not discover OAuth metadata/);
  } finally {
    console.error = original;
  }
});

// --- the gateway side (tasks.md 4.4/4.8) ------------------------------

test("gateway: an expired stored token is refreshed silently before connecting, with no browser", async () => {
  const as = await startFakeAuthServer({ rotateRefreshTokens: true });
  try {
    const home = homeWithRemote(as);
    await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }));
    const stale = readToken(home, "remote")!;
    writeToken(home, "remote", { ...stale, expiresAt: Date.now() - 1000 });

    const warnings: string[] = [];
    const backend = await LocalBackend.connect([{ name: "remote", def: { transport: "http", url: as.resourceUrl } }], {
      secretsPolicy: { allowedVars: [], rejectPatterns: [] },
      clientInfo: { name: "test", version: "0" },
      connectTimeoutMs: 3000,
      onWarning: (message) => warnings.push(message),
      homeDir: home,
    });
    await backend.close();

    // The fake AS speaks no MCP, so the connection itself fails — that is
    // expected and isolated. What matters is that the refresh happened
    // first, silently, and that the rotated token was persisted.
    const after = readToken(home, "remote")!;
    assert.notEqual(after.accessToken, stale.accessToken, "the gateway refreshed before attempting to connect");
    assert.equal(as.isRefreshTokenValid(after.refreshToken!), true);
  } finally {
    await as.close();
  }
});

test("gateway: with no stored token, a remote server is attempted normally — OAuth is not assumed", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithRemote(as);
    const warnings: string[] = [];
    const backend = await LocalBackend.connect([{ name: "remote", def: { transport: "http", url: as.resourceUrl } }], {
      secretsPolicy: { allowedVars: [], rejectPatterns: [] },
      clientInfo: { name: "test", version: "0" },
      connectTimeoutMs: 3000,
      onWarning: (message) => warnings.push(message),
      homeDir: home,
    });
    await backend.close();

    // The overwhelmingly common case is a remote server that uses no
    // OAuth at all; it must not be skipped for lacking a credential.
    assert.ok(
      warnings.every((warning) => !/skipping MCP server "remote"/.test(warning)),
      `expected a connect attempt, not an OAuth skip: ${warnings.join(" | ")}`,
    );
  } finally {
    await as.close();
  }
});

test("gateway: an explicit Authorization header in canonical wins over a stored token", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithRemote(as);
    await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }));
    const stored = readToken(home, "remote")!;
    writeToken(home, "remote", { ...stored, expiresAt: Date.now() - 1000 });

    const backend = await LocalBackend.connect(
      [{ name: "remote", def: { transport: "http", url: as.resourceUrl, headers: { Authorization: "Bearer written-by-hand" } } }],
      {
        secretsPolicy: { allowedVars: [], rejectPatterns: [] },
        clientInfo: { name: "test", version: "0" },
        connectTimeoutMs: 3000,
        onWarning: () => {},
        homeDir: home,
      },
    );
    await backend.close();

    // Someone who wrote an Authorization header meant it; silently
    // overriding it with a stored token would be invisible precedence.
    assert.equal(readToken(home, "remote")?.accessToken, stored.accessToken, "no refresh should have been triggered at all");
  } finally {
    await as.close();
  }
});

// --- pre-registered client metadata (trellis-mcp-oauth-static-client) --

/** A home whose canonical `remote` server carries the object-form auth. */
function homeWithAuthBlock(as: FakeAuthServer, authYaml: string, secretsPolicyYaml = "allowed_vars: []\nreject_patterns: []\n"): string {
  const home = scratchHome(`servers:
  remote:
    transport: http
    url: "${as.resourceUrl}"
    auth:
${authYaml}
`);
  writeFileSync(join(home, ".trellis", "secrets.policy.yaml"), secretsPolicyYaml);
  return home;
}

test("mcp auth: a canonical client_id skips dynamic registration", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithAuthBlock(as, '      kind: oauth\n      client_id: "pub-from-provider"');
    const { exitCode } = await quietly(() =>
      runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }),
    );

    assert.equal(exitCode, 0);
    assert.equal(as.registrations, 0, "a provider that refuses DCR must never be asked to register");
    // The stored grant carries the client identity it was issued to, so a
    // later silent refresh presents the same one (tasks.md 2.5).
    assert.equal(readToken(home, "remote")?.clientId, "pub-from-provider");
  } finally {
    await as.close();
  }
});

test("mcp auth: client_secret_env resolves through secrets.policy.yaml and reaches the token endpoint", async () => {
  const as = await startFakeAuthServer();
  try {
    const envFile = join(mkdtempSync(join(tmpdir(), "trellis-mcpauth-env-")), "secrets.env");
    writeFileSync(envFile, "FIGMA_CLIENT_SECRET=resolved-from-env-file\n");
    const home = homeWithAuthBlock(
      as,
      '      kind: oauth\n      client_id: "confidential"\n      client_secret_env: FIGMA_CLIENT_SECRET',
      `allowed_vars: [FIGMA_CLIENT_SECRET]\nreject_patterns: []\nenv_file: "${envFile}"\n`,
    );

    const { exitCode } = await quietly(() =>
      runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }),
    );

    assert.equal(exitCode, 0);
    assert.deepEqual(as.clientSecretsSeen, ["resolved-from-env-file"]);
    // D8: resolved secret values belong in the token store and nowhere else.
    assert.ok(!readFileSync(join(home, ".trellis", "mcp", "servers.yaml"), "utf-8").includes("resolved-from-env-file"));
  } finally {
    await as.close();
  }
});

test("mcp auth: an unresolvable client_secret_env names the variable and the source, never a value", async () => {
  const as = await startFakeAuthServer();
  try {
    const home = homeWithAuthBlock(as, '      kind: oauth\n      client_id: "confidential"\n      client_secret_env: NEVER_SET_ANYWHERE');
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    let browserOpened = false;
    try {
      const { exitCode } = await runMcpAuth({
        serverName: "remote",
        homeDir: home,
        openBrowser: () => {
          browserOpened = true;
        },
      });

      assert.equal(exitCode, 1);
      const message = errors.join("\n");
      assert.match(message, /NEVER_SET_ANYWHERE/, "the variable NAME is what the user has to go set");
      assert.match(message, /process environment/);
      // Failing before the browser opens is the point: sending someone
      // through a consent screen for a grant that cannot be redeemed is
      // worse than an immediate error.
      assert.equal(browserOpened, false);
    } finally {
      console.error = original;
    }
  } finally {
    await as.close();
  }
});

test("mcp auth: the scalar form and a metadata-less object authorize identically", async () => {
  const as = await startFakeAuthServer();
  try {
    const scalarHome = scratchHome(`servers:
  remote:
    transport: http
    url: "${as.resourceUrl}"
    auth: oauth
`);
    const objectHome = homeWithAuthBlock(as, "      kind: oauth");

    for (const home of [scalarHome, objectHome]) {
      const { exitCode } = await quietly(() =>
        runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }),
      );
      assert.equal(exitCode, 0);
    }

    // Both fell back to DCR, exactly as before the object form existed
    // (design.md D1: metadata extends the flow, it never changes routing).
    assert.equal(as.registrations, 2);
  } finally {
    await as.close();
  }
});

test("mcp auth: a registration-refusing provider fails with the remediation, then succeeds once client_id is set", async () => {
  const as = await startFakeAuthServer({ rejectRegistration: true });
  try {
    const home = scratchHome(`servers:
  remote:
    transport: http
    url: "${as.resourceUrl}"
`);
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      const { exitCode } = await runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) });
      assert.equal(exitCode, 1);
      assert.match(errors.join("\n"), /unauthorized_client/);
      assert.match(errors.join("\n"), /auth\.client_id/);
    } finally {
      console.error = original;
    }

    // Following the message's own advice has to be sufficient.
    writeFileSync(
      join(home, ".trellis", "mcp", "servers.yaml"),
      `servers:\n  remote:\n    transport: http\n    url: "${as.resourceUrl}"\n    auth:\n      kind: oauth\n      client_id: "team-client"\n`,
    );
    const retry = await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }));
    assert.equal(retry.exitCode, 0);
    assert.equal(readToken(home, "remote")?.clientId, "team-client");
  } finally {
    await as.close();
  }
});

test("mcp auth: a later refresh presents the same confidential-client identity", async () => {
  // tasks.md 2.5 in full: persisting the grant paired with the client
  // identity is only worth anything if the refresh actually uses it.
  const as = await startFakeAuthServer();
  try {
    const envFile = join(mkdtempSync(join(tmpdir(), "trellis-mcpauth-env-")), "secrets.env");
    writeFileSync(envFile, "CONFIDENTIAL_SECRET=stored-secret\n");
    const home = homeWithAuthBlock(
      as,
      '      kind: oauth\n      client_id: "confidential"\n      client_secret_env: CONFIDENTIAL_SECRET',
      `allowed_vars: [CONFIDENTIAL_SECRET]\nreject_patterns: []\nenv_file: "${envFile}"\n`,
    );

    await quietly(() => runMcpAuth({ serverName: "remote", homeDir: home, openBrowser: (url) => as.authorizeViaBrowser(url) }));
    const stored = readToken(home, "remote")!;
    assert.equal(stored.clientSecret, "stored-secret");

    // Expire the grant, then re-run: this must refresh, not re-authorize.
    writeToken(home, "remote", { ...stored, expiresAt: Date.now() - 1000 });
    const grantsBefore = as.grants.length;
    let browserOpened = false;
    const { exitCode } = await quietly(() =>
      runMcpAuth({
        serverName: "remote",
        homeDir: home,
        openBrowser: () => {
          browserOpened = true;
        },
      }),
    );

    assert.equal(exitCode, 0);
    assert.equal(browserOpened, false);
    assert.deepEqual(
      as.grants.slice(grantsBefore).map((grant) => grant.grantType),
      ["refresh_token"],
    );
    assert.deepEqual(as.clientSecretsSeen, ["stored-secret", "stored-secret"]);
  } finally {
    await as.close();
  }
});
