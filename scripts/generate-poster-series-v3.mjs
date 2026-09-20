import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(root, "docs/assets/poster-series-v3");
const quickLookDir = "/tmp/trellis-poster-series-v3";

mkdirSync(outputDir, { recursive: true });
mkdirSync(quickLookDir, { recursive: true });

const palette = {
  paper: "#fafaf8",
  ink: "#161c24",
  muted: "#69727d",
  line: "#dfe4ea",
};

const posters = [
  {
    slug: "unified",
    number: "01",
    label: "RUNTIME",
    accent: "#3457d5",
    fig: "AGENT PATHS",
    signal: "ONE RUNTIME · MANY AGENTS",
    title: { en: ["One Runtime.", "Every Code Agent."], zh: ["一个 Runtime，", "统一所有 Code Agent。"] },
    body: {
      en: ["Skills, MCP, Memory and Instructions", "stay aligned from one canonical source."],
      zh: ["从一个 canonical source 统一管理", "Skill、MCP、Memory 与共享指令。"],
    },
    tags: "SKILLS · MCP · MEMORY · INSTRUCTIONS",
  },
  {
    slug: "migrate",
    number: "02",
    label: "MIGRATION",
    accent: "#0c7d6c",
    fig: "MIGRATION PATH",
    signal: "PREVIEW · BACKUP · ROLLBACK",
    title: { en: ["Migrate in", "one command."], zh: ["一条命令，", "迁移现有配置。"] },
    body: {
      en: ["Bring an existing Agent setup into a verified source", "with preview, backup and rollback."],
      zh: ["预览、备份、回滚，让 Agent 配置迁移", "可检查、可恢复。"],
    },
    tags: "PREVIEW · BACKUP · MIGRATE · ROLLBACK",
  },
  {
    slug: "memory",
    number: "03",
    label: "CONTEXT",
    accent: "#6b2fd8",
    fig: "SHARED MEMORY",
    signal: "SHARED MEMORY · TASK HANDOFF",
    title: { en: ["Keep context", "in the loop."], zh: ["让上下文", "始终在线。"] },
    body: {
      en: ["Shared memory and task handoffs follow you", "across the Agents you use."],
      zh: ["在不同 Code Agent 之间共享 Memory", "和任务交接记录。"],
    },
    tags: "MEMORY · TASKS · HANDOFF · TRACE",
  },
  {
    slug: "switch",
    number: "04",
    label: "ADAPT",
    accent: "#c2410c",
    fig: "CONTEXT HANDOFF",
    signal: "CONTEXT CARRIES OVER",
    title: { en: ["Change Agents.", "Keep moving."], zh: ["切换 Agent，", "不丢上下文。"] },
    body: {
      en: ["Keep instructions, tools and context", "while the Runtime adapts to the next Agent."],
      zh: ["保留指令、工具和工作状态，继续", "完成当前任务。"],
    },
    tags: "CLAUDE · CODEX · KIRO · PI / KIMI",
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
    fill = palette.ink,
    family = "Helvetica Neue, PingFang SC, Arial, sans-serif",
    lineHeight = Math.round(size * 1.2),
    letterSpacing = 0,
    anchor = "start",
  } = options;
  return String(value).split("\n").map((line, index) =>
    `<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" letter-spacing="${letterSpacing}" fill="${fill}">${escapeXml(line)}</text>`,
  ).join("");
};

const mono = (value, x, y, options = {}) =>
  text(value, x, y, { family: "Menlo, SFMono-Regular, monospace", ...options });

const hatchLines = (x, y, w, h, spacing) => {
  const lines = [];
  const span = Math.ceil((w + h) / spacing) + 1;
  for (let k = -span; k <= span; k += 1) {
    const x0 = x + k * spacing;
    lines.push(`<path d="M${x0} ${y + h} L${x0 + h} ${y}"/>`);
    lines.push(`<path d="M${x0} ${y} L${x0 + h} ${y + h}"/>`);
  }
  return lines.join("");
};

