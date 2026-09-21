import { useState } from "react";
import "./App.css";
import { SidecarProvider, useSidecar } from "./lib/SidecarProvider";
import { I18nProvider, useI18n, type TranslationKey } from "./lib/i18n";
import { AgentsView } from "./views/AgentsView";
import { McpView } from "./views/McpView";
import { SkillsView } from "./views/SkillsView";
import { MemoryView } from "./views/MemoryView";
import { SecretsView } from "./views/SecretsView";
import { BackupsView } from "./views/BackupsView";
import { DelegationView } from "./views/DelegationView";
import { OnboardView } from "./views/OnboardView";
import { ChatView } from "./views/ChatView";

const TABS: ReadonlyArray<{ id: string; labelKey: TranslationKey; render: () => ReturnType<typeof AgentsView> }> = [
  { id: "agents", labelKey: "nav.agents", render: () => <AgentsView /> },
  { id: "mcp", labelKey: "nav.mcp", render: () => <McpView /> },
  { id: "skills", labelKey: "nav.skills", render: () => <SkillsView /> },
  { id: "memory", labelKey: "nav.memory", render: () => <MemoryView /> },
  { id: "secrets", labelKey: "nav.secrets", render: () => <SecretsView /> },
  { id: "backups", labelKey: "nav.backups", render: () => <BackupsView /> },
  { id: "delegation", labelKey: "nav.delegation", render: () => <DelegationView /> },
  { id: "onboard", labelKey: "nav.onboard", render: () => <OnboardView /> },
  { id: "chat", labelKey: "nav.chat", render: () => <ChatView /> },
];

function LanguageSwitcher() {
  const { lang, setLang } = useI18n();
  return (
    <div className="lang-switcher">
      <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
        EN
      </button>
      <button className={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")}>
        中文
      </button>
    </div>
  );
}

function AppShell() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("agents");
  const { port, error } = useSidecar();
  const { t } = useI18n();
  const active = TABS.find((tb) => tb.id === tab) ?? TABS[0];

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="app-brand">
          <img src="/trellis-mark.svg" alt="" width={20} height={20} />
          <h1>Trellis</h1>
        </div>
        <ul>
          {TABS.map((tb) => (
            <li key={tb.id}>
              <button className={tb.id === tab ? "active" : ""} onClick={() => setTab(tb.id)}>
                {t(tb.labelKey)}
              </button>
            </li>
          ))}
        </ul>
        <LanguageSwitcher />
      </nav>
      <main className="app-content">
        {error && <div className="error-banner">{t("app.sidecarError", { error })}</div>}
        {port === undefined && !error && <p className="empty-state">{t("app.connecting")}</p>}
        {port !== undefined && active.render()}
      </main>
    </div>
  );
}

function App() {
  return (
    <I18nProvider>
      <SidecarProvider>
        <AppShell />
      </SidecarProvider>
    </I18nProvider>
  );
}

export default App;
