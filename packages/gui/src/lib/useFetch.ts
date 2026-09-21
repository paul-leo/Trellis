import { useEffect, useState } from "react";
import { useSidecar } from "./SidecarProvider";
import { getJson } from "./sidecar";

/**
 * Fetches `path` once the sidecar port is known, and refetches whenever
 * `liveVersion` changes (a WebSocket change event arrived) — the
 * subscribe-and-rerender-without-a-manual-reload contract every read
 * view needs (trellis-gui tasks.md 6.2).
 */
export function useFetch<T>(path: string): { data: T | undefined; error: string | undefined; loading: boolean } {
  const { port, liveVersion } = useSidecar();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (port === undefined) return;
    let cancelled = false;
    setLoading(true);
    getJson<T>(port, path)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [port, path, liveVersion]);

  return { data, error, loading };
}
