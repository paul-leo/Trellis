import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(root, "docs/assets/brand-v3");
const quickLookDir = "/tmp/trellis-brand-v3";

mkdirSync(outputDir, { recursive: true });
mkdirSync(quickLookDir, { recursive: true });

const INK = "#161c24";
const PAPER = "#fafaf8";

// 45-degree crosshatch lines covering a rect (relies on a clipPath to trim).
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

// Candidate A — "Lattice T": the letter T whose beam is a trellis lattice.
// Meaning: the product name, drawn as the structure itself.
const markA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-labelledby="title desc">
  <title id="title">Trellis mark A</title>
  <desc id="desc">A letter T whose beam is a trellis lattice.</desc>
  <g fill="none" stroke="${INK}" stroke-linecap="round">
    <rect x="16" y="18" width="64" height="18" rx="9" stroke-width="5.5"/>
    <g stroke-width="2.6" clip-path="url(#a-beam)">${hatchLines(21, 23, 54, 9, 13.5)}</g>
    <path d="M48 36 V78" stroke-width="5.5"/>
  </g>
  <defs><clipPath id="a-beam"><rect x="21" y="23" width="54" height="9" rx="4.5"/></clipPath></defs>
</svg>`;

// Candidate B — "Constellation T": nine agent dots; the ones on the shared
// runtime path connect into a T, the rest stay open.
const filledDots = [[26, 26], [48, 26], [70, 26], [48, 48], [48, 70]]
  .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="4.4" fill="${INK}" stroke="none"/>`).join("");
const openDots = [[26, 48], [70, 48], [26, 70], [70, 70]]
  .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="3.8" fill="none" stroke-width="2.2"/>`).join("");
const markB = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-labelledby="title desc">
  <title id="title">Trellis mark B</title>
  <desc id="desc">Nine agent dots; five connect into a shared T-shaped runtime.</desc>
  <g fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M26 26 H70 M48 26 V70" stroke-width="4.5"/>
    ${openDots}
    ${filledDots}
  </g>
</svg>`;

// Candidate C — "Lattice panel": a classic garden-trellis crosshatch panel
// with one agent node held at its center.
const markC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-labelledby="title desc">
  <title id="title">Trellis mark C</title>
  <desc id="desc">A trellis lattice panel holding a single agent node.</desc>
  <g fill="none" stroke="${INK}">
    <rect x="15" y="15" width="66" height="66" rx="15" stroke-width="5"/>
    <g stroke-width="2.6" clip-path="url(#c-panel)">${hatchLines(20, 20, 56, 56, 15.5)}</g>
  </g>
  <circle cx="48" cy="48" r="10.5" fill="#ffffff"/>
  <circle cx="48" cy="48" r="6.5" fill="${INK}"/>
  <defs><clipPath id="c-panel"><rect x="20" y="20" width="56" height="56" rx="11"/></clipPath></defs>
</svg>`;

const marks = [
  { slug: "a", name: "A / LATTICE T", svg: markA },
  { slug: "b", name: "B / CONSTELLATION T", svg: markB },
  { slug: "c", name: "C / LATTICE PANEL", svg: markC },
];

for (const mark of marks) {
  const svgPath = join(outputDir, `trellis-mark-v3-${mark.slug}.svg`);
  writeFileSync(svgPath, mark.svg);
  execFileSync("qlmanage", ["-t", "-s", "512", "-o", quickLookDir, svgPath], { stdio: "ignore" });
  execFileSync("sips", ["-s", "formatOptions", "100", join(quickLookDir, `trellis-mark-v3-${mark.slug}.svg.png`), "--out", join(outputDir, `trellis-mark-v3-${mark.slug}.png`)], { stdio: "ignore" });
}

// Comparison sheet: all three candidates at 168px plus small-size checks.
// qlmanage renders a square canvas, so the 1200x760 sheet sits centered in a
// 1200x1200 document and gets center-cropped afterwards.
const SHEET = 1200;
const BAND = (SHEET - 760) / 2;
const sheetMark = (svg, cx, cy, size) => {
  const inner = svg.replace(/<svg[^>]*>/, "").replace("</svg>", "");
  return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${size / 96})">${inner}</g>`;
};
const label = (value, x, y, size = 17, fill = INK) =>
  `<text x="${x}" y="${y}" text-anchor="middle" font-family="Menlo, SFMono-Regular, monospace" font-size="${size}" letter-spacing="2.5" fill="${fill}">${value}</text>`;

const columns = marks.map((mark, index) => {
  const cx = 200 + index * 400;
  return `
  ${sheetMark(mark.svg, cx, BAND + 330, 168)}
  ${label(mark.name, cx, BAND + 478)}
  ${sheetMark(mark.svg, cx - 88, BAND + 620, 56)}
  ${sheetMark(mark.svg, cx, BAND + 620, 32)}
  ${sheetMark(mark.svg, cx + 64, BAND + 620, 16)}
  ${label("56 / 32 / 16", cx, BAND + 692, 13, "#69727d")}`;
}).join("");

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET}" height="${SHEET}" viewBox="0 0 ${SHEET} ${SHEET}">
  <rect width="${SHEET}" height="${SHEET}" fill="${PAPER}"/>
  ${label("TRELLIS MARK — V3 CANDIDATES", 600, BAND + 120, 20)}
  <path d="M340 ${BAND + 148} H860" stroke="#dfe4ea" stroke-width="1.5"/>
  ${columns}
</svg>`;

const sheetPath = join(outputDir, "logo-candidates-v3.svg");
writeFileSync(sheetPath, sheet);
execFileSync("qlmanage", ["-t", "-s", "1200", "-o", quickLookDir, sheetPath], { stdio: "ignore" });
execFileSync("sips", ["--cropToHeightWidth", "760", "1200", join(quickLookDir, "logo-candidates-v3.svg.png"), "--out", join(outputDir, "logo-candidates-v3.png")], { stdio: "ignore" });

console.log(`Wrote ${marks.length} mark candidates and a comparison sheet to ${outputDir}`);
