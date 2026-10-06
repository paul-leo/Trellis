import { randomBytes } from "node:crypto";

export interface CallbackPageOptions {
  serverName: string;
  hasCode: boolean;
  error?: string;
  acceptLanguage?: string;
}

const COPY = {
  en: {
    received: "Authorization response received",
    receivedBody: "Return to Trellis or your terminal to check the final connection result.",
    cancelled: "Authorization cancelled",
    cancelledBody: "Return to Trellis and start again when you are ready.",
    failed: "Authorization could not continue",
    failedBody: "Return to Trellis or your terminal for details, then try again.",
    incomplete: "Authorization response incomplete",
    incompleteBody: "No authorization code was received. Start again from Trellis.",
    close: "Close this tab",
    manual: "If this tab stays open, close it manually and return to Trellis or your terminal.",
    noScript: "You can close this tab manually and return to Trellis or your terminal.",
  },
  zh: {
    received: "授权响应已接收",
    receivedBody: "请返回 Trellis 或终端查看最终连接结果。",
    cancelled: "授权已取消",
    cancelledBody: "准备好后，请返回 Trellis 重新发起授权。",
    failed: "授权暂未完成",
    failedBody: "请返回 Trellis 或终端查看原因，然后重试。",
    incomplete: "授权响应不完整",
    incompleteBody: "未收到授权码，请从 Trellis 重新发起授权。",
    close: "关闭此标签页",
    manual: "如果页面没有关闭，请手动关闭此标签页，返回 Trellis 或终端。",
    noScript: "你可以手动关闭此标签页，返回 Trellis 或终端。",
  },
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// Inline the existing docs/assets/brand-v3/trellis-mark-v3-a.svg geometry so
// callback pages work offline and inside the packaged Sidecar.
const MARK = `<svg viewBox="0 0 96 96" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-linecap="round"><rect x="16" y="18" width="64" height="18" rx="9" stroke-width="5.5"/><g stroke-width="2.6" clip-path="url(#a-beam)"><path d="M-64.5 32 L-55.5 23"/><path d="M-64.5 23 L-55.5 32"/><path d="M-46.5 32 L-37.5 23"/><path d="M-46.5 23 L-37.5 32"/><path d="M-28.5 32 L-19.5 23"/><path d="M-28.5 23 L-19.5 32"/><path d="M-10.5 32 L-1.5 23"/><path d="M-10.5 23 L-1.5 32"/><path d="M7.5 32 L16.5 23"/><path d="M7.5 23 L16.5 32"/><path d="M25.5 32 L34.5 23"/><path d="M25.5 23 L34.5 32"/><path d="M43.5 32 L52.5 23"/><path d="M43.5 23 L52.5 32"/><path d="M61.5 32 L70.5 23"/><path d="M61.5 23 L70.5 32"/><path d="M79.5 32 L88.5 23"/><path d="M79.5 23 L88.5 32"/><path d="M97.5 32 L106.5 23"/><path d="M97.5 23 L106.5 32"/><path d="M115.5 32 L124.5 23"/><path d="M115.5 23 L124.5 32"/></g><path d="M48 36 V78" stroke-width="8"/></g><defs><clipPath id="a-beam"><rect x="21" y="23" width="54" height="9" rx="4.5"/></clipPath></defs></svg>`;

/** Browser receipt only: the caller still validates and persists the grant. */
export function renderCallbackPage(options: CallbackPageOptions): { html: string; contentSecurityPolicy: string } {
  const chinese = options.acceptLanguage?.split(",")[0]?.trim().toLowerCase().startsWith("zh") ?? false;
  const copy = chinese ? COPY.zh : COPY.en;
  const state = options.error === "access_denied" ? "cancelled" : options.error ? "failed" : options.hasCode ? "received" : "incomplete";
  const title = copy[state];
  const description = copy[`${state}Body`];
  const nonce = randomBytes(16).toString("base64");
  const contentSecurityPolicy = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const html = `<!doctype html>
<html lang="${chinese ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)} · Trellis</title>
<style nonce="${nonce}">
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Arial,sans-serif;color:#182230;background:#fff;font-synthesis:none;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:32px 24px}
main{width:100%;max-width:440px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;margin-bottom:24px;font-size:14px;color:#667085}.brand svg{width:28px;height:28px;flex:none}.brand-name{font-weight:600;color:#344054}.separator{color:#98a2b3}.server{max-width:100%;overflow-wrap:anywhere}
h1{font-size:25px;font-weight:600;line-height:1.35;letter-spacing:-.5px;margin:0 0 12px;overflow-wrap:anywhere}.description{font-size:14px;line-height:1.7;color:#667085;margin:0 0 24px}
button{appearance:none;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;font:inherit;font-size:14px;font-weight:500;line-height:1.5;padding:10px 18px;min-height:44px;max-width:100%;cursor:pointer}button:hover{background:#1d4ed8;border-color:#1d4ed8}button:focus-visible{outline:3px solid #93b4ff;outline-offset:3px}.help{font-size:12px;line-height:1.65;color:#667085;margin:16px 0 0;overflow-wrap:anywhere}.help:focus{outline:none}
[hidden]{display:none!important}@media(max-width:480px){body{padding:24px}h1{font-size:23px}}
</style>
</head>
<body>
<main>
  <div class="brand">${MARK}<span class="brand-name">Trellis</span><span class="separator" aria-hidden="true">·</span><span class="server">${escapeHtml(options.serverName)}</span></div>
  <section aria-labelledby="page-title" data-state="${state}">
    <h1 id="page-title">${title}</h1>
    <p class="description">${description}</p>
    <button id="close-tab" type="button" hidden>${copy.close}</button>
    <p id="close-help" class="help" role="status" tabindex="-1" hidden>${copy.manual}</p>
    <p id="manual-close" class="help">${copy.noScript}</p>
  </section>
</main>
<script nonce="${nonce}">
try { history.replaceState(null, '', location.pathname); } catch (_) {}
const button = document.getElementById('close-tab');
button.hidden = false;
document.getElementById('manual-close').hidden = true;
button.addEventListener('click', function () {
  try { window.close(); } catch (_) {}
  setTimeout(function () {
    const help = document.getElementById('close-help');
    help.hidden = false;
    help.focus({ preventScroll: true });
  }, 150);
});
</script>
</body>
</html>`;
  return { html, contentSecurityPolicy };
}
