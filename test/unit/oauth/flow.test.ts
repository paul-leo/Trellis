/**
 * Authorization-code + PKCE + DCR (tasks.md 5.3/5.6).
 *
 * Every test here runs against the real fake Authorization Server, which
 * *enforces* PKCE rather than accepting whatever it is sent: a wrong
 * verifier is rejected, a code is single-use, and the authorization
 * endpoint refuses a request with no S256 challenge. That is what makes
 * a passing test evidence rather than a tautology.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverAuthorizationServer } from "../../../src/lib/oauth/discovery.js";
import { authorize, registerClient, AuthorizationError } from "../../../src/lib/oauth/flow.js";
import { startFakeAuthServer, type FakeAuthServer } from "../../fixtures/fakeAuthServer.js";

async function metadataFor(as: FakeAuthServer) {
  const metadata = await discoverAuthorizationServer(as.resourceUrl);
  assert.ok(metadata, "precondition: discovery must succeed");
  return metadata;
}

test("authorize: full DCR + PKCE + code exchange round trip", async () => {
  const as = await startFakeAuthServer();
  try {
    const token = await authorize("remote", await metadataFor(as), {
      openBrowser: (url) => as.authorizeViaBrowser(url),
    });

    assert.match(token.accessToken, /^access-/);
    assert.match(token.refreshToken ?? "", /^refresh-/);
    assert.equal(token.tokenEndpoint, `${as.url}/token`, "recorded so a later silent refresh needs no rediscovery");
    assert.match(token.clientId ?? "", /^client-/);
    assert.ok((token.expiresAt ?? 0) > Date.now());
    assert.equal(as.registrations, 1);
    assert.deepEqual(
      as.grants.map((grant) => grant.grantType),
      ["authorization_code"],
    );
  } finally {
    await as.close();
  }
});

test("authorize: an existing client_id is reused instead of registering again", async () => {
  const as = await startFakeAuthServer();
  try {
    const token = await authorize("remote", await metadataFor(as), {
      clientId: "preexisting-client",
      openBrowser: (url) => as.authorizeViaBrowser(url),
    });

    assert.equal(token.clientId, "preexisting-client");
    assert.equal(as.registrations, 0, "re-registering on every run would leak client records on the AS");
  } finally {
    await as.close();
  }
});

test("authorize: the request carries an S256 challenge, and the AS would refuse it otherwise", async () => {
  const as = await startFakeAuthServer();
  try {
    let seen: URL | undefined;
    await authorize("remote", await metadataFor(as), {
      openBrowser: async (url) => {
        seen = new URL(url);
        await as.authorizeViaBrowser(url);
      },
    });

    assert.equal(seen?.searchParams.get("code_challenge_method"), "S256");
    assert.ok(seen?.searchParams.get("code_challenge"));
    // The verifier is the secret; it must never appear in the URL that
    // travels through the user's browser and its history.
    assert.equal(seen?.searchParams.get("code_verifier"), null);
    assert.ok(seen?.searchParams.get("state"), "state is required to bind the callback to this request");
    assert.match(seen?.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  } finally {
    await as.close();
  }
});

test("authorize: a callback carrying the wrong state is refused, not redeemed", async () => {
  const as = await startFakeAuthServer();
  try {
    const metadata = await metadataFor(as);
    await assert.rejects(
      () =>
        authorize("remote", metadata, {
          openBrowser: async (url) => {
            // A forged callback: a valid-looking code, but not the one
            // this flow asked for. Redeeming it would be the CSRF the
            // state parameter exists to prevent.
            const parsed = new URL(url);
            const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
            redirect.searchParams.set("code", "attacker-supplied-code");
            redirect.searchParams.set("state", "not-the-state-we-sent");
            await fetch(redirect.toString());
          },
        }),
      /unexpected state parameter/,
    );
    assert.deepEqual(as.grants, [], "no token request may be made at all for a mismatched callback");
  } finally {
    await as.close();
  }
});

test("authorize: an authorization-server error response surfaces, rather than hanging", async () => {
  const as = await startFakeAuthServer();
  try {
    const metadata = await metadataFor(as);
    await assert.rejects(
      () =>
        authorize("remote", metadata, {
          openBrowser: async (url) => {
            const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
            redirect.searchParams.set("error", "access_denied");
            redirect.searchParams.set("error_description", "user refused");
            await fetch(redirect.toString());
          },
        }),
      /was refused: user refused/,
    );
  } finally {
    await as.close();
  }
});

test("authorize: times out instead of waiting forever when no callback ever arrives", async () => {
  const as = await startFakeAuthServer();
  try {
    const metadata = await metadataFor(as);
    await assert.rejects(
      () =>
        authorize("remote", metadata, {
          openBrowser: () => {
            /* a browser that never completes — the user closed the tab */
          },
          timeoutMs: 300,
        }),
      AuthorizationError,
    );
  } finally {
    await as.close();
  }
});