// Brand mark v3-A (lattice T). The clipPath lives inside the transformed group
// so it stays in mark-local coordinates.
const mark = (x, y, scale, color = palette.ink) => `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${color}" stroke-linecap="round">
  <defs><clipPath id="v3-beam-${x}-${y}"><rect x="21" y="23" width="54" height="9" rx="4.5"/></clipPath></defs>
  <rect x="16" y="18" width="64" height="18" rx="9" stroke-width="5.5"/>
  <g stroke-width="2.6" clip-path="url(#v3-beam-${x}-${y})">${hatchLines(25.5, 23, 54, 9, 18)}</g>
  <path d="M48 36 V78" stroke-width="8"/>
</g>`;

const crosshair = (x, y) =>
  `<path d="M${x - 9} ${y} H${x + 9} M${x} ${y - 9} V${y + 9}" fill="none" stroke="${palette.line}" stroke-width="2"/>`;

const latticePanel = (id, x, y, w, h, rx, strokeWidth) => `<g fill="none">
  <defs><clipPath id="${id}"><rect x="${x + 7}" y="${y + 7}" width="${w - 14}" height="${h - 14}" rx="${Math.max(rx - 6, 4)}"/></clipPath></defs>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" stroke="${palette.ink}" stroke-width="${strokeWidth}"/>
  <g clip-path="url(#${id})" stroke="${palette.muted}" stroke-width="2" opacity="0.85">${hatchLines(x + 7, y + 7, w - 14, h - 14, 21)}</g>
</g>`;

// ---------------------------------------------------------------------------
// Theme diagrams, drawn inside a 952 x 480 zone (x 64..1016, y 650..1130) via
// a translate(0 50) wrapper. Labels and strokes are sized for phone screens.
// ---------------------------------------------------------------------------

const diagramUnified = (accent) => `<g>
  ${[700, 810, 920].map((y) => `<rect x="148" y="${y - 11}" width="22" height="22" rx="6" fill="none" stroke="${palette.ink}" stroke-width="3.5"/>`).join("")}
  ${["CLAUDE", "CODEX", "KIMI"].map((name, i) => mono(name, 159, 742 + i * 110, { size: 17, fill: palette.muted, anchor: "middle", letterSpacing: 1 })).join("")}
  ${latticePanel("d-unified", 440, 700, 200, 220, 20, 4)}
  <g fill="none" stroke="${palette.ink}" stroke-width="3.5">
    <path d="M171 700 C 290 700 320 762 440 762"/>
    <path d="M171 810 H440"/>
    <path d="M171 920 C 290 920 320 858 440 858"/>
    <path d="M640 762 H920 M640 810 H920 M640 858 H920"/>
  </g>
  <g fill="${accent}">${[762, 810, 858].map((y) => `<circle cx="926" cy="${y}" r="8"/>`).join("")}</g>
</g>`;

const diagramMigrate = (accent) => `<g>
  <rect x="140" y="730" width="180" height="160" rx="14" fill="none" stroke="${palette.muted}" stroke-width="3.5" stroke-dasharray="9 8"/>
  <g stroke="${palette.muted}" stroke-width="3" stroke-linecap="round">
    ${[770, 810, 850].map((y) => `<circle cx="168" cy="${y}" r="4.5" fill="${palette.muted}" stroke="none"/><path d="M184 ${y} H 288"/>`).join("")}
  </g>
  ${mono("EXISTING SETUP", 230, 935, { size: 17, fill: palette.muted, anchor: "middle", letterSpacing: 1.5 })}
  <g fill="none" stroke="${palette.ink}" stroke-width="4">
    <path d="M320 810 H440"/><path d="M545 810 H620"/>
  </g>
  <path d="M430 802 L446 810 L430 818 Z" fill="${palette.ink}"/>
  <path d="M610 802 L626 810 L610 818 Z" fill="${palette.ink}"/>
  <circle cx="505" cy="810" r="36" fill="none" stroke="${accent}" stroke-width="4.5"/>
  <path d="M486 810 l13 14 l25 -30" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  ${mono("VERIFY", 505, 885, { size: 17, fill: accent, anchor: "middle", letterSpacing: 1.5 })}
  ${latticePanel("d-migrate", 640, 720, 170, 180, 18, 4)}
  ${mono("TRELLIS SOURCE", 725, 935, { size: 17, fill: palette.muted, anchor: "middle", letterSpacing: 1.5 })}
</g>`;

