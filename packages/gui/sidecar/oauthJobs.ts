import { randomUUID } from "node:crypto";
import { authorizeMcpServer, type RunMcpAuthOptions } from "../../../src/commands/mcpAuth.js";
import { loadCanonicalSource } from "../../../src/core/canonical.js";
import { isOAuthAuth, oauthOwner } from "../../../src/core/types.js";

export type OAuthJobStatus = "discovering" | "registering" | "waiting" | "exchanging" | "saving" | "succeeded" | "failed" | "cancelled" | "timed-out";
export interface OAuthJob {
  id: string;
  server: string;
  status: OAuthJobStatus;
  error?: "configuration-changed" | "authorization-failed";
}
const terminal = (status: OAuthJobStatus): boolean => ["succeeded", "failed", "cancelled", "timed-out"].includes(status);

export class OAuthJobs {
  private readonly jobs = new Map<string, { state: OAuthJob; abort: AbortController; timer: NodeJS.Timeout; createdAt: number }>();

  constructor(private readonly homeDir: string, private readonly options: {
    openBrowser?: RunMcpAuthOptions["openBrowser"];
    timeoutMs?: number;
    run?: typeof authorizeMcpServer;
    onChanged?: () => void;
  } = {}) {}

  start(serverName: string, force = false): OAuthJob {
    const def = loadCanonicalSource(this.homeDir).mcp.servers[serverName];
    if (!def?.url || def.enabled === false || !isOAuthAuth(def.auth) || oauthOwner(def.auth) !== "trellis") throw new Error("Only explicitly Trellis-owned remote servers can use hosted authorization");
    const active = [...this.jobs.values()].find(({ state }) => state.server === serverName && !terminal(state.status));
    if (active) return { ...active.state };
    for (const [id, job] of this.jobs) if (terminal(job.state.status) && Date.now() - job.createdAt > 600_000) this.jobs.delete(id);
    if ([...this.jobs.values()].filter((job) => !terminal(job.state.status)).length >= 32) throw new Error("Too many active authorization tasks");
    if (this.jobs.size >= 64) {
      const oldest = [...this.jobs].find(([, job]) => terminal(job.state.status));
      if (oldest) this.jobs.delete(oldest[0]);
    }
    const state: OAuthJob = { id: randomUUID(), server: serverName, status: "discovering" };
    const abort = new AbortController();
    const timer = setTimeout(() => {
      state.status = "timed-out";
      abort.abort(new Error("authorization timed out"));
    }, this.options.timeoutMs ?? 300_000);
    timer.unref();
    this.jobs.set(state.id, { state, abort, timer, createdAt: Date.now() });
    void (this.options.run ?? authorizeMcpServer)({
      serverName, homeDir: this.homeDir, force, requireHosted: true, signal: abort.signal,
      timeoutMs: this.options.timeoutMs,
      openBrowser: this.options.openBrowser,
      onProgress: (status) => { if (!terminal(state.status)) state.status = status; },
    }).then(() => {
      if (!terminal(state.status)) state.status = "succeeded";
    }, (err: unknown) => {
      if (terminal(state.status)) return;
      state.status = "failed";
      state.error = err instanceof Error && /configuration changed|endpoint.*changed/i.test(err.message) ? "configuration-changed" : "authorization-failed";
    }).finally(() => {
      clearTimeout(timer);
      this.options.onChanged?.();
    });
    return { ...state };
  }

  get(id: string): OAuthJob | undefined { const job = this.jobs.get(id); return job ? { ...job.state } : undefined; }

  cancel(id: string): OAuthJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!terminal(job.state.status)) {
      job.state.status = "cancelled";
      clearTimeout(job.timer);
      job.abort.abort(new Error("authorization cancelled"));
    }
    return { ...job.state };
  }

  close(): void { for (const id of this.jobs.keys()) this.cancel(id); }
}
