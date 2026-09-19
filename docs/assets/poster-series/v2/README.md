# Agent Trellis poster series — v2

This is a comparison set. Existing poster files in the parent directory are
left untouched; this folder contains a new logo direction and a new poster
system.

## Direction

- One-color line mark: three Agent paths share one horizontal Runtime rail.
- Light editorial canvas: warm white, ink, and one cobalt-blue signal color.
- Technology is expressed through alignment guides, coordinates, and system
  labels rather than gradients, glows, or decorative HUD layers.
- Vertical social assets use 1080×1440 (3:4); the horizontal hero uses
  1600×900 (16:9).

## Assets

| Format | Files |
|---|---|
| Horizontal hero | [`PNG`](agent-trellis-poster-v2-horizontal.png) · [`SVG`](agent-trellis-poster-v2-horizontal.svg) |
| Unified runtime | [`EN PNG`](agent-trellis-poster-v2-unified-en.png) · [`ZH PNG`](agent-trellis-poster-v2-unified-zh.png) |
| Migration | [`EN PNG`](agent-trellis-poster-v2-migrate-en.png) · [`ZH PNG`](agent-trellis-poster-v2-migrate-zh.png) |
| Shared context | [`EN PNG`](agent-trellis-poster-v2-memory-en.png) · [`ZH PNG`](agent-trellis-poster-v2-memory-zh.png) |
| Switch agents | [`EN PNG`](agent-trellis-poster-v2-switch-en.png) · [`ZH PNG`](agent-trellis-poster-v2-switch-zh.png) |

Every PNG has a matching SVG master in this folder.

The comparison logo is [`trellis-mark-v2.svg`](../../trellis-mark-v2.svg).

## Regenerate

From the repository root:

```bash
node scripts/generate-poster-series-v2.mjs
```
