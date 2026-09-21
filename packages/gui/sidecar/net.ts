/** Loopback-only enforcement (trellis-gui spec: "Local-only binding").
 * Binding the server itself to `127.0.0.1` is the primary guarantee — the
 * OS never delivers a non-loopback packet to a socket bound only there.
 * This is the explicit, testable second layer: a per-connection check that
 * stays correct even if the bind address is ever changed by mistake. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}
