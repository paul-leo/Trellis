/**
 * A GUI app launched by double-clicking in Finder (or from the Dock) is
 * spawned by launchd, which hands it a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin` plus a couple more) — not the PATH a
 * user's actual login shell has after `.zshrc`/`.zprofile` run (Volta,
 * nvm, Homebrew, etc. all extend PATH there). Every probe in `src/probes/`
 * shells out to a bare binary name (`codex`, `kimi`, `kiro-cli`, ...), so
 * under the Finder-launched sidecar those binaries can genuinely exist on
 * the machine yet still fail with ENOENT — not because they're missing,
 * but because this process can't see where they live. `trellis` run from
 * a terminal never hits this, since a terminal's shell already sourced
 * those rc files before spawning the CLI.
 *
 * Fix: ask the user's own login shell what its PATH is, once, at sidecar
 * startup, and adopt it. `-ilc` (interactive + login) is required, not
 * just `-l` — Volta/nvm typically export PATH from `.zshrc`, which only
 * an *interactive* shell sources; a login-only shell would miss it.
 */
import { execFileSync } from "node:child_process";

export interface ResolveShellPathOptions {
  shell?: string;
  timeoutMs?: number;
  /** Merged onto `process.env` for the spawned shell (test hook — lets a
   * test pin just `PATH` without losing `HOME`/etc. an interactive shell
   * needs to start up cleanly). Defaults to `process.env` unchanged. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns the PATH the user's real login shell would have, or `undefined`
 * if it can't be determined (missing/unspawnable shell, timeout, empty
 * output) — callers must fall back to the existing `process.env.PATH`
 * rather than treat `undefined` as an error.
 */
export function resolveLoginShellPath(opts: ResolveShellPathOptions = {}): string | undefined {
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  const timeout = opts.timeoutMs ?? 3_000;
  try {
    // `${PATH}`, not `$PATH` — a bare `$PATH` followed immediately by the
    // marker's own text would parse as one (nonexistent) shell variable
    // name `$PATH__TRELLIS_PATH__` and silently expand to nothing.
    const raw = execFileSync(shell, ["-ilc", "echo -n __TRELLIS_PATH__${PATH}__TRELLIS_PATH__"], {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    const match = /__TRELLIS_PATH__(.*)__TRELLIS_PATH__/s.exec(raw);
    const path = match?.[1]?.trim();
    return path && path.length > 0 ? path : undefined;
  } catch {
    // Missing shell binary, non-zero exit (e.g. a broken rc file), or a
    // timeout — none of these should ever crash sidecar startup.
    return undefined;
  }
}

/**
 * Merges the login shell's PATH into `env.PATH` (default `process.env`),
 * in place. A no-op when resolution fails, so callers don't need their own
 * fallback branch. Returns `true` iff it actually changed `PATH`.
 */
export function applyLoginShellPath(opts: ResolveShellPathOptions = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = resolveLoginShellPath(opts);
  if (resolved === undefined) return false;
  const existing = env.PATH ?? "";
  const existingEntries = new Set(existing.split(":").filter(Boolean));
  const merged = [...resolved.split(":").filter(Boolean), ...existingEntries].filter(
    (entry, index, all) => all.indexOf(entry) === index,
  );
  env.PATH = merged.join(":");
  return true;
}
