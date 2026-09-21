import { useI18n } from "../lib/i18n";

/**
 * Placeholder per trellis-gui tasks.md 6.3: the delegated-call timeline
 * depends on `trellis-agent-bridge`'s audit trail, which is not built
 * yet (design.md Non-Goals). Stating that plainly here, rather than
 * omitting the screen or fabricating data, is the point of this file.
 */
export function DelegationView() {
  const { t } = useI18n();
  return (
    <section>
      <h2>{t("delegation.title")}</h2>
      <p className="subtitle">{t("delegation.notAvailable")}</p>
      <div className="card">
        <p style={{ margin: 0 }}>
          {t("delegation.bodyPre")} <code>{t("delegation.bodyCode")}</code>{t("delegation.bodyPost")}
        </p>
      </div>
    </section>
  );
}
