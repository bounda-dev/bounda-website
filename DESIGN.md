# Bounda design system

Version 1. One brand in two modes, Basalt (dark) and Bone (light), used by the landing page (bounda.dev), the documentation (docs.bounda.dev) and Bounda Studio.

## Principles

1. **The mechanism is the image.** Visuals show what Bounda does: facts appended at the end of one global order, state folded from them, views rebuilt from position 1. No allegories, no photographs.
2. **Logos live on made things.** The mark appears on the interface and on manufactured objects (the monolith, a nameplate), never planted in a landscape.
3. **Annotate only what belongs.** At most three annotations in view. A readout is either part of the object or plainly interface.
4. **Two modes, one brand.** Neither mode is a fallback. Every token exists in both.

## Color

Warm basalt and bone neutrals, one ochre accent, and state colors that never double as brand.

| Token | Basalt (dark) | Bone (light) | Role |
|---|---|---|---|
| `--bg` | `#121314` | `#ECEAE4` | Page ground |
| `--surface` | `#1B1C1E` | `#F7F6F2` | Cards, tables, code |
| `--raised` | `#232426` | `#E3E0D8` | Hover, selected rows, insets |
| `--rule` | `#2E2F32` | `#D3CFC5` | Hairlines and borders |
| `--text` | `#E6E0D3` | `#1A1916` | Primary text |
| `--muted` | `#9C978C` | `#5F5B53` | Secondary text, labels, code comments |
| `--faint` | `#6E6A62` | `#8F8A7F` | Never text: ticks, rules, empty cells |
| `--accent` | `#D9A04A` | `#B07114` | Brand fill: the live stream head, focus rings, primary actions |
| `--accent-text` | `#D9A04A` | `#8A5508` | Brand color for text and links |
| `--accent-soft` | `#2E2414` | `#EADFC9` | Tinted backgrounds for brand moments |
| `--error` | `#E8604F` | `#B3362A` | Errors, refused commands, dead letters, corrections |
| `--warning` | `#E3C457` | `#725F0B` | Warnings, always with a label or icon |
| `--success` | `#7DBF9C` | `#2C6B53` | Success, caught-up consumers |

Contrast (WCAG): every text token is at least 5:1 on `--bg` in both modes; `--accent` as a fill is at least 3:1. `--faint` is below 4.5:1 on purpose and never carries text.

Rules:

- **Ochre is the brand, never a state.** A status is never ochre.
- **Red means error or correction.** In ledger tables, a correction is a new row in parentheses in `--error`, the accounting convention for negatives.
- **Warnings carry a label or icon**, so they never rely on hue alone next to ochre.
- In Bone, ochre text uses `--accent-text`; `--accent` is for fills and large shapes only.

Code theme (both modes derive from the palette): keywords and numbers `--accent-text`, strings `--code-string`, a verdigris (`#8FC2B0` / `#4F6B5E`), types `--code-type`, a stone (`#B9B4A7` / `#4A4E57`), comments `--muted`, everything else `--text`, function names in bold.

## Typography

| Role | Face | Use |
|---|---|---|
| Display | Science Gothic 600, width 106% (104% for small titles) | Headlines and section titles. Never running text. |
| Label | Science Gothic 600, width 125%, uppercase, tracking 0.14em | Small labels, table headers, nav, engraved legends |
| Text | IBM Plex Sans 400/500/600 | Body, docs, UI. Docs at 16.5px / 1.62; dense tables at 13.5px |
| Mono | Red Hat Mono 400/500/600 | Code, positions, ids, amounts. Ligatures off; figures are tabular |

