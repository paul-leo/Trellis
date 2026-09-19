# Agent Trellis poster series v3

A parallel redesign of the brand mark and social posters. Nothing from the
earlier iterations was overwritten — all three generations coexist for
comparison:

| Iteration | Location | Direction |
|---|---|---|
| v1 | [../poster-series/](../poster-series/) | White editorial layout, single blue accent, logo mark scaled up in the hero zone. (The committed baseline is `f4e5136`; the directory currently also carries uncommitted local edits from an abandoned iteration.) |
| v2 | [../poster-series/v2/](../poster-series/v2/) | Same blue "rail" mark, refined spacing, boxed hero zone. |
| **v3 (this directory)** | here | New single-ink mark candidates, per-theme accent colors, and a real per-theme diagram in the hero zone. |

What v3 changes versus v1/v2:

- The hero zone of each poster is a purpose-built diagram (agent paths,
  migration flow, shared memory rail, context handoff) instead of the logo
  scaled up inside empty corner brackets.
- Each theme gets its own quiet accent color (indigo / teal / violet /
  orange); the mark itself stays single-ink.
- The kicker/title overlap in the v1 English layout is fixed; all metrics are
  computed from the title baseline.
- One horizontal 1200x675 master (X/Twitter, WeChat article header) joins the
  3:4 verticals, in both English and Chinese.

## Mark candidates

Three single-ink candidates were explored; see
[logo-candidates-v3.png](../brand-v3/logo-candidates-v3.png) for the rendered
comparison at 168/56/32/16 px.

| Candidate | File | Idea |
|---|---|---|
| A — Lattice T | [svg](../brand-v3/trellis-mark-v3-a.svg) / [png](../brand-v3/trellis-mark-v3-a.png) | The letter T; its beam is a trellis lattice. The name drawn as the structure. **Used in the v3 posters.** |
| B — Constellation T | [svg](../brand-v3/trellis-mark-v3-b.svg) / [png](../brand-v3/trellis-mark-v3-b.png) | Nine agent dots; the five on the shared runtime path connect into a T, the rest stay open. |
| C — Lattice panel | [svg](../brand-v3/trellis-mark-v3-c.svg) / [png](../brand-v3/trellis-mark-v3-c.png) | A classic garden-trellis crosshatch panel holding one agent node. |

To switch the posters to another candidate, replace the `mark()` helper in
`scripts/generate-poster-series-v3.mjs` with the geometry from the chosen file.

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
node scripts/generate-brand-v3.mjs          # mark candidates + comparison sheet
node scripts/generate-poster-series-v3.mjs  # 8 vertical + 2 horizontal posters
```

Both scripts write SVG masters into `docs/assets/` and render PNGs through
`qlmanage` + `sips` (macOS built-ins, no extra dependencies).
