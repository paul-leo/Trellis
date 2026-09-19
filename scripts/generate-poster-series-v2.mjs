import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(root, "docs/assets/poster-series/v2");
const quickLookDir = "/tmp/trellis-poster-series-v2";

mkdirSync(outputDir, { recursive: true });
mkdirSync(quickLookDir, { recursive: true });

const color = {
  paper: "#fcfcfa",
  ink: "#15202b",
  muted: "#687582",
  line: "#e1e6ec",
  blue: "#3d6fde",
  paleBlue: "#eef3ff",
};

const posters = [
  {
    slug: "unified",
    number: "01",
    label: "RUNTIME",
    signal: "ONE SOURCE / MANY AGENTS",
    title: { en: ["One Runtime.", "Every Code Agent."], zh: ["一个 Runtime，", "统一所有 Code Agent。"] },
    body: {
      en: ["Skills, MCP, Memory and Instructions", "stay aligned from one canonical source."],
      zh: ["从一个 canonical source 统一管理", "Skill、MCP、Memory 与共享指令。"],
    },
    tags: { en: "SKILLS · MCP · MEMORY · INSTRUCTIONS", zh: "SKILL · MCP · MEMORY · INSTRUCTIONS" },
  },
  {
    slug: "migrate",
    number: "02",
    label: "MIGRATION",
    signal: "PREVIEW / BACKUP / ROLLBACK",
    title: { en: ["Migrate in", "one command."], zh: ["一条命令，", "迁移现有配置。"] },
    body: {
      en: ["Bring an existing Agent setup into a verified source", "with preview, backup and rollback."],
      zh: ["预览、备份、回滚，让 Agent 配置迁移", "可检查、可恢复。"],
    },
    tags: { en: "PREVIEW · BACKUP · MIGRATE · ROLLBACK", zh: "PREVIEW · BACKUP · MIGRATE · ROLLBACK" },
  },
  {
    slug: "memory",
    number: "03",
    label: "CONTEXT",
    signal: "MEMORY / PERSISTENT",
    title: { en: ["Keep context", "in the loop."], zh: ["让上下文", "始终在线。"] },
    body: {
      en: ["Shared memory and task handoffs follow you", "across the Agents you use."],
      zh: ["在不同 Code Agent 之间共享 Memory", "和任务交接记录。"],
    },
    tags: { en: "MEMORY · TASKS · HANDOFF · TRACE", zh: "MEMORY · TASKS · HANDOFF · TRACE" },
  },
  {
    slug: "switch",
    number: "04",
    label: "ADAPT",
    signal: "AGENT / SWITCHABLE",
    title: { en: ["Change Agents.", "Keep moving."], zh: ["切换 Agent，", "不丢上下文。"] },
    body: {
      en: ["Keep instructions, tools and context", "while the Runtime adapts to the next Agent."],
      zh: ["保留指令、工具和工作状态，继续", "完成当前任务。"],
    },
    tags: { en: "CLAUDE · CODEX · KIRO · PI / KIMI", zh: "CLAUDE · CODEX · KIRO · PI / KIMI" },
  },
];

const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const text = (value, x, y, options = {}) => {
  const {
    size = 24,
    weight = 400,
    fill = color.ink,
    family = "Helvetica Neue, PingFang SC, Arial, sans-serif",
    lineHeight = Math.round(size * 1.2),
    letterSpacing = 0,
    anchor = "start",
  } = options;
  return String(value).split("\n").map((line, index) =>
    `<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" letter-spacing="${letterSpacing}" fill="${fill}">${escapeXml(line)}</text>`,
  ).join("");
};

const mark = (x, y, scale = 1, stroke = color.blue) => `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${stroke}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 48h64"/>
  <path d="M26 34v28M48 20v56M70 34v28"/>
</g>`;

const outerGuides = (width, height, inset = 60) => `<g fill="none" stroke="${color.line}" stroke-width="2">
  <path d="M${inset} 150H${width - inset}M${inset} ${height - 102}H${width - inset}"/>
  <path d="M${inset} 150v18M${width - inset} 150v18M${inset} ${height - 102}v-18M${width - inset} ${height - 102}v-18"/>
</g>
<g fill="${color.blue}" opacity="0.82"><rect x="${inset}" y="150" width="42" height="3"/><rect x="${width - inset - 42}" y="${height - 105}" width="42" height="3"/></g>`;

const header = (width, label, number) => `${mark(60, 48, 0.42)}
  ${text("AGENT TRELLIS", 112, 91, { size: 21, weight: 700, letterSpacing: 2.4 })}
  ${text(`${label} / ${number}`, width - 60, 91, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.7, fill: color.muted, anchor: "end" })}`;

