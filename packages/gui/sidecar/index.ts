/**
 * Trellis GUI sidecar — entry point. Per trellis-gui design.md Decision 1,
 * every route handler imports agent-trellis's internal command modules
 * directly via a workspace-relative path (not through the public
 * `agent-trellis` package export, whose barrel deliberately excludes
 * `src/commands/*` per the existing `trellis-sdk` spec). This is a
 * same-repo, same-commit workspace member, so that constraint is a normal
 * TypeScript reference, not a public API.
 *
 * `main()` only runs when this file is executed directly (the Tauri
 * shell's real launch path, task group 5) — not when `index.test.ts` (or
 * any other module) imports `proveInternalImportsWork` from it, which
 * must never have the side effect of binding a real port.
 */
import { homedir } from "node:os";
import { collectDoctorReport } from "../../../src/commands/doctor.js";
import { collectSyncReport } from "../../../src/commands/sync.js";
import { createSidecarServer, listenOnEphemeralLoopbackPort } from "./server.js";
import { createReadRoutes } from "./routes/read.js";
import { createPlanApplyRoutes } from "./routes/planApply.js";
import { createChatRoutes } from "./routes/chat.js";
import { createLiveUpdates } from "./liveUpdates.js";
import { createChatSessionStore } from "./chatSessionStore.js";
import { PlanStore } from "./planStore.js";

export async function proveInternalImportsWork(homeDir: string = homedir()): Promise<{ doctorOk: boolean; syncOk: boolean }> {
  const doctorReport = await collectDoctorReport(homeDir);
  const syncReport = await collectSyncReport({ homeDir, dryRun: true });
  return {
    doctorOk: Array.isArray(doctorReport.snapshots),
    syncOk: Array.isArray(syncReport.reports),
  };
}

async function main(): Promise<void> {
  const homeDir = homedir();
  const planStore = new PlanStore();
  const chatSessionStore = createChatSessionStore();
  // Created before the routes below so `createChatRoutes` can close over
  // `liveUpdates.broadcast` — chat streams over the same `/events` socket
  // the file watcher already uses (liveUpdates.ts's own doc comment).
  const liveUpdates = createLiveUpdates(homeDir);
  const server = createSidecarServer([
    ...createReadRoutes(homeDir),
    ...createPlanApplyRoutes(homeDir, planStore),
    ...createChatRoutes(homeDir, chatSessionStore, (message) => liveUpdates.broadcast(message)),
  ]);
  liveUpdates.attach(server);

  const port = await listenOnEphemeralLoopbackPort(server);
  // The one line of contract with the Tauri shell (task group 5): the
  // shell spawns this binary and reads its announced port from stdout —
  // nothing else is ever written to stdout, so this line is always the
  // first and only one.
  console.log(`TRELLIS_SIDECAR_PORT=${port}`);

  const shutdown = (): void => {
    liveUpdates.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  void main();
}
