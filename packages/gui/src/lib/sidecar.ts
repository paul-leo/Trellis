/**
 * Resolves the sidecar's own announced port (trellis-gui tasks.md 5.3),
 * then provides thin `GET`/`POST` wrappers for its `/plan/<op>` +
 * `/apply/<op>` contract (design.md Decision 4).
 *
 * Two ways to learn the port, both real, neither a stub:
 * 1. Inside the packaged Tauri app: `invoke("sidecar_port")` polls the
 *    Rust-side state `lib.rs`'s stdout-reader fills in once the sidecar
 *    prints its `TRELLIS_SIDECAR_PORT=` line.
 * 2. In a plain browser pointed at the Vite dev server (no Tauri host at
 *    all — how this file gets exercised by real browser automation
 *    during development, since `@tauri-apps/api`'s `invoke` has no
 *    non-Tauri implementation to fall back to): a `?port=` query
 *    parameter, for pointing the UI at a sidecar started by hand. This
 *    is a development convenience, not a shipped security surface — the
 *    packaged app never takes port numbers from a URL an untrusted party
 *    could control.
 */
import { invoke } from "@tauri-apps/api/core";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function portFromQueryString(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = new URLSearchParams(window.location.search).get("port");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function resolveSidecarPort(timeoutMs = 10_000): Promise<number> {
  const devPort = portFromQueryString();
  if (devPort !== undefined) return devPort;

  if (!isTauriRuntime()) {
    throw new Error("No Tauri runtime detected and no ?port= query parameter given — cannot reach the sidecar. Pass ?port=<n> when developing against a manually started sidecar.");
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const port = await invoke<number | null>("sidecar_port");
    if (typeof port === "number") return port;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the sidecar to announce its port.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function getJson<T>(port: number, path: string): Promise<T> {
  const res = await fetch(`${baseUrl(port)}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function postJson<T>(port: number, path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${baseUrl(port)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export function websocketUrl(port: number): string {
  return `ws://127.0.0.1:${port}/events`;
}
