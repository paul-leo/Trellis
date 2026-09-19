# Agent Trellis poster series

The canonical brand mark and social poster series. The earlier v1 and v2
iterations were retired and removed; they remain in git history (`f4e5136`,
`1045bb6`).

Design notes:

- The hero zone of each poster is a purpose-built diagram (agent paths,
  migration flow, shared memory rail, context handoff) instead of the logo
  scaled up inside empty corner brackets.
- Each theme gets its own quiet accent color (indigo / teal / violet /
  orange); the mark itself stays single-ink.
- The kicker/title overlap in the v1 English layout is fixed; all metrics are
  computed from the title baseline.
- One horizontal 1200x675 master (X/Twitter, WeChat article header) joins the
  3:4 verticals, in both English and Chinese.
- Vertical posters are phone-first (feed width ~390 css px): body text runs at
  34/35 px, diagram labels at 16-17 px, install line at 32 px. The horizontal
  masters are desktop-first and keep the denser metrics.

## Mark

The brand mark is the **Lattice T** — the letter T whose beam is a trellis
lattice: [svg](../brand-v3/trellis-mark-v3-a.svg) /
[png](../brand-v3/trellis-mark-v3-a.png). It is a single-ink symbol and is the
same mark used in the README header and every poster. Two retired alternates
(constellation T, lattice panel) remain in git history.

## Posters

Vertical masters are 1080x1440 (3:4, Xiaohongshu / WeChat Moments); horizontal
masters are 1200x675 (16:9). SVG sources are the editable masters.

| Theme | EN | ZH |
|---|---|---|
| Unified runtime | [svg](agent-trellis-poster-v3-unified-en.svg) / [png](agent-trellis-poster-v3-unified-en.png) | [svg](agent-trellis-poster-v3-unified-zh.svg) / [png](agent-trellis-poster-v3-unified-zh.png) |
| One-command migration | [svg](agent-trellis-poster-v3-migrate-en.svg) / [png](agent-trellis-poster-v3-migrate-en.png) | [svg](agent-trellis-poster-v3-migrate-zh.svg) / [png](agent-trellis-poster-v3-migrate-zh.png) |
| Shared memory | [svg](agent-trellis-poster-v3-memory-en.svg) / [png](agent-trellis-poster-v3-memory-en.png) | [svg](agent-trellis-poster-v3-memory-zh.svg) / [png](agent-trellis-poster-v3-memory-zh.png) |
| Switch agents | [svg](agent-trellis-poster-v3-switch-en.svg) / [png](agent-trellis-poster-v3-switch-en.png) | [svg](agent-trellis-poster-v3-switch-zh.svg) / [png](agent-trellis-poster-v3-switch-zh.png) |
| Horizontal hero | [svg](agent-trellis-poster-v3-horizontal-en.svg) / [png](agent-trellis-poster-v3-horizontal-en.png) | [svg](agent-trellis-poster-v3-horizontal-zh.svg) / [png](agent-trellis-poster-v3-horizontal-zh.png) |

## Copy

Same approved copy as v1:

- `One Runtime. Every Code Agent.` / 一个 Runtime，统一所有 Code Agent。
- `Migrate in one command.` / 一条命令，迁移现有配置。
- `Keep context in the loop.` / 让上下文始终在线。
- `Change Agents. Keep moving.` / 切换 Agent，不丢上下文。

## Regenerate

```bash
node scripts/generate-brand-v3.mjs          # brand mark
node scripts/generate-poster-series-v3.mjs  # 8 vertical + 2 horizontal posters
```

Both scripts write SVG masters into `docs/assets/` and render PNGs through
`qlmanage` + `sips` (macOS built-ins, no extra dependencies).
