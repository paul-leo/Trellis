/**
 * Hand-rolled i18n, not `react-i18next` — the app has zero non-Tauri/React
 * runtime dependencies today, and the sidecar side of this same package
 * already commits to a "deliberately small dependency footprint"
 * (`server.ts`'s own doc comment). At ~90 keys across 11 files, a
 * Context + two dictionaries + `{var}` substitution covers the real
 * need without pulling in i18next's pluralization/lazy-loading machinery
 * this app has no use for.
 *
 * Only UI chrome (labels, buttons, static prose) is translated. Anything
 * that comes back from the sidecar as real data — agent ids, file paths,
 * commands, diagnostic/error text, MCP transport/enum values — is never
 * run through `t()`; translating a real file path or a real error message
 * would misrepresent what's actually on disk.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "zh";

const STORAGE_KEY = "trellis-gui-lang";

/** English is the authoritative key set — `t()` falls back to it for any
 * key `zh` hasn't got, so a missing translation degrades to English
 * rather than showing a raw key to the user. */
const en = {
  "nav.agents": "Agents",
  "nav.mcp": "MCP",
  "nav.skills": "Skills",
  "nav.memory": "Memory",
  "nav.secrets": "Secrets Audit",
  "nav.backups": "Backups",
  "nav.delegation": "Delegation",
  "nav.onboard": "Onboard",
  "nav.chat": "Chat",

  "app.sidecarError": "Could not reach the sidecar: {error}",
  "app.connecting": "Connecting to sidecar…",

  "common.loading": "Loading…",
  "common.add": "Add",
  "common.remove": "Remove",
  "common.sync": "Sync",
  "common.cancel": "Cancel",
  "common.apply": "Apply",
  "common.applying": "Applying…",
  "common.namePlaceholder": "name",
  "common.noAgentReaches": "no managed agent reaches it",
  "common.notInstalled": "not installed",
  "common.present": "present",

  "confirmModal.computingPlan": "Computing plan…",

  "agents.title": "Agents",
  "agents.subtitle": "Every agent slot Trellis can manage, and what `trellis doctor` currently sees on this machine.",
  "agents.summary": "{count} skill(s) · {mcpCount} MCP server(s)",
  "agents.findings": "Findings",

  "mcp.title": "MCP Servers",
  "mcp.subtitle": "Canonical MCP servers and which managed agents currently reach them.",
  "mcp.commandPlaceholder": "stdio command",
  "mcp.addTitle": 'Add MCP server "{name}"',
  "mcp.syncTitle": "Sync MCP servers to every managed agent",
  "mcp.importPlaceholder": 'path to a JSON file with a top-level "mcpServers" object',
  "mcp.import": "Import",
  "mcp.importTitle": "Import from {path}",
  "mcp.importHintPre": "Standard",
  "mcp.importHintCode": '{ "mcpServers": { ... } }',
  "mcp.importHintPost": "export (e.g. from Claude Desktop). Credential values are extracted into a local, gitignored env file — never written into",
  "mcp.importHintCode2": "servers.yaml",
  "mcp.empty": "No MCP servers in canonical source yet.",
  "mcp.removeTitle": 'Remove MCP server "{name}"',
  "mcp.disabled": "disabled",

  "skills.title": "Skills",
  "skills.subtitle": "Canonical Skills and which managed agents currently have them.",
  "skills.fromPlaceholder": "source path (SKILL.md dir)",
  "skills.addTitle": 'Add skill "{name}"',
  "skills.syncTitle": "Sync skills to every managed agent",
  "skills.empty": "No skills in canonical source yet.",
  "skills.removeTitle": 'Remove skill "{name}"',
  "scope.label": "Reaches",
  "scope.save": "Save scope",
  "scope.reset": "Reset",
  "scope.noManaged": "No managed agents yet — finish onboarding first.",
  "scope.noneSelected": "No agent selected — nobody will receive it.",
  "scope.skillTitle": 'Change which agents get skill "{name}"',
  "scope.mcpTitle": 'Change which agents reach MCP server "{name}"',
  "mcp.credential": "Credential",
  "mcp.credential.unknown": "unknown",
  "mcp.owner.label": "Authorization owner",
  "mcp.owner.none": "No OAuth classification",
  "mcp.owner.agent": "Each Agent",
  "mcp.owner.trellis": "Trellis hosted",
  "mcp.owner.changeTitle": 'Change authorization owner for "{name}"',
  "mcp.owner.nativeNote": "Authorize this connection in each Agent. Trellis does not read their credentials.",
  "mcp.owner.claudeEntry": "Open Claude Code and use /mcp to authorize this server",
  "mcp.owner.agentSettings": "Authorize this server in the Agent's MCP settings",
  "mcp.oauth.authorize": "Authorize",
  "mcp.oauth.reauthorize": "Authorize again",
  "mcp.oauth.discovering": "Discovering provider…",
  "mcp.oauth.registering": "Registering client…",
  "mcp.oauth.waiting": "Complete authorization in your browser",
  "mcp.oauth.exchanging": "Completing authorization…",
  "mcp.oauth.saving": "Saving authorization…",
  "mcp.oauth.succeeded": "Authorization complete",
  "mcp.oauth.failed": "Authorization failed. You can try again.",
  "mcp.oauth.cancelled": "Authorization cancelled",
  "mcp.oauth.timed-out": "Authorization timed out. You can try again.",
  "mcp.oauth.configuration-changed": "Server configuration changed. Start authorization again.",
  "mcp.oauth.authorization-failed": "Authorization failed. Check the provider and client settings, then try again.",
  "mcp.oauth.startFailed": "Could not start authorization. Check that this server is enabled and hosted by Trellis.",
  "mcp.oauth.pollFailed": "Could not read authorization progress. Reconnecting…",
  "mcp.oauth.cancelFailed": "Could not cancel authorization. Try again.",
  "mcp.credentialNote": "State of the stored credential. It says nothing about whether the server is reachable.",
  "mcp.credential.authorized": "authorized",
  "mcp.credential.refreshable": "expired, refreshes automatically",
  "mcp.credential.expired": "expired",
  "mcp.credential.not-authorized": "not authorized",
  "mcp.credential.expires": "expires {date}",
  "mcp.credential.runHint": "Authorize it from a terminal:",
  "mcp.preRegistered": "pre-registered client",

  "memory.title": "Memory",
  "memory.subtitle": "Canonical memory profile files and which managed agents currently have them.",
  "memory.empty": "No memories in canonical source yet.",

  "secrets.title": "Secrets Audit",
  "secrets.subtitle": "Variable names and pass/fail findings only — a resolved secret value never appears here.",
  "secrets.empty": "No findings — nothing looks wrong.",
  "secrets.colAgent": "Agent",
  "secrets.colFile": "File",
  "secrets.colKind": "Kind",
  "secrets.colDetail": "Detail",

  "backups.title": "Backups",
  "backups.subtitle": "Every recorded write run, newest first. Rolling back restores exactly what that run changed.",
  "backups.empty": "No backup runs recorded yet.",
  "backups.rollback": "Roll back",
  "backups.rollbackTitle": "Roll back {runId}",
  "backups.summary": "{count} operation(s) · {startedAt}",

  "delegation.title": "Delegation Timeline",
  "delegation.notAvailable": "Not available yet.",
  "delegation.bodyPre": "This view will show delegated agent calls once",
  "delegation.bodyCode": "trellis-agent-bridge",
  "delegation.bodyPost": "'s audit trail is built (its task group 4, currently unbuilt). This screen exists to state that plainly rather than show fabricated data or disappear silently.",

  "onboard.title": "Onboard",
  "onboard.subtitlePre": "Runs the same non-interactive onboarding flow as",
  "onboard.subtitleCode": "trellis onboard --json",
  "onboard.subtitlePost": ", with the choices below.",
  "onboard.migrationSourceLabel": "Migration source agent (optional — auto-selected if only one has content)",
  "onboard.autoSelect": "(auto-select)",
  "onboard.noPresentAgents": "No present agents detected yet.",
  "onboard.managedAgentsLabel": "Managed agents",
  "onboard.addNothing": "Add nothing new this run",
  "onboard.mcpModeLabel": "MCP mode (optional — leaves current mode untouched if blank)",
  "onboard.noChange": "(no change)",
  "onboard.hubUrlLabel": "Hub URL",
  "onboard.memoryLabel": "Shared Memory server (optional — leaves current state untouched if blank)",
  "onboard.previewButton": "Preview onboard plan",
  "onboard.pickAtLeastOnePre": "Pick at least one managed agent, or \"Add nothing new this run\" — the same non-interactive contract",
  "onboard.pickAtLeastOneCode": "trellis onboard --json",
  "onboard.pickAtLeastOnePost": "has.",

  "chat.title": "Chat",
  "chat.subtitle": "Multi-turn conversation with a configured CLI Agent, streamed live — nothing here is written to canonical source, and nothing is saved after this app closes.",
  "chat.noTargetsPre": "No chat targets configured. Add one to",
  "chat.noTargetsCode": "~/.trellis/mcp/chat-agents.yaml",
  "chat.noTargetsMid": "(see docs) — for example Qoder's",
  "chat.noTargetsCode2": 'qoder -p "{prompt}" --output-format stream-json',
  "chat.agentLabel": "智能体",
  "chat.messagePlaceholder": "Message",
  "chat.send": "Send",
  "chat.sayHello": "Say hello.",
  "chat.unparsedOutput": "Unparsed output",
  "chat.toolCall": "Tool call · {name}",
  "chat.toolResult": "Tool result",
  "chat.you": "You",
  "chat.turnStatus": "Turn {status}",
  "chat.status.completed": "completed",
  "chat.status.failed": "failed",
  "chat.status.timeout": "timeout",
  "chat.status.cancelled": "cancelled",
  "chat.runTarget": 'Run "{label}"?',
  "chat.confirmWarning": "This will spawn a real process — possibly a real, billed API call:",
  "chat.confirmNote": "You won't be asked again for this agent this session.",
  "chat.confirmSend": "Confirm & send",
} as const;

