import { useEffect, useState } from "react";
import { useSidecar } from "../lib/SidecarProvider";
import { getJson, postJson } from "../lib/sidecar";
import { useI18n } from "../lib/i18n";

interface Job {
  id: string;
  status: "discovering" | "registering" | "waiting" | "exchanging" | "saving" | "succeeded" | "failed" | "cancelled" | "timed-out";
  error?: "configuration-changed" | "authorization-failed";
}
const done = (status: string): boolean => ["succeeded", "failed", "cancelled", "timed-out"].includes(status);

export function OAuthAuthorization({ server, authorized, onAuthorized }: { server: string; authorized: boolean; onAuthorized: () => void }) {
  const { port } = useSidecar();
  const { t } = useI18n();
  const [job, setJob] = useState<Job>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!job?.id || port === undefined || done(job.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const current = await getJson<Job>(port, `/oauth/jobs/${job.id}`);
        if (cancelled) return;
        setError(undefined);
        setJob(current);
        if (done(current.status)) { if (current.status === "succeeded") onAuthorized(); return; }
        timer = setTimeout(() => { void poll(); }, 500);
      } catch {
        if (!cancelled) { setError(t("mcp.oauth.pollFailed")); timer = setTimeout(() => { void poll(); }, 1500); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.id, port]);

  const busy = starting || Boolean(job && !done(job.status));

  async function start(): Promise<void> {
    if (port === undefined || busy) return;
    setStarting(true); setError(undefined);
    try {
      const current = await postJson<Job>(port, "/oauth/start", { server, force: authorized });
      setJob(current);
      if (current.status === "succeeded") onAuthorized();
    } catch { setError(t("mcp.oauth.startFailed")); }
    finally { setStarting(false); }
  }

  async function cancel(): Promise<void> {
    if (port === undefined || !job) return;
    try { setJob(await postJson<Job>(port, `/oauth/jobs/${job.id}/cancel`)); }
    catch { setError(t("mcp.oauth.cancelFailed")); }
  }

  return <div style={{ marginTop: "0.75rem" }}>
    <button disabled={port === undefined || busy} onClick={() => { void start(); }}>
      {authorized ? t("mcp.oauth.reauthorize") : t("mcp.oauth.authorize")}
    </button>
    {job && <span role="status" style={{ marginLeft: "0.75rem" }}>{t(`mcp.oauth.${job.status}`)}</span>}
    {job && !done(job.status) && <button onClick={() => { void cancel(); }} style={{ marginLeft: "0.75rem" }}>{t("common.cancel")}</button>}
    {job?.error && <p className="error-banner">{t(`mcp.oauth.${job.error}`)}</p>}
    {error && <p className="error-banner">{error}</p>}
  </div>;
}
