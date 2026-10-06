import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "oauth.spec.ts",
  workers: 1,
  timeout: 60000,
  use: { channel: "chrome", headless: true, trace: "retain-on-failure" },
  reporter: "list",
});