const diagramMemory = (accent) => `<g>
  <rect x="259" y="689" width="22" height="22" rx="6" fill="none" stroke="${palette.ink}" stroke-width="4"/>
  <rect x="799" y="689" width="22" height="22" rx="6" fill="none" stroke="${palette.ink}" stroke-width="4"/>
  ${mono("AGENT A", 270, 670, { size: 16, fill: palette.muted, anchor: "middle", letterSpacing: 1 })}
  ${mono("AGENT B", 810, 670, { size: 16, fill: palette.muted, anchor: "middle", letterSpacing: 1 })}
  <path d="M270 711 V880 M810 711 V880" fill="none" stroke="${palette.ink}" stroke-width="3.5"/>
  <circle cx="270" cy="880" r="4.5" fill="${palette.ink}"/>
  <circle cx="810" cy="880" r="4.5" fill="${palette.ink}"/>
  <rect x="190" y="880" width="700" height="44" rx="22" fill="none" stroke="${palette.ink}" stroke-width="4"/>
  <g fill="${palette.muted}">${[300, 420, 660, 780].map((x) => `<circle cx="${x}" cy="902" r="7"/>`).join("")}</g>
  <circle cx="540" cy="902" r="15" fill="none" stroke="${accent}" stroke-width="3"/>
  <circle cx="540" cy="902" r="7" fill="${accent}"/>
</g>`;

const diagramSwitch = (accent) => `<g>
  <path d="M180 720 H460" fill="none" stroke="${palette.muted}" stroke-width="3.5"/>
  <path d="M478 720 H920" fill="none" stroke="${palette.muted}" stroke-width="3.5" stroke-dasharray="8 8"/>
  <path d="M180 920 H920" fill="none" stroke="${palette.muted}" stroke-width="3.5"/>
  <path d="M180 712 V728 M920 712 V728 M180 912 V928 M920 912 V928" fill="none" stroke="${palette.muted}" stroke-width="3"/>
  ${mono("AGENT A", 180, 692, { size: 16, fill: palette.muted, letterSpacing: 1 })}
  ${mono("AGENT B", 920, 960, { size: 16, fill: palette.muted, anchor: "end", letterSpacing: 1 })}
  <path d="M180 720 H420 C 540 720 520 920 640 920 H920" fill="none" stroke="${palette.ink}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="180" cy="720" r="7.5" fill="${palette.ink}"/>
  <circle cx="920" cy="920" r="16" fill="none" stroke="${accent}" stroke-width="3"/>
  <circle cx="920" cy="920" r="8.5" fill="${accent}"/>
</g>`;

const diagrams = {
  unified: diagramUnified,
  migrate: diagramMigrate,
  memory: diagramMemory,
  switch: diagramSwitch,
};

// Frame around the diagram zone with a label chip cut into the top edge.
const figureFrame = (x, y, w, h, chipText, accent) => {
  const chipWidth = chipText.length * 13 + 34;
  return `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${palette.line}" stroke-width="1.5"/>
  ${crosshair(x, y)}${crosshair(x + w, y)}${crosshair(x, y + h)}${crosshair(x + w, y + h)}
  <rect x="${x + 18}" y="${y - 22}" width="${chipWidth}" height="44" fill="${palette.paper}"/>
  ${mono(chipText, x + 35, y + 8, { size: 20, fill: accent, letterSpacing: 1.8 })}
</g>`;
};

// ---------------------------------------------------------------------------
// Vertical poster: 1080 x 1440 (drawn in the center of a 1440 square canvas).
// Typography is sized for phone feeds (~390 css px wide).
// ---------------------------------------------------------------------------

const V_CANVAS = 1440;
const V_OFFSET = (V_CANVAS - 1080) / 2;

