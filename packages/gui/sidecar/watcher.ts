/**
 * A `~/.trellis/**` file watcher (trellis-gui spec: "Live state updates
 * on canonical source changes"). `fs.watch`'s `recursive: true` option is
 * only reliable on macOS and Windows — Linux needs its own manual
 * recursive-watch shim — which is fine for v1: design.md Decision 5 scopes
 * packaging to macOS only, and this module is part of that same v1 scope,
 * not a cross-platform guarantee being silently assumed.
 *
 * Debounced per changed path: a single logical save can fire several raw
 * fs events in quick succession (write + rename + metadata touch) —
 * collapsing them keeps the "exactly one broadcast per changed path"
 * guarantee (tasks.md 4.2) true regardless of whether the write came from
 * outside the sidecar (a directly-invoked `trellis sync`) or through the
 * sidecar's own `/apply/*` endpoints, since this is the only place that
 * ever calls `onChange` — there is deliberately no second, apply-route-side
 * broadcast to ever duplicate against.
 */

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface TrellisChangeEvent {
  type: "change";
  /** Relative to `~/.trellis/`, e.g. `mcp/servers.yaml`. */
  path: string;
}

export interface TrellisWatcher {
  close(): void;
}

const DEFAULT_DEBOUNCE_MS = 100;

export function watchTrellisHome(
  homeDir: string,
  onChange: (event: TrellisChangeEvent) => void,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): TrellisWatcher {
  const root = join(homeDir, ".trellis");
  const pending = new Map<string, NodeJS.Timeout>();

  let fsWatcher: FSWatcher;
  try {
    fsWatcher = watch(root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const path = filename.toString();
      const existing = pending.get(path);
      if (existing) clearTimeout(existing);
      pending.set(
        path,
        setTimeout(() => {
          pending.delete(path);
          onChange({ type: "change", path });
        }, debounceMs),
      );
    });
  } catch {
    // `root` not existing yet (e.g. sidecar started before `trellis init`)
    // is a real, reachable startup ordering — not a crash. No events ever
    // fire until the sidecar is restarted against an initialized home;
    // acceptable for v1 (the GUI's own onboard flow is what creates
    // `~/.trellis` in the first place).
    fsWatcher = { close: () => {} } as FSWatcher;
  }

  return {
    close(): void {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      fsWatcher.close();
    },
  };
}