test("registerClient: an AS with no registration endpoint returns undefined, and authorize reports it clearly", async () => {
  const as = await startFakeAuthServer({ noRegistration: true });
  try {
    const metadata = await metadataFor(as);
    assert.equal(await registerClient(metadata, "http://127.0.0.1:1/callback"), undefined);

    // The message has to name the fix, not just the problem: a dead end
    // with no remediation is a support ticket
    // (trellis-mcp-oauth-static-client design.md D3, tasks.md 2.3).
    await assert.rejects(
      () => authorize("remote", metadata, { openBrowser: (url) => as.authorizeViaBrowser(url) }),
      /offers no dynamic client registration.*auth\.client_id.*~\/\.trellis\/mcp\/servers\.yaml/s,
    );
  } finally {
    await as.close();
  }
});

test("authorize: the fake AS really does enforce PKCE — a wrong verifier is rejected", async () => {
  // Guards the guard. If this ever passes, every other PKCE assertion in
  // this file is worthless, because the AS would be accepting anything.
  const as = await startFakeAuthServer();
  try {
    const metadata = await metadataFor(as);
    const redirectUri = "http://127.0.0.1:1/callback";
    const registered = await registerClient(metadata, redirectUri);

    const authUrl = new URL(metadata.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", registered!.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", "Zm9vYmFyYmF6"); // not a hash of anything we hold
    authUrl.searchParams.set("code_challenge_method", "S256");
    const redirected = await fetch(authUrl.toString(), { redirect: "manual" });
    const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;

    const response = await fetch(metadata.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: registered!.clientId,
        code_verifier: "a-verifier-that-does-not-match",
      }).toString(),
    });

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /PKCE verification failed/);
  } finally {
    await as.close();
  }
});

// --- pre-registered client (trellis-mcp-oauth-static-client) ----------

test("authorize: a configured client_id skips registration entirely", async () => {
  const as = await startFakeAuthServer();
  try {
    const token = await authorize("remote", await metadataFor(as), {
      clientId: "static-client",
      openBrowser: (url) => as.authorizeViaBrowser(url),
    });

    assert.equal(token.clientId, "static-client");
    // The point of the feature: a provider that refuses DCR must never be
    // asked to register at all, not merely survive being refused
    // (design.md D3).
    assert.equal(as.registrations, 0);
  } finally {
    await as.close();
  }
});

test("authorize: a refused registration reports the provider's error code and names the fix", async () => {
  const as = await startFakeAuthServer({ rejectRegistration: true });
  try {
    const err = await authorize("remote", await metadataFor(as), { openBrowser: (url) => as.authorizeViaBrowser(url) }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.ok(err instanceof AuthorizationError, `expected an AuthorizationError, got ${String(err)}`);
    // The AS's own code, not just the status — it is what tells a person
    // this is an allowlist provider rather than a transient outage
    // (tasks.md 2.3).
    assert.match(err.message, /unauthorized_client/);
    assert.match(err.message, /auth\.client_id/);
    assert.match(err.message, /~\/\.trellis\/mcp\/servers\.yaml/);
    assert.equal(as.registrations, 0);
  } finally {
    await as.close();
  }
});

test("authorize: a refused registration is recovered from by configuring client_id", async () => {
  // The remediation the error message advertises has to actually work,
  // against the same server that just refused us.
  const as = await startFakeAuthServer({ rejectRegistration: true });
  try {
    const token = await authorize("remote", await metadataFor(as), {
      clientId: "static-client",
      openBrowser: (url) => as.authorizeViaBrowser(url),
    });
    assert.equal(token.clientId, "static-client");
    assert.match(token.accessToken, /^access-/);
  } finally {
    await as.close();
  }
});

test("authorize: a configured client_secret is presented at the token endpoint", async () => {
  const as = await startFakeAuthServer();
  try {
    const token = await authorize("remote", await metadataFor(as), {
      clientId: "confidential-client",
      clientSecret: "s3cret-from-env",
      openBrowser: (url) => as.authorizeViaBrowser(url),
    });

    assert.deepEqual(as.clientSecretsSeen, ["s3cret-from-env"]);
    // Stored alongside the grant so a later refresh presents it too —
    // otherwise the first refresh would fail for a confidential client.
    assert.equal(token.clientSecret, "s3cret-from-env");
  } finally {
    await as.close();
  }
});

test("authorize: no client_secret is sent when none was configured", async () => {
  const as = await startFakeAuthServer();
  try {
    await authorize("remote", await metadataFor(as), { openBrowser: (url) => as.authorizeViaBrowser(url) });
    assert.deepEqual(as.clientSecretsSeen, [], "a public client must not send an empty or spurious secret");
  } finally {
    await as.close();
  }
});
