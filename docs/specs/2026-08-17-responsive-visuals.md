# Responsive pass: the market visuals and the new header controls

**Status: Built in part** (corrected 2026-09-23; it said "proposed"). The charts render SVG at
the measured container width (`useMeasuredWidth`), and `charts/marketPanel.test.tsx` renders
at 375px. The Mine overview rule has nothing to apply to, because that visual is not built.
This correction does not check each rule below one by one.

The round-two mockups (`app/mockups/market-graph-2.html`) are desktop
artifacts: every chart is a fixed 1240-unit SVG viewBox scaled by CSS width. That is right
for a mockup a designer scrolls on a laptop and wrong for a product page — below ~700px the
scaled type falls under legibility. This document says how each visual behaves when it lands
in the app (per `2026-08-17-market-visuals-page-layouts.md`), and what the new header
controls owe small screens. The house rules are the `ui-layout-standards` checklist; the
hard ones here: one padding layer, no body sideways scroll ever, long values wrap at 375px,
`p-2 sm:p-4`, outlines are outset shadows, verify at 375px and full width before calling it
done.

## Per-visual behavior

Charts are React components that render SVG from data at the container's measured width
(one `ResizeObserver` per chart), not fixed viewBoxes scaled down. Text renders at a fixed
px size regardless of chart width; the *plot* compresses, the type does not.

- **Sign preview (variant A/D)** — beside the form ≥`lg`, stacked under it below. Under
  `sm`, drop the curve to its essentials: draft marker, the pool line, the one-sentence
  verdict. The depth number ("moves this pool 3.4%") is text and survives every width.
- **Board pair strip (variant E future zone)** — a fixed-height strip (~96px) at every
  width; the time axis compresses. Below `sm` drop the per-segment `#id` labels; hover/tap
  keeps the detail (progressive disclosure, rule 11).
- **BatchTray walk (variant C)** — the tray is already a fixed overlay; the walk gets a
  height cap and scrolls horizontally *inside its own container* when the batch is long
  (rule 10 allows a scrolling table inside `overflow-x-auto`; the page body never scrolls
  sideways).
- **Mine overview (variant A)** — full width above the rows; below `sm` it collapses to
  per-row sparks only. An overview nobody can read is worse than none.
- **Ladder (variant F)** — desktop-only until real trade history exists; when built, below
  `md` drop the traded column first, then offered bars become numbers.

Empty states obey the same rules: the "no swaps" message must fit a 375px strip without
truncation.

## Header at 375px (`app/src/App.tsx` header block)

The header is `flex-wrap` and grows two controls: the language globe
(`2026-08-17-i18n.md`) and the icon-only endpoints button (`2026-08-17-rpc-controls.md`).

- Order at small widths: wordmark, view icons, then the trailing cluster (network, globe,
  endpoints, help, wallet) wrapping as one group. Verify no control clips and the tap
  targets stay ≥28px.
- The endpoints button loses `hidden sm:flex` when it becomes icon-only; confirm the row
  still fits with a connected wallet address chip visible.
- The language popover: full available width capped at `max-w`, never wider than the
  viewport minus the gutter; the search input and list scroll within the popover, not the
  page.

## Existing surfaces to re-verify while in there

- Board table: `min-w-[760px]` inside `.scroll-x` (`App.tsx:549-591`) — correct pattern;
  confirm the new pair strip sits *outside* the scroll container so it never scrolls with
  the columns.
- Stats `dl`: `grid-cols-2 sm:grid-cols-4` — fine; new stat cells must not break the pairing.
- `RpcSettings` panel: `min-w-80` — at 320px viewports this forces body scroll; change to
  `w-full max-w-lg` and let padding do the rest.
- Mockup files themselves are exempt: they are review artifacts at a stated 1280px, not
  shipped UI.

## Method

Playwright at 375, 768, 1280: assert
`document.documentElement.scrollWidth === clientWidth`, screenshot each view, and walk the
`ui-layout-standards` checklist against the diff. A change is not done until the 375px
screenshot has been looked at.
