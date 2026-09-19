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

// "Lattice T" — the letter T whose beam is a trellis lattice.
// Retired alternates (constellation T, lattice panel) live in git history.
const markA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-labelledby="title desc">
  <title id="title">Trellis mark</title>
  <desc id="desc">A letter T whose beam is a trellis lattice.</desc>
  <g fill="none" stroke="${INK}" stroke-linecap="round">
    <rect x="16" y="18" width="64" height="18" rx="9" stroke-width="5.5"/>
    <g stroke-width="2.6" clip-path="url(#a-beam)">${hatchLines(21, 23, 54, 9, 13.5)}</g>
    <path d="M48 36 V78" stroke-width="5.5"/>
  </g>
  <defs><clipPath id="a-beam"><rect x="21" y="23" width="54" height="9" rx="4.5"/></clipPath></defs>
</svg>`;

const svgPath = join(outputDir, "trellis-mark-v3-a.svg");
writeFileSync(svgPath, markA);
execFileSync("qlmanage", ["-t", "-s", "512", "-o", quickLookDir, svgPath], { stdio: "ignore" });
execFileSync("sips", ["-s", "formatOptions", "100", join(quickLookDir, "trellis-mark-v3-a.svg.png"), "--out", join(outputDir, "trellis-mark-v3-a.png")], { stdio: "ignore" });

console.log(`Wrote the Trellis mark to ${outputDir}`);