export type TranslationKey = keyof typeof en;

const zh: Record<TranslationKey, string> = {
  "nav.agents": "智能体",
  "nav.mcp": "MCP",
  "nav.skills": "技能",
  "nav.memory": "记忆",
  "nav.secrets": "密钥审计",
  "nav.backups": "备份",
  "nav.delegation": "委派",
  "nav.onboard": "引导配置",
  "nav.chat": "对话",

  "app.sidecarError": "无法连接到 sidecar：{error}",
  "app.connecting": "正在连接 sidecar…",

  "common.loading": "加载中…",
  "common.add": "添加",
  "common.remove": "移除",
  "common.sync": "同步",
  "common.cancel": "取消",
  "common.apply": "应用",
  "common.applying": "正在应用…",
  "common.namePlaceholder": "名称",
  "common.noAgentReaches": "没有受管智能体能访问它",
  "common.notInstalled": "未安装",
  "common.present": "已安装",

  "confirmModal.computingPlan": "正在计算方案…",

  "agents.title": "智能体",
  "agents.subtitle": "Trellis 可以管理的每一个智能体位置，以及 `trellis doctor` 目前在这台机器上看到的情况。",
  "agents.summary": "{count} 个技能 · {mcpCount} 个 MCP 服务",
  "agents.findings": "发现的问题",

  "mcp.title": "MCP 服务",
  "mcp.subtitle": "规范源里的 MCP 服务，以及当前有哪些受管智能体能访问它们。",
  "mcp.commandPlaceholder": "stdio 命令",
  "mcp.addTitle": "添加 MCP 服务 “{name}”",
  "mcp.syncTitle": "把 MCP 服务同步到所有受管智能体",
  "mcp.importPlaceholder": '指向一个顶层带 "mcpServers" 字段的 JSON 文件的路径',
  "mcp.import": "导入",
  "mcp.importTitle": "从 {path} 导入",
  "mcp.importHintPre": "标准的",
  "mcp.importHintCode": '{ "mcpServers": { ... } }',
  "mcp.importHintPost": "导出（例如来自 Claude Desktop）。凭据值会被提取到本地、已加入 gitignore 的 env 文件中——绝不会写入",
  "mcp.importHintCode2": "servers.yaml",
  "mcp.empty": "规范源里还没有 MCP 服务。",
  "mcp.removeTitle": "移除 MCP 服务 “{name}”",
  "mcp.disabled": "已禁用",

  "skills.title": "技能",
  "skills.subtitle": "规范源里的技能，以及当前有哪些受管智能体拥有它们。",
  "skills.fromPlaceholder": "源路径（SKILL.md 所在目录）",
  "skills.addTitle": "添加技能 “{name}”",
  "skills.syncTitle": "把技能同步到所有受管智能体",
  "skills.empty": "规范源里还没有技能。",
  "skills.removeTitle": "移除技能 “{name}”",
  "scope.label": "生效于",
  "scope.save": "保存范围",
  "scope.reset": "重置",
  "scope.noManaged": "还没有受管智能体——请先完成引导。",
  "scope.noneSelected": "没有选择任何智能体——没有人会收到它。",
  "scope.skillTitle": "修改哪些智能体拥有技能 “{name}”",
  "scope.mcpTitle": "修改哪些智能体能访问 MCP 服务 “{name}”",
  "mcp.credential": "凭据",
  "mcp.credential.unknown": "未知",
  "mcp.owner.label": "授权归属",
  "mcp.owner.none": "未标记 OAuth",
  "mcp.owner.agent": "各 Agent 自己授权",
  "mcp.owner.trellis": "Trellis 托管",
  "mcp.owner.changeTitle": "修改 “{name}” 的授权归属",
  "mcp.owner.nativeNote": "请在各 Agent 中授权此连接，Trellis 不读取它们的凭据。",
  "mcp.owner.claudeEntry": "打开 Claude Code，使用 /mcp 为此服务器授权",
  "mcp.owner.agentSettings": "请在该 Agent 的 MCP 设置中授权此服务器",
  "mcp.oauth.authorize": "授权",
  "mcp.oauth.reauthorize": "重新授权",
  "mcp.oauth.discovering": "正在发现服务商…",
  "mcp.oauth.registering": "正在注册客户端…",
  "mcp.oauth.waiting": "请在浏览器中完成授权",
  "mcp.oauth.exchanging": "正在完成授权…",
  "mcp.oauth.saving": "正在保存授权…",
  "mcp.oauth.succeeded": "授权完成",
  "mcp.oauth.failed": "授权失败，可以重试。",
  "mcp.oauth.cancelled": "已取消授权",
  "mcp.oauth.timed-out": "授权超时，可以重试。",
  "mcp.oauth.configuration-changed": "服务器配置已改变，请重新发起授权。",
  "mcp.oauth.authorization-failed": "授权失败，请检查服务商与客户端设置后重试。",
  "mcp.oauth.startFailed": "无法启动授权，请检查服务器已启用并选择 Trellis 托管。",
  "mcp.oauth.pollFailed": "暂时无法获取授权进度，正在重新连接…",
  "mcp.oauth.cancelFailed": "无法取消授权，请重试。",
  "mcp.credentialNote": "已保存凭据的状态，不代表服务当前可以连接。",
  "mcp.credential.authorized": "已授权",
  "mcp.credential.refreshable": "已过期，会自动刷新",
  "mcp.credential.expired": "已过期",
  "mcp.credential.not-authorized": "未授权",
  "mcp.credential.expires": "{date} 到期",
  "mcp.credential.runHint": "在终端中完成授权：",
  "mcp.preRegistered": "预注册客户端",

  "memory.title": "记忆",
  "memory.subtitle": "规范源里的记忆文件，以及当前有哪些受管智能体拥有它们。",
  "memory.empty": "规范源里还没有记忆文件。",

  "secrets.title": "密钥审计",
  "secrets.subtitle": "只展示变量名和通过/失败结果——解析后的真实密钥值永远不会出现在这里。",
  "secrets.empty": "没有发现问题——一切正常。",
  "secrets.colAgent": "智能体",
  "secrets.colFile": "文件",
  "secrets.colKind": "类型",
  "secrets.colDetail": "详情",

  "backups.title": "备份",
  "backups.subtitle": "每一次记录下来的写入操作，按最新排列。回滚会精确恢复那次操作改动的内容。",
  "backups.empty": "还没有记录任何备份。",
  "backups.rollback": "回滚",
  "backups.rollbackTitle": "回滚 {runId}",
  "backups.summary": "{count} 个操作 · {startedAt}",

  "delegation.title": "委派时间线",
  "delegation.notAvailable": "暂不可用。",
  "delegation.bodyPre": "这个视图将在",
  "delegation.bodyCode": "trellis-agent-bridge",
  "delegation.bodyPost": "的审计记录建成后（其任务组 4，目前尚未构建）展示委派调用记录。这个界面的存在就是为了如实说明这一点，而不是隐藏或展示虚构的数据。",

  "onboard.title": "引导配置",
  "onboard.subtitlePre": "运行和",
  "onboard.subtitleCode": "trellis onboard --json",
  "onboard.subtitlePost": "相同的非交互式引导流程，使用下面的选项。",
  "onboard.migrationSourceLabel": "迁移来源智能体（可选——如果只有一个有内容会自动选择）",
  "onboard.autoSelect": "（自动选择）",
  "onboard.noPresentAgents": "还没有检测到任何已安装的智能体。",
  "onboard.managedAgentsLabel": "受管智能体",
  "onboard.addNothing": "本次不新增任何内容",
  "onboard.mcpModeLabel": "MCP 模式（可选——留空则不改变当前模式）",
  "onboard.noChange": "（不改变）",
  "onboard.hubUrlLabel": "Hub 地址",
  "onboard.memoryLabel": "共享记忆服务（可选——留空则不改变当前状态）",
  "onboard.previewButton": "预览引导配置方案",
  "onboard.pickAtLeastOnePre": '请至少选择一个受管智能体，或勾选"本次不新增任何内容"——这和',
  "onboard.pickAtLeastOneCode": "trellis onboard --json",
  "onboard.pickAtLeastOnePost": "的非交互式约定一致。",

  "chat.title": "对话",
  "chat.subtitle": "和已配置的 CLI Agent 进行多轮实时对话——这里的内容不会写入规范源，关闭应用后也不会保存。",
  "chat.noTargetsPre": "还没有配置任何聊天目标。请在",
  "chat.noTargetsCode": "~/.trellis/mcp/chat-agents.yaml",
  "chat.noTargetsMid": "中添加一个（见文档）——例如 Qoder 的",
  "chat.noTargetsCode2": 'qoder -p "{prompt}" --output-format stream-json',
  "chat.agentLabel": "智能体",
  "chat.messagePlaceholder": "消息",
  "chat.send": "发送",
  "chat.sayHello": "打个招呼吧。",
  "chat.unparsedOutput": "未解析的输出",
  "chat.toolCall": "工具调用 · {name}",
  "chat.toolResult": "工具结果",
  "chat.you": "你",
  "chat.turnStatus": "本轮{status}",
  "chat.status.completed": "已完成",
  "chat.status.failed": "已失败",
  "chat.status.timeout": "已超时",
  "chat.status.cancelled": "已取消",
  "chat.runTarget": "运行“{label}”？",
  "chat.confirmWarning": "这会启动一个真实的进程——可能是一次真实的、产生费用的 API 调用：",
  "chat.confirmNote": "本次会话里不会再对这个智能体弹出确认了。",
  "chat.confirmSend": "确认并发送",
};

const dictionaries: Record<Lang, Record<TranslationKey, string>> = { en, zh };

function detectInitialLang(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

function translate(lang: Lang, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[lang][key] ?? en[key];
  return interpolate(template, vars);
}

const I18nContext = createContext<I18nContextValue>({
  lang: "en",
  setLang: () => {},
  t: (key, vars) => translate("en", key, vars),
});

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, lang);
  }, [lang]);

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      setLang: setLangState,
      t: (key, vars) => translate(lang, key, vars),
    }),
    [lang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
