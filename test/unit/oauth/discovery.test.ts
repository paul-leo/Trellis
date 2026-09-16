/**
 * Metadata discovery (trellis-mcp-gateway-hosting tasks.md 5.1/5.6).
 *
 * Driven against the real fake Authorization Server over loopback HTTP,
 * one test per strategy in the fallback ladder — the point being that
 * each shape found in the wild resolves, and that a server offering none
 * of them reports nothing rather than inventing an endpoint.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverAuthorizationServer, parseResourceMetadataUrl } from "../../../src/lib/oauth/discovery.js";
import { startFakeAuthServer, startFakeResourceServer } from "../../fixtures/fakeAuthServer.js";

test("discovery: root RFC 8414 metadata", async () => {
  const as = await startFakeAuthServer();
  try {
    const metadata = await discoverAuthorizationServer(as.resourceUrl);
    assert.equal(metadata?.issuer, as.url);
    assert.equal(metadata?.authorizationEndpoint, `${as.url}/authorize`);
    assert.equal(metadata?.tokenEndpoint, `${as.url}/token`);
    assert.equal(metadata?.registrationEndpoint, `${as.url}/register`);
    assert.deepEqual(metadata?.codeChallengeMethodsSupported, ["S256"]);
  } finally {
    await as.close();
  }
});

test("discovery: path-aware RFC 8414 metadata, for a server mounted under a path", async () => {
  // `https://host/mcp` → `https://host/.well-known/oauth-authorization-server/mcp`.
  // The well-known segment goes after the host, not appended to the path.
  const as = await startFakeAuthServer({ pathAwareMetadataOnly: true });
  try {
    const metadata = await discoverAuthorizationServer(as.resourceUrl);
    assert.equal(metadata?.tokenEndpoint, `${as.url}/token`);
  } finally {
    await as.close();
  }
});

test("discovery: RFC 9728 protected-resource metadata resolves an AS on a different origin", async () => {
  const as = await startFakeAuthServer();
  const resource = await startFakeResourceServer(as.url);
  try {
    // The resource origin serves NO authorization-server metadata of its
    // own, so probing its well-known paths can only 404. The single way
    // this resolves is by reading the protected-resource document and
    // following it to the AS — which is the whole reason RFC 9728 exists.
    const metadata = await discoverAuthorizationServer(resource.resourceUrl);
    assert.equal(metadata?.issuer, as.url);
    assert.equal(metadata?.tokenEndpoint, `${as.url}/token`);
  } finally {
    await resource.close();
    await as.close();
  }
});

test("discovery: a WWW-Authenticate header short-circuits the probe ladder", async () => {
  const as = await startFakeAuthServer();
  const resource = await startFakeResourceServer(as.url);
  try {
    const metadata = await discoverAuthorizationServer("http://127.0.0.1:1/mcp", {
      wwwAuthenticate: `Bearer realm="mcp", resource_metadata="${resource.metadataUrl}"`,
    });
    // The resource URL passed in is deliberately unreachable: nothing can
    // be probed from it, so resolving at all proves the header was
    // followed.
    assert.equal(metadata?.issuer, as.url);
  } finally {
    await resource.close();
    await as.close();
  }
});

test("parseResourceMetadataUrl: reads the RFC 9728 parameter, ignores everything else", () => {
  assert.equal(parseResourceMetadataUrl(`Bearer realm="x", resource_metadata="https://as.test/.well-known/y"`), "https://as.test/.well-known/y");
  assert.equal(parseResourceMetadataUrl("Bearer realm=\"x\""), undefined);
  assert.equal(parseResourceMetadataUrl(null), undefined);
});

test("discovery: a server offering no metadata at all resolves to undefined, never a guessed endpoint", async () => {
  const metadata = await discoverAuthorizationServer("http://127.0.0.1:1/mcp");
  assert.equal(metadata, undefined);
});

test("discovery: a metadata document missing token_endpoint is treated as no document", async () => {
  // A partial document is the dangerous case: half-usable metadata would
  // otherwise produce a client that fails much later, at redemption.
  const partial = { issuer: "https://as.test", authorization_endpoint: "https://as.test/authorize" };
  const metadata = await discoverAuthorizationServer("https://resource.test/mcp", {
    fetchImpl: async (url: string) =>
      ({
        ok: url.includes(".well-known/oauth-authorization-server"),
        status: 200,
        headers: { get: () => null },
        json: async () => partial,
        text: async () => JSON.stringify(partial),
      }) as never,
  });
  assert.equal(metadata, undefined);
});
