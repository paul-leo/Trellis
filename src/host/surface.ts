/**
 * `host` facade — surface read (host-extension-points spec).
 *
 * The narrow host boundary the self-evolution consumer codes against:
 * every function here is part of the published `./host` contract, and
 * nothing from `src/adapters/*` or `src/commands/*` is re-exported
 * through it. This module is the read half: hand the facade a home
 * directory (and optionally a workspace root) and get back the canonical
 * surface for that exact layer — read-only, no mutation, no rendering.
 */

import { loadCanonicalSource } from "../core/canonical.js";
import type { CanonicalSource } from "../core/types.js";

/** Which layer a surface read (or a structured check entry) belongs to.
 * A workspace layer is always pinned to a concrete root so two different
 * workspaces never share an identity. */
export type SurfaceLayer =
  | { kind: "global" }
  | { kind: "workspace"; root: string };

export interface ReadSurfaceOptions {
  homeDir: string;
  /** Explicit workspace root (as `findWorkspaceRoot` would return).
   * Omit or pass null for the global layer only. Never inferred from
   * `process.cwd()` — the host facade never guesses which project the
   * caller means. */
  workspaceRoot?: string | null;
}

export interface SurfaceRead {
  source: CanonicalSource;
  layer: SurfaceLayer;
}

/** Read the canonical surface at the requested layer. Read-only: the
 * returned `CanonicalSource` is the same structure every other reader
 * sees; this function writes nothing. */
export function readSurface(options: ReadSurfaceOptions): SurfaceRead {
  const workspaceRoot = options.workspaceRoot ?? null;
  const source = loadCanonicalSource({ homeDir: options.homeDir, workspaceDir: workspaceRoot });
  const layer: SurfaceLayer = workspaceRoot ? { kind: "workspace", root: workspaceRoot } : { kind: "global" };
  return { source, layer };
}
