import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { startFakeAuthServer } from "../../../test/fixtures/fakeAuthServer.js";
import { OAuthJobs } from "../sidecar/oauthJobs.js";
import { createOAuthRoutes } from "../sidecar/routes/oauth.js";
import { createReadRoutes } from "../sidecar/routes/read.js";
import { createPlanApplyRoutes } from "../sidecar/routes/planApply.js";
import { PlanStore } from "../sidecar/planStore.js";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "../sidecar/server.js";
import { readToken, writeToken } from "../../../src/lib/oauth/store.js";
import { loadCanonicalSource } from "../../../src/core/canonical.js";
import { oauthOwner, isOAuthAuth } from "../../../src/core/types.js";

test("desktop authorization respects native ownership and completes/cancels/retries hosted grants in a real browser", async ({ page, context }) => {
  const as = await startFakeAuthServer();
  const dir = mkdtempSync(join(tmpdir(), "trellis-oauth-browser-"));
  mkdirSync(join(dir, ".trellis", "mcp"), { recursive: true });
  writeFileSync(join(dir, ".trellis", "managed.yaml"), "agents: []\n");
  writeFileSync(join(dir, ".trellis", "mcp", "servers.yaml"), `servers:\n  hosted:\n    transport: http\n    url: ${as.resourceUrl}\n    auth:\n      kind: oauth\n      owner: trellis\n  native:\n    transport: http\n    url: ${as.resourceUrl}\n    auth: oauth\n`);
  writeToken(dir, "native", { accessToken: "NATIVE-STRAY-MUST-NOT-RENDER", expiresAt: Date.now() + 3600000 });
  const { upsertServerYaml } = await import("../../../src/core/canonical.js");
  upsertServerYaml(join(dir, ".trellis", "mcp", "servers.yaml"), "plain", { transport: "http", url: as.resourceUrl });
  let pauseApproval = false;
  const authPages: Array<Awaited<ReturnType<typeof context.newPage>>> = [];
  const jobs = new OAuthJobs(dir, { openBrowser: async (url) => {
    const browser = await context.newPage();
    authPages.push(browser);
    if (!pauseApproval) await browser.goto(url);
  } });
  const server = createSidecarServer([...createReadRoutes(dir), ...createPlanApplyRoutes(dir, new PlanStore()), ...createOAuthRoutes(jobs)]);
  const port = await listenOnEphemeralLoopbackPort(server);
  const vite = await createViteServer({ configFile: resolve("vite.config.ts"), server: { host: "127.0.0.1", port: 1420, strictPort: true }, clearScreen: false });
  try {
    await vite.listen();
    await page.goto(`http://127.0.0.1:1420/?port=${port}`);
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    const hosted = page.getByRole("group", { name: "hosted", exact: true });
    const native = page.getByRole("group", { name: "native", exact: true });

    await test.step("native state is unknown and has no hosted authorize action", async () => {
      await expect(native).toContainText("Credential: unknown");
      await expect(native.getByRole("button", { name: /^Authorize/ })).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("NATIVE-STRAY-MUST-NOT-RENDER");
      expect(as.grants.length).toBe(0);
    });

    await test.step("clicking authorize completes real discovery, registration, PKCE and callback", async () => {
      await hosted.getByRole("button", { name: "Authorize", exact: true }).click();
      await expect(hosted.getByRole("status")).toHaveText("Authorization complete");
      await expect(hosted).toContainText("Credential: authorized");
      expect(as.grants.length).toBe(1);
      expect(authPages.length).toBe(1);
      const token = readToken(dir, "hosted")!;
      expect(token.accessToken).toBeTruthy();
      await expect(page.locator("body")).not.toContainText(token.accessToken);
      await expect(page.locator("body")).not.toContainText(token.refreshToken!);
    });

    await test.step("cancel preserves the saved credential and retry obtains a new grant", async () => {
      const prior = readToken(dir, "hosted");
      pauseApproval = true;
      await hosted.getByRole("button", { name: "Authorize again", exact: true }).click();
      await expect(hosted.getByRole("status")).toHaveText("Complete authorization in your browser");
      await hosted.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(hosted.getByRole("status")).toHaveText("Authorization cancelled");
      expect(readToken(dir, "hosted")).toEqual(prior);
      expect(as.grants.length).toBe(1);
      pauseApproval = false;
      await hosted.getByRole("button", { name: "Authorize again", exact: true }).click();
      await expect.poll(() => as.grants.length).toBe(2);
      await expect(hosted.getByRole("status")).toHaveText("Authorization complete");
    });

    await test.step("ownership changes require the desktop plan/apply confirmation", async () => {
      await native.getByRole("combobox", { name: "Authorization owner" }).selectOption("trellis");
      await expect(page.getByRole("heading", { name: 'Change authorization owner for "native"' })).toBeVisible();
      expect(oauthOwner(loadCanonicalSource(dir).mcp.servers.native!.auth)).toBe("agent");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await page.getByRole("button", { name: "MCP", exact: true }).click();
      await expect(native.getByRole("button", { name: "Authorize again", exact: true })).toBeVisible();
      expect(oauthOwner(loadCanonicalSource(dir).mcp.servers.native!.auth)).toBe("trellis");
      expect(as.grants.length).toBe(2);
    });

    await test.step("an imported remote connection can opt into OAuth and clear it entirely from the desktop", async () => {
      const plain = page.getByRole("group", { name: "plain", exact: true });
      await plain.getByRole("combobox", { name: "Authorization owner" }).selectOption("agent");
      await expect(page.getByRole("heading", { name: 'Change authorization owner for "plain"' })).toBeVisible();
      expect(isOAuthAuth(loadCanonicalSource(dir).mcp.servers.plain!.auth)).toBe(false);
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(plain).toContainText("Credential: unknown");
      expect(isOAuthAuth(loadCanonicalSource(dir).mcp.servers.plain!.auth)).toBe(true);
      await plain.getByRole("combobox", { name: "Authorization owner" }).selectOption("none");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(plain.getByRole("combobox", { name: "Authorization owner" })).toHaveValue("none");
      expect(isOAuthAuth(loadCanonicalSource(dir).mcp.servers.plain!.auth)).toBe(false);
      expect(as.grants.length).toBe(2);
    });
  } finally {
    jobs.close();
    for (const browser of authPages) await browser.close();
    await vite.close();
    await new Promise<void>((done) => server.close(() => done()));
    await as.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
