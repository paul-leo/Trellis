/**
 * 进化仪表盘(trellis-evolve-visualization 任务 3.2)。
 *
 * 数据来自 `/evolve/report`(sidecar 镜像 `trellis evolve report --json`
 * 的同一份聚合);只读消费,任何操作都不写状态。三段:趋势(真实测量,
 * 含口径;不含合成评分)/ 优化内容卡(前后测量差集 + 编辑清单)/ 提案
 * 时间线(可追踪链,含回滚入口)。未开启/未运行是一等空态。
 */
import { useFetch } from "../lib/useFetch";
import { useI18n } from "../lib/i18n";

interface TimelineStep {
  stage: string;
  at: string;
  note: string;
}

interface ProposalMeasurement {
  decision: string;
  reason: string;
  targetIds: string[];
  resolvedIds: string[];
  introduced: string[];
}

interface EditOp {
  op: string;
  path: string;
}

interface ProposalTrace {
  id: string;
  summary: string;
  kind: string;
  riskClass: string | null;
  status: string;
  chain: TimelineStep[];
  measurement: ProposalMeasurement | null;
  edits: EditOp[];
  backupRunId: string | null;
  lessonId: string | null;
}

interface TrendMetric {
  id: string;
  label: string;
  value: number | null;
  source: string;
}

interface EvolveReport {
  state: "not-enabled" | "enabled-idle" | "active";
  levels: { defaultLevel: string | null; agents: Record<string, string>; workspaces: Record<string, string> };
  counts: { pending: number; approved: number; rejected: number };
  timeline: ProposalTrace[];
  trends: TrendMetric[];
  jobRuns: { startedAt: string; endedAt: string | null; ok: boolean; error: string | null; summary: { signalsConsidered: number | null; enqueued: number | null; autoAdopted: number | null } }[];
  notices: string[];
}

/** 轻量 SVG 比率条(0–1 指标;count 类直接显示数值,不画假图)。 */
function RateBar({ value }: { value: number }) {
  const width = Math.max(0, Math.min(1, value)) * 120;
  return (
    <svg width="124" height="10" aria-hidden="true" style={{ verticalAlign: "middle", marginLeft: 8 }}>
      <rect x="0" y="0" width="124" height="10" fill="rgba(128,128,128,0.25)" rx="4" />
      <rect x="0" y="0" width={width} height="10" fill="#4c8bf5" rx="4" />
    </svg>
  );
}

function MeasurementBlock({ m }: { m: ProposalMeasurement | null }) {
  const { t } = useI18n();
  if (m === null) {
    return <p className="subtitle" style={{ margin: "0.25rem 0 0" }}>{t("evolution.noMeasurement")}</p>;
  }
  return (
    <p className="subtitle" style={{ margin: "0.25rem 0 0" }}>
      {t("evolution.measurement", {
        decision: m.decision,
        resolved: m.resolvedIds.length,
        target: m.targetIds.length,
        introduced: m.introduced.length,
      })}
      <br />
      <span style={{ opacity: 0.75 }}>{m.reason}</span>
    </p>
  );
}

export function EvolutionView() {
  const { data, error, loading } = useFetch<EvolveReport>("/evolve/report");
  const { t } = useI18n();

  return (
    <section>
      <h2>{t("evolution.title")}</h2>
      <p className="subtitle">{t("evolution.subtitle")}</p>
      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty-state">{t("common.loading")}</p>}

      {data?.state === "not-enabled" && (
        <div className="card">
          <p className="empty-state">{t("evolution.notEnabled")}</p>
          <p className="subtitle">{t("evolution.notEnabledHint")}</p>
        </div>
      )}
      {data?.state === "enabled-idle" && <p className="empty-state">{t("evolution.idle")}</p>}

      {data && (data.state === "active" || data.state === "enabled-idle") && (
        <>
          {/* 趋势:真实测量 + 口径;数值分数轴等 L2 探针落地后另加 */}
          <h3>{t("evolution.trends")}</h3>
          <div className="card">
            {data.trends.map((metric) => (
              <div className="card-row" key={metric.id}>
                <span>
                  <strong>{metric.label}</strong>
                  {" "}
                  {metric.value === null
                    ? t("evolution.noMeasurement")
                    : metric.id.endsWith("rate")
                      ? (<>{(metric.value * 100).toFixed(0)}%<RateBar value={metric.value} /></>)
                      : metric.value}
                  <br />
                  <span className="subtitle" style={{ margin: 0 }}>{t("evolution.source", { source: metric.source })}</span>
                </span>
              </div>
            ))}
          </div>

          {/* 优化内容:前后测量差集 + 编辑清单 */}
          <h3>{t("evolution.optimizations")}</h3>
          {data.timeline.filter((trace) => trace.status === "applied").length === 0 && (
            <p className="empty-state">{t("evolution.noOptimizations")}</p>
          )}
          {data.timeline
            .filter((trace) => trace.status === "applied")
            .map((trace) => (
              <div className="card" key={trace.id}>
                <div className="card-row">
                  <span className="card-title">{trace.summary}</span>
                  {trace.riskClass && <span className="subtitle">risk={trace.riskClass}</span>}
                </div>
                <MeasurementBlock m={trace.measurement} />
                <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                  {trace.edits.map((edit, i) => (
                    <li key={i} className="subtitle" style={{ margin: 0 }}>
                      {edit.op} — {edit.path}
                    </li>
                  ))}
                </ul>
                {trace.backupRunId && (
                  <p className="subtitle" style={{ margin: "0.5rem 0 0" }}>
                    {t("evolution.rollback", { runId: trace.backupRunId })}
                  </p>
                )}
              </div>
            ))}

          {/* 时间线:全生命周期可追踪 */}
          <h3>{t("evolution.timeline")}</h3>
          {data.timeline.length === 0 && <p className="empty-state">{t("evolution.emptyTimeline")}</p>}
          {data.timeline.map((trace) => (
            <div className="card" key={`tl-${trace.id}`}>
              <div className="card-row">
                <span className="card-title">{trace.id}</span>
                <span className="subtitle">{trace.status}</span>
              </div>
              <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                {trace.chain.map((step, i) => (
                  <li key={i} className="subtitle" style={{ margin: 0 }}>
                    <span style={{ opacity: 0.7 }}>{step.at}</span> — <strong>{step.stage}</strong>: {step.note}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