const makeVertical = (poster, locale) => {
  const accent = poster.accent;
  const title = poster.title[locale];
  const body = poster.body[locale];
  const chinese = locale === "zh";
  const titleSize = chinese ? 80 : 94;
  const titleLineHeight = chinese ? 98 : 106;
  const titleBaseline = 360;
  const barTop = Math.round(titleBaseline - titleSize * 0.78);
  const barBottom = Math.round(titleBaseline + titleLineHeight * (title.length - 1) + titleSize * 0.22);
  const bodyY = titleBaseline + titleLineHeight * (title.length - 1) + 66;
  const filename = `agent-trellis-poster-v3-${poster.slug}-${locale}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${V_CANVAS}" height="${V_CANVAS}" viewBox="0 0 ${V_CANVAS} ${V_CANVAS}">
  <rect width="${V_CANVAS}" height="${V_CANVAS}" fill="${palette.paper}"/>
  <g transform="translate(${V_OFFSET} 0)">
    ${mark(64, 48, 0.56)}
    ${text("AGENT TRELLIS", 132, 87, { size: 30, weight: 700, letterSpacing: 2.2 })}
    ${mono(`${poster.label} / ${poster.number}`, 1016, 87, { size: 19, fill: palette.muted, anchor: "end", letterSpacing: 1.7 })}
    <path d="M64 142 H1016" stroke="${palette.line}" stroke-width="1.5"/>
    <rect x="64" y="138.5" width="52" height="3.5" fill="${accent}"/>

    ${mono("UNIFIED CODE AGENT RUNTIME", 96, 232, { size: 22, fill: accent, letterSpacing: 2.2 })}
    <rect x="64" y="${barTop}" width="7" height="${barBottom - barTop}" fill="${accent}"/>
    ${text(title.join("\n"), 96, titleBaseline, { size: titleSize, weight: 800, lineHeight: titleLineHeight, letterSpacing: chinese ? -1 : -2.2 })}
    ${text(body.join("\n"), 96, bodyY, { size: chinese ? 35 : 34, weight: 450, lineHeight: 46, fill: palette.muted })}

    ${figureFrame(64, 650, 952, 480, `FIG.${poster.number} — ${poster.fig}`, accent)}
    <g transform="translate(0 50)">${diagrams[poster.slug](accent)}</g>
    ${mono(poster.signal, 540, 1088, { size: 22, fill: accent, anchor: "middle", letterSpacing: 2 })}

    ${mono(poster.tags, 64, 1198, { size: 19, fill: palette.muted, letterSpacing: 1.6 })}
    ${mono("agent-trellis.dev", 1016, 1198, { size: 19, fill: palette.muted, anchor: "end", letterSpacing: 1.6 })}
    <path d="M64 1232 H1016" stroke="${palette.ink}" stroke-width="3.5"/>
    <circle cx="77" cy="1294" r="7" fill="${accent}"/>
    ${mono("$ npm i -g agent-trellis", 108, 1304, { size: 32, weight: 500, letterSpacing: 0.2 })}
    ${mono("OPEN SOURCE / LOCAL FIRST", 1016, 1304, { size: 18, fill: palette.muted, anchor: "end", letterSpacing: 1.5 })}
  </g>
</svg>`;
  const svgPath = join(outputDir, `${filename}.svg`);
  writeFileSync(svgPath, svg);
  execFileSync("qlmanage", ["-t", "-s", "1440", "-o", quickLookDir, svgPath], { stdio: "ignore" });
  const rendered = join(quickLookDir, `${filename}.svg.png`);
  execFileSync("sips", ["--cropToHeightWidth", "1440", "1080", rendered, "--out", join(outputDir, `${filename}.png`)], { stdio: "ignore" });
};

// ---------------------------------------------------------------------------
// Horizontal poster: 1600 x 900 (drawn in the center of a 1600 square canvas),
// exported at 1200 x 675. Desktop-first, so metrics stay compact.
// ---------------------------------------------------------------------------

const H_CANVAS = 1600;
const H_OFFSET = (H_CANVAS - 900) / 2;

