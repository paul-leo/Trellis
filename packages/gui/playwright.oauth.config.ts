import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["oauth.spec.ts", "oauthCallback.spec.ts"],
  workers: 1,
  timeout: 60000,
  use: {
    ...(process.env.TRELLIS_OAUTH_BROWSER_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.TRELLIS_OAUTH_BROWSER_EXECUTABLE } }
      : { channel: "chrome" }),
    headless: true,
    trace: "retain-on-failure",
  },
  reporter: "list",
});