const verticalPoster = (poster, locale) => {
  const title = poster.title[locale];
  const body = poster.body[locale];
  const chinese = locale === "zh";
  const titleSize = chinese ? 78 : 94;
  const titleLineHeight = chinese ? 96 : 108;
  const titleY = 330;
  const bodyY = titleY + titleLineHeight * title.length + 40;
  const filename = `agent-trellis-poster-v2-${poster.slug}-${locale}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1440" viewBox="0 0 1440 1440">
  <rect width="1440" height="1440" fill="${color.paper}"/>
  <g transform="translate(180 0)">
    ${outerGuides(1080, 1440)}
    ${header(1080, poster.label, poster.number)}
    ${text(`${poster.number} / 04`, 60, 196, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 2, fill: color.blue })}
    ${text("UNIFIED CODE AGENT RUNTIME", 60, 220, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 2.2, fill: color.blue })}
    <rect x="60" y="282" width="7" height="166" fill="${color.blue}"/>
    ${text(title.join("\n"), 94, titleY, { size: titleSize, weight: 760, lineHeight: titleLineHeight, letterSpacing: chinese ? -1.5 : -2.2 })}
    ${text(body.join("\n"), 96, bodyY, { size: chinese ? 27 : 26, weight: 450, lineHeight: 35, fill: color.muted })}

    ${text(poster.signal, 540, 690, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 2.2, fill: color.muted, anchor: "middle" })}
    <path d="M265 744h112M703 744h112M265 1012h112M703 1012h112" fill="none" stroke="${color.line}" stroke-width="2"/>
    <path d="M265 744v28M815 744v28M265 1012v-28M815 1012v-28" fill="none" stroke="${color.line}" stroke-width="2"/>
    ${text("AGENT PATHS", 540, 775, { size: 13, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.6, fill: color.muted, anchor: "middle" })}
    ${mark(384, 780, 3.2)}
    ${text(`SHARED RUNTIME / ${poster.number}`, 540, 1080, { size: 14, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 2, fill: color.blue, anchor: "middle" })}

    ${text(poster.tags[locale], 60, 1148, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.6, fill: color.muted })}
    ${text("agent-trellis.dev", 1020, 1148, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.6, fill: color.muted, anchor: "end" })}
    <path d="M60 1180H1020" stroke="${color.ink}" stroke-width="3"/>
    <circle cx="72" cy="1263" r="5" fill="${color.blue}"/>
    ${text("$ npm i -g agent-trellis", 92, 1272, { size: 25, weight: 500, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 0.2 })}
    ${text("OPEN SOURCE / LOCAL FIRST", 1020, 1272, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.5, fill: color.muted, anchor: "end" })}
  </g>
</svg>`;
};

const horizontalPoster = (poster) => `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600" viewBox="0 0 1600 1600">
  <rect width="1600" height="1600" fill="${color.paper}"/>
  <g transform="translate(0 350)">
    ${outerGuides(1600, 900, 100)}
    ${header(1600, "SYSTEM", poster.number)}
    ${text("ONE RUNTIME / EVERY CODE AGENT", 100, 196, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 2, fill: color.blue })}
    <rect x="100" y="242" width="7" height="190" fill="${color.blue}"/>
    ${text("One Runtime.\nEvery Code Agent.", 140, 320, { size: 84, weight: 760, lineHeight: 98, letterSpacing: -2.2 })}
    ${text("Skills, MCP, Memory and Instructions —", 142, 536, { size: 27, weight: 450, fill: color.muted })}
    ${text("one canonical source for the tools you use.", 142, 574, { size: 27, weight: 450, fill: color.muted })}
    ${text("SKILLS · MCP · MEMORY · INSTRUCTIONS", 142, 672, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.7, fill: color.muted })}
    <path d="M100 744H760" stroke="${color.ink}" stroke-width="3"/>
    <circle cx="112" cy="806" r="5" fill="${color.blue}"/>
    ${text("$ npm i -g agent-trellis", 132, 815, { size: 25, weight: 500, family: "Menlo, SFMono-Regular, monospace" })}

    <path d="M932 236H1490V676H932" fill="none" stroke="${color.line}" stroke-width="2"/>
    <path d="M932 236h42M932 236v42M1490 676h-42M1490 676v-42" fill="none" stroke="${color.blue}" stroke-width="3"/>
    ${text("CLAUDE CODE", 1045, 300, { size: 13, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.4, fill: color.muted, anchor: "middle" })}
    ${text("CODEX", 1220, 300, { size: 13, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.4, fill: color.muted, anchor: "middle" })}
    ${text("KIRO / PI", 1395, 300, { size: 13, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 1.4, fill: color.muted, anchor: "middle" })}
    ${mark(970, 338, 3.8)}
    ${text("ONE CANONICAL RAIL", 1210, 704, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 2, fill: color.blue, anchor: "middle" })}
    ${text("01 / 04", 1490, 815, { size: 15, family: "Menlo, SFMono-Regular, monospace", letterSpacing: 2, fill: color.blue, anchor: "end" })}
  </g>
</svg>`;

const writeRendered = (filename, svg, cropHeight, cropWidth) => {
  const svgPath = join(outputDir, `${filename}.svg`);
  const pngPath = join(outputDir, `${filename}.png`);
  writeFileSync(svgPath, svg);
  execFileSync("qlmanage", ["-t", "-s", String(Math.max(cropHeight, cropWidth)), "-o", quickLookDir, svgPath], { stdio: "ignore" });
  execFileSync("sips", ["--cropToHeightWidth", String(cropHeight), String(cropWidth), join(quickLookDir, `${filename}.svg.png`), "--out", pngPath], { stdio: "ignore" });
};

for (const poster of posters) {
  writeRendered(`agent-trellis-poster-v2-${poster.slug}-en`, verticalPoster(poster, "en"), 1440, 1080);
  writeRendered(`agent-trellis-poster-v2-${poster.slug}-zh`, verticalPoster(poster, "zh"), 1440, 1080);
}
writeRendered("agent-trellis-poster-v2-horizontal", horizontalPoster(posters[0]), 900, 1600);

console.log(`Generated v2 logo, ${posters.length * 2} vertical posters and 1 horizontal poster in ${outputDir}`);
