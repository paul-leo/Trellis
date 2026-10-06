import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { authorize } from "../../../src/lib/oauth/flow.js";
import { discoverAuthorizationServer } from "../../../src/lib/oauth/discovery.js";
import { startFakeAuthServer } from "../../../test/fixtures/fakeAuthServer.js";

// Role selectors confirmed against the actual callback's ariaSnapshot on
// 2026-10-06. All requests use a local fixture and synthetic credentials.
test("callback feedback is private, responsive, localized, and usable when closing is blocked", async ({ browser }) => {
  const as = await startFakeAuthServer();
  const metadata = await discoverAuthorizationServer(as.resourceUrl);
  expect(metadata).toBeTruthy();
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.addInitScript(() => { window.close = () => {}; });
  const screenshotDir = process.env.TRELLIS_OAUTH_SCREENSHOTS;
  if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
  const requestOrigins: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (request) => requestOrigins.push(new URL(request.url()).hostname));
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  try {
    await test.step("real PKCE callback hides parameters without claiming saved credentials", async () => {
      const token = await authorize("sentry", metadata!, {
        openBrowser: async (url) => { await page.goto(url); },
      });
      await expect(page.getByRole("heading", { name: "授权响应已接收" })).toBeVisible();
      await expect(page).toHaveTitle("授权响应已接收 · Trellis");
      await expect(page.locator(".server")).toHaveText("sentry");
      expect(new URL(page.url()).search).toBe("");
      expect(new URL(page.url()).hash).toBe("");
      expect(new URL(page.url()).pathname).toBe("/callback");
      await expect(page.locator("body")).not.toContainText(token.accessToken);
      await expect(page.locator("body")).not.toContainText(token.refreshToken!);
      await expect(page.locator("body")).not.toContainText("授权成功");
      expect(requestOrigins.every((host) => host === "127.0.0.1")).toBe(true);
      expect(consoleErrors).toEqual([]);
      if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/callback-desktop-zh.png`, fullPage: true });
    });

    await test.step("close fallback is keyboard accessible", async () => {
      const close = page.getByRole("button", { name: "关闭此标签页" });
      await close.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status")).toContainText("手动关闭此标签页");
      await expect(page.getByRole("status")).toBeFocused();
      if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/callback-close-fallback-zh.png`, fullPage: true });
    });

    await test.step("cancellation remains readable on a narrow screen and does not render provider text", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const attempt = authorize("sentry", metadata!, {
        openBrowser: async (url) => {
          const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("error_description", "<script>window.injected=true</script> PRIVATE-DIAGNOSTIC");
          await page.goto(redirect.toString());
        },
      }).then(() => null, (error: Error) => error);
      expect(await attempt).toBeInstanceOf(Error);
      await expect(page.getByRole("heading", { name: "授权已取消" })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("PRIVATE-DIAGNOSTIC");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/callback-cancelled-mobile-zh.png`, fullPage: true });
    });

    await test.step("long hostile labels and provider errors remain text on the smallest viewport", async () => {
      await page.setViewportSize({ width: 320, height: 740 });
      const label = '<img src=x onerror="alert(1)">' + "long-service-name-".repeat(14);
      const attempt = authorize(label, metadata!, {
        openBrowser: async (url) => {
          const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
          redirect.searchParams.set("error", "server_error");
          await page.goto(redirect.toString());
        },
      }).then(() => null, (error: Error) => error);
      expect(await attempt).toBeInstanceOf(Error);
      await expect(page.getByRole("heading", { name: "授权暂未完成" })).toBeVisible();
      await expect(page.locator(".server")).toHaveText(label);
      await expect(page.locator("img")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(consoleErrors).toEqual([]);
    });
  } finally { await context.close(); await as.close(); }
});

test("English errors and JavaScript-disabled receipts retain final-result and manual-close guidance", async ({ browser }) => {
  const as = await startFakeAuthServer();
  const metadata = await discoverAuthorizationServer(as.resourceUrl);
  expect(metadata).toBeTruthy();
  try {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      const attempt = authorize("sentry", metadata!, {
        openBrowser: async (url) => {
          const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);
          redirect.searchParams.set("error", "server_error");
          await page.goto(redirect.toString());
        },
      }).then(() => null, (error: Error) => error);
      expect(await attempt).toBeInstanceOf(Error);
      await expect(page.getByRole("heading", { name: "Authorization could not continue" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Close this tab" })).toBeVisible();
      if (process.env.TRELLIS_OAUTH_SCREENSHOTS) await page.screenshot({ path: `${process.env.TRELLIS_OAUTH_SCREENSHOTS}/callback-error-en.png`, fullPage: true });
    } finally { await context.close(); }

    const noJs = await browser.newContext({ locale: "en-US", javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const receipt = await noJs.newPage();
    try {
      await authorize("remote", metadata!, { openBrowser: async (url) => { await receipt.goto(url); } });
      await expect(receipt.getByRole("heading", { name: "Authorization response received" })).toBeVisible();
      await expect(receipt.getByText("You can close this tab manually and return to Trellis or your terminal.")).toBeVisible();
      await expect(receipt.getByRole("button", { name: "Close this tab" })).toBeHidden();
    } finally { await noJs.close(); }
  } finally { await as.close(); }
});