const makeHorizontal = (poster, locale) => {
  const accent = poster.accent;
  const title = poster.title[locale];
  const body = poster.body[locale];
  const chinese = locale === "zh";
  const titleSize = chinese ? 74 : 84;
  const titleLineHeight = chinese ? 90 : 98;
  const titleBaseline = 366;
  const barTop = Math.round(titleBaseline - titleSize * 0.78);
  const barBottom = Math.round(titleBaseline + titleLineHeight * (title.length - 1) + titleSize * 0.22);
  const bodyY = titleBaseline + titleLineHeight * (title.length - 1) + 58;
  const filename = `agent-trellis-poster-v3-horizontal-${locale}`;
  const diagram = `<g>
  ${[330, 475, 620].map((y) => `<rect x="1039" y="${y - 11}" width="22" height="22" rx="6" fill="none" stroke="${palette.ink}" stroke-width="3"/>`).join("")}
  ${latticePanel("d-horizontal", 1165, 330, 170, 290, 18, 3.5)}
  <g fill="none" stroke="${palette.ink}" stroke-width="3">
    <path d="M1062 330 C 1120 330 1128 400 1165 400"/>
    <path d="M1062 475 H1165"/>
    <path d="M1062 620 C 1120 620 1128 550 1165 550"/>
    <path d="M1335 400 H1450 M1335 475 H1450 M1335 550 H1450"/>
  </g>
  <g fill="${accent}">${[400, 475, 550].map((y) => `<circle cx="1456" cy="${y}" r="6.5"/>`).join("")}</g>
</g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${H_CANVAS}" height="${H_CANVAS}" viewBox="0 0 ${H_CANVAS} ${H_CANVAS}">
  <rect width="${H_CANVAS}" height="${H_CANVAS}" fill="${palette.paper}"/>
  <g transform="translate(0 ${H_OFFSET})">
    ${mark(64, 100, 0.58)}
    ${text("AGENT TRELLIS", 140, 141, { size: 26, weight: 700, letterSpacing: 2.6 })}
    ${mono("OPEN SOURCE · LOCAL FIRST", 1536, 140, { size: 15, fill: palette.muted, anchor: "end", letterSpacing: 1.7 })}
    <path d="M64 192 H1536" stroke="${palette.line}" stroke-width="1.5"/>
    <rect x="64" y="189" width="46" height="3" fill="${accent}"/>

    ${mono("UNIFIED CODE AGENT RUNTIME", 108, 262, { size: 17, fill: accent, letterSpacing: 2.2 })}
    <rect x="64" y="${barTop}" width="8" height="${barBottom - barTop}" fill="${accent}"/>
    ${text(title.join("\n"), 108, titleBaseline, { size: titleSize, weight: 800, lineHeight: titleLineHeight, letterSpacing: chinese ? -1 : -2.2 })}
    ${text(body.join("\n"), 108, bodyY, { size: 24, weight: 450, lineHeight: 36, fill: palette.muted })}

    ${mono(poster.tags, 108, 640, { size: 15, fill: palette.muted, letterSpacing: 1.6 })}
    <circle cx="112" cy="700" r="5.5" fill="${accent}"/>
    ${mono("$ npm i -g agent-trellis", 140, 709, { size: 24, weight: 500, letterSpacing: 0.2 })}

    ${figureFrame(1000, 250, 500, 450, "FIG.00 — RUNTIME", accent)}
    ${diagram}
    ${mono(poster.signal, 1250, 745, { size: 14, fill: accent, anchor: "middle", letterSpacing: 2 })}

    <path d="M64 784 H1536" stroke="${palette.line}" stroke-width="1.5"/>
    ${mono("AGENT TRELLIS — UNIFIED CODE AGENT RUNTIME", 64, 822, { size: 13.5, fill: palette.muted, letterSpacing: 1.5 })}
    ${mono("agent-trellis.dev", 1536, 822, { size: 13.5, fill: palette.muted, anchor: "end", letterSpacing: 1.5 })}
  </g>
</svg>`;
  const svgPath = join(outputDir, `${filename}.svg`);
  writeFileSync(svgPath, svg);
  execFileSync("qlmanage", ["-t", "-s", "1600", "-o", quickLookDir, svgPath], { stdio: "ignore" });
  const rendered = join(quickLookDir, `${filename}.svg.png`);
  const cropped = join(quickLookDir, `${filename}-cropped.png`);
  execFileSync("sips", ["--cropToHeightWidth", "900", "1600", rendered, "--out", cropped], { stdio: "ignore" });
  execFileSync("sips", ["-z", "675", "1200", cropped, "--out", join(outputDir, `${filename}.png`)], { stdio: "ignore" });
};

for (const poster of posters) {
  makeVertical(poster, "en");
  makeVertical(poster, "zh");
}
makeHorizontal(posters[0], "en");
makeHorizontal(posters[0], "zh");

console.log(`Generated ${posters.length * 2} vertical posters and 2 horizontal posters in ${outputDir}`);
