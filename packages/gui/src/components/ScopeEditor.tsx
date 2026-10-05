import { useState } from "react";
import { useI18n } from "../lib/i18n";

export interface ScopeEditorProps {
  /** Every managed agent — the only agents a skill or MCP server can reach,
   * so the only ones offered (trellis-scope-editing-and-auth-status D8). */
  managed: readonly string[];
  /** The agents that reach the item right now (already intersected with the
   * managed set by the CLI's own listing). */
  current: readonly string[];
  /** Called with the staged selection when the user presses Save. Nothing is
   * written here — the caller opens the confirm modal with the plan. */
  onSave: (selected: string[]) => void;
}

/** The CLI's own selector triple. An empty selection is spelled `none`, never
 * an empty `agents` list, which the CLI refuses. */
export function scopeSelection(selected: readonly string[]): { none: true } | { agents: string } {
  return selected.length === 0 ? { none: true } : { agents: selected.join(",") };
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * One toggle per managed agent, staged locally. Mount it with a `key` that
 * changes whenever `current` does, so a successful apply (which refetches the
 * listing) resets the draft instead of leaving a stale selection on screen.
 */
export function ScopeEditor({ managed, current, onSave }: ScopeEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string[]>([...current]);

  if (managed.length === 0) {
    return <p className="subtitle" style={{ marginTop: "0.5rem", marginBottom: 0 }}>{t("scope.noManaged")}</p>;
  }

  const changed = !sameSelection(draft, current);
  const toggle = (id: string) => setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
        <span className="subtitle" style={{ margin: 0 }}>{t("scope.label")}</span>
        {managed.map((id) => {
          const on = draft.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              className={`tag ${on ? "ok" : ""}`}
              style={{ cursor: "pointer", opacity: on ? 1 : 0.6 }}
              onClick={() => toggle(id)}
            >
              {id}
            </button>
          );
        })}
        {changed && (
          <>
            <button className="primary" onClick={() => onSave(draft)}>{t("scope.save")}</button>
            <button onClick={() => setDraft([...current])}>{t("scope.reset")}</button>
          </>
        )}
      </div>
      {draft.length === 0 && (
        <p className="subtitle" style={{ margin: "0.4rem 0 0 0" }}>{changed ? t("scope.noneSelected") : t("common.noAgentReaches")}</p>
      )}
    </div>
  );
}
