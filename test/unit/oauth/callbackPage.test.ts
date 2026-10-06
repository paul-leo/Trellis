import assert from "node:assert/strict";
import { test } from "node:test";
import { authorize } from "../../../src/lib/oauth/flow.js";
import { renderCallbackPage } from "../../../src/lib/oauth/callbackPage.js";
import { discoverAuthorizationServer } from "../../../src/lib/oauth/discovery.js";
import { startFakeAuthServer } from "../../fixtures/fakeAuthServer.js";

test("callback receipt uses private branded HTML while the real PKCE exchange completes", async () => {
  const as = await startFakeAuthServer();
  try {
    const metadata = await discoverAuthorizationServer(as.resourceUrl);
    assert.ok(metadata);
    let html = "";
    let headers: Headers | undefined;
    let returnedCode = "";
    let returnedState = "";
    const token = await authorize("Sentry <workspace>", metadata, {
      openBrowser: async (url) => {
        const response = await fetch(url, { redirect: "manual" });
        const callback = new URL(response.headers.get("location")!);
        returnedCode = callback.searchParams.get("code")!;
        returnedState = callback.searchParams.get("state")!;
        const receipt = await fetch(callback, { headers: { "accept-language": "zh-CN, en;q=0.9" } });
        headers = receipt.headers;
        html = await receipt.text();
      },
    });
    assert.match(token.accessToken, /^access-/);
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /授权响应已接收/);
    assert.match(html, /Sentry &#60;workspace&#62;/);
    assert.match(html, /查看最终连接结果/);
    assert.ok(!html.includes(returnedCode));
    assert.ok(!html.includes(returnedState));
    assert.ok(!html.includes(token.accessToken));
    assert.equal(headers?.get("cache-control"), "no-store");
    assert.equal(headers?.get("referrer-policy"), "no-referrer");
    assert.equal(headers?.get("x-content-type-options"), "nosniff");
    const nonce = /script-src 'nonce-([^']+)'/.exec(headers?.get("content-security-policy") ?? "")?.[1];
    assert.ok(nonce);
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.ok(html.includes(`<style nonce="${nonce}">`));
    assert.match(headers?.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  } finally { await as.close(); }
});

test("provider cancellation and hostile descriptions remain flow errors without appearing in HTML", async () => {
  const as = await startFakeAuthServer();
  try {
    const metadata = await discoverAuthorizationServer(as.resourceUrl);
    assert.ok(metadata);
    let html = "";
    const description = '<script>window.injected=true</script> PRIVATE-PROVIDER-DIAGNOSTIC';
    await assert.rejects(() => authorize("service", metadata, {
      openBrowser: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
        redirect.searchParams.set("error", "access_denied");
        redirect.searchParams.set("error_description", description);
        const response = await fetch(redirect);
        html = await response.text();
      },
    }), /was refused/);
    assert.match(html, /Authorization cancelled/);
    assert.ok(!html.includes(description));
    assert.ok(!html.includes("PRIVATE-PROVIDER-DIAGNOSTIC"));
    assert.equal(as.grants.length, 0);
  } finally { await as.close(); }
});

test("rendered receipt never turns hostile labels or errors into markup or a success claim", () => {
  const received = renderCallbackPage({ serverName: '"><img src=x onerror="alert(1)">', hasCode: true });
  assert.match(received.html, /Authorization response received/);
  assert.ok(!received.html.includes('<img src=x'));
  assert.ok(!received.html.includes("Authorization complete"));
  const error = renderCallbackPage({ serverName: "remote", hasCode: false, error: "<svg onload=alert(1)>" });
  assert.match(error.html, /Authorization could not continue/);
  assert.ok(!error.html.includes("onload=alert"));
  const missing = renderCallbackPage({ serverName: "remote", hasCode: false });
  assert.match(missing.html, /Authorization response incomplete/);
  assert.match(missing.html, /<p id="manual-close" class="help">/);
});