Self-hosted from Google Fonts at build time (Astro's font API, which also generates metric-matched fallbacks): `Science Gothic` at weight 600 only, across width 100–125%; `IBM Plex Sans` 400–600; `Red Hat Mono` 400–600. Further fallbacks: Eurostile / Bahnschrift / Arial Black for Science Gothic; system-ui for Plex; ui-monospace for Red Hat Mono.

## Logo

- **Lockup:** the ⅃ symbol and the Ledger wordmark. The symbol is the module: bar 10, foot 6 by 25, tail 8. In the wordmark, verticals are 10 and horizontals 6; the `d` is the ⅃ with a bowl and descends by the tail.
- **Clear space:** the foot's length (25 units) on every side.
- **Minimum size:** lockup 16px tall; symbol 12px. Favicons use the pixel cuts (32px: bar 5, foot 3; 16px: bar 3, foot 2, tail 2).
- **Color:** `--text` on `--bg`. The lockup is never ochre; the symbol alone may be ochre when it closes something (see below).
- **Don't:** stretch, outline, add effects, set the wordmark in a font, or build the mark as a landmark in a scene.
- **Files:** `brand/` holds the lockup and the symbol in `currentColor`, on Bone and on Basalt, and the app icon as SVG and as a 1024px PNG. The site's favicons are in `public/`.

## The ⅃ as a device

The symbol doubles as the closing corner: a thick vertical with a thinner foot, placed at the bottom-right of the thing it closes.

- A callout, a card or a section that is complete.
- A closed balance in a ledger table (with a double rule above it).
- One per element. Never a repeated pattern or a decoration.

## Ledger grammar

How every table of facts is set, in docs, on the landing page and in Studio:

- **Position first**, in mono, muted: `004 211`.
- **Tabular figures**, amounts right-aligned.
- **Corrections are new rows**, in parentheses, in `--error`. Nothing above is rewritten.
- **A closed balance** gets a double rule and the ⅃ corner.
- Stream ids read `aggregate/id` (`orders/7f3a`).

## Motion

**Append-only.** New content enters at the end (below, or to the right). Nothing reorders or changes in place; a change arrives as a new entry. Replays run in order from position 1.

- UI transitions 160ms; reveals 500–700ms; easing `cubic-bezier(.22, .8, .16, 1)`.
- A new row flashes `--accent-soft` and settles.
- `prefers-reduced-motion`: no movement; content is shown in its final state.

## Imagery and 3D

- The hero is the mechanism: the ⅃ as a machined monolith whose foot becomes the global stream, events moving along it, the live head in ochre.
- Real-time 3D in code (three.js), art-directed, in Basalt or Bone. No AI photography.
- **The object takes the logo's colour** (`--text` on `--bg`): satin aluminium on Basalt, black anodised on Bone. Each mode has its own studio; the geometry and the choreography are the same.
- Glows are ochre. On Basalt they add light; on Bone they tint, because added light disappears on a pale ground.
- Red appears in a scene only for a refused command or an error.

## Layout

- Corners square (radius 2px). Structure by hairlines (`--rule`), not by shadows.
- 4px spacing grid; 12 columns; gutter `clamp(16px, 4vw, 64px)`; max width 1312px.
- Content-led hero, not a full-viewport splash by default.

## The landing page

It is not a marketing website. It answers what Bounda is and why; anything about how belongs in the docs.

- **Content, in order:** what Bounda is, in one sentence; what problem it solves (CQRS and event sourcing in TypeScript done right); how it works, as the story the scene tells (command, event, fold, projection, query, rebuild); what the code looks like; who it is for (senior engineers, backend-minded developers); why it exists (DX and correctness); how to start (`npm create bounda@latest`, GitHub).
- **One scene, one accent, at most three annotations on screen.** Light in the scene means something; no decorative glows, particles or neon.
- **No metaphors, no "enterprise transformation" language, no exaggerated claims.** Say how stable it is: before 1.0, a minor release can change the API.
- **Nothing depends on the 3D.** The page reads before the scene loads; without WebGL a drawing stands in, and with reduced motion the story is a still and a grid.
- **Inspirations, by feeling and not by copying:** Vercel (clarity, spacing), Resend (confidence, restraint), Linear (focus, calm UI), EventStoreDB's docs (technical seriousness), and scroll-driven product films (one manufactured object that plays its own mechanism as you scroll).

## Voice

Plain, technical, short. Active voice. The vocabulary of the product: event store, global stream, projection, read model, policy, process manager (never "log" for the store, never "saga").

## Where it lives

- Landing: `bounda-dev/bounda-website`, `src/styles/tokens.css`; the scene is `src/scripts/landing/scene.ts`.
- Docs: `docs/src/styles/bounda.css` in `bounda-dev/bounda`, mirroring the same tokens on Starlight's variables.
- Studio: the same tokens; the ledger grammar for every table.
