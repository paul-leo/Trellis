/**
 * Per-server exclusive lock around OAuth refresh
 * (trellis-mcp-gateway-hosting design.md D16).
 *
 * Why this is a correctness fix and not an optimization: most
 * authorization servers rotate the refresh token on each
 * `refresh_token` grant and invalidate the previous one. Two processes
 * refreshing the same server concurrently therefore leave one of them
 * holding a token that is already dead — and it fails later, somewhere
 * else, looking like an unrelated auth error. This is reachable today
 * with a single gateway, because `trellis mcp auth` can be run by hand
 * while one is live.
 *
 * Scoped to one server: a slow refresh for server A must never delay
 * connecting to server B.
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lockPath } from "./store.js";

/** A holder that died without cleaning up would otherwise wedge every
 * later refresh forever. Two independent recovery signals are used: the
 * recorded pid no longer existing, and the lock simply being older than
 * any plausible refresh. */
const STALE_AFTER_MS = 60_000;
const POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 30_000;

interface LockContents {
  pid: number;
  acquiredAt: number;
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without
    // delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(path: string, now: number): boolean {
  let contents: LockContents;
  try {
    contents = JSON.parse(readFileSync(path, "utf-8")) as LockContents;
  } catch {
    // Unreadable or half-written: treat as stale rather than deadlocking
    // on a file nobody can interpret.
    return true;
  }
  if (typeof contents.pid !== "number" || typeof contents.acquiredAt !== "number") return true;
  if (now - contents.acquiredAt > STALE_AFTER_MS) return true;
  return !processAlive(contents.pid);
}

/**
 * Runs `fn` while holding this server's lock, releasing it even if `fn`
 * throws. `wx` is the atomic primitive: it either creates the file or
 * fails, with no check-then-create window between two processes.
 */
export async function withServerLock<T>(
  homeDir: string,
  serverName: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<T> {
  const path = lockPath(homeDir, serverName);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: now() } satisfies LockContents));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (existsSync(path) && isStale(path, now())) {
        // Best-effort: if another process removed it first, our next
        // `wx` attempt simply succeeds.
        rmSync(path, { force: true });
        continue;
      }
      if (now() >= deadline) {
        throw new Error(`timed out waiting for the OAuth refresh lock on "${serverName}" (${path})`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
