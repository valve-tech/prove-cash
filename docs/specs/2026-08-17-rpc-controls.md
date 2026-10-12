# RPC button and endpoints modal

**Status: built, 2026-08-17.** Two controls carried words they did not need. The header
printed "one.valve.city" in the nav, which is noise nobody asked to read. The modal's
"locked · one URL" pill described state that lives two fields below it. Both now use icons
that carry their words in tooltips and labels, the way the view icons already do
(`ViewIcon.tsx:6-8`).

An earlier draft of this file opened by attributing these two findings to the owner as
statements they had made. They had not; an agent wrote that attribution and it was false.
The owner has since approved the changes themselves. The rest of this document is the
proposal as written, with a record of what shipped at the end.

## Header button (`app/src/App.tsx` ~319-337)

Today: a `hidden sm:flex` button showing the health dot plus `rpcHost()` — the raw domain, or
two domains joined with "·" when board and chain differ.

Proposed:

- **Icon-only.** The owner's own route mark — a hub with three spokes out to three nodes.
  It says "this is where your reads go" without a word of English in it. (This paragraph
  first proposed a server-stack outline; the owner chose the route mark instead.) 16px,
  `stroke="currentColor"`, drawn in the style of `ViewIcon`.
- The **health dot stays**, with its existing three-state shape semantics (disc live, ring
  waiting, square broken — `App.tsx:314-318` explains why shape, not hue alone). Keep it
  beside the icon, not overlaid; an overlay hides the shape at 6px.
- The **host string moves** to the tooltip and the `aria-label`:
  "Endpoints: board live — one.valve.city. Bring your own node." Nothing else renders it.
- Because the button is now ~28px, drop `hidden sm:` — it fits on mobile, and mobile users
  bring their own nodes too.
- When either endpoint differs from the default, the tooltip says "custom". No extra badge;
  the dot row stays one glyph wide.

## The modal (`app/src/components/RpcSettings.tsx`)

Today: a pill in the title row toggles between "locked · one URL" and "unlocked · two URLs"
(`RpcSettings.tsx:189-204`). The pill's words describe state that lives two fields below it.

Proposed:

- **Delete the pill.** The state moves to where the state acts: a chain-link icon button in
  the *chain field's* label row, right-aligned.
- Linked: the icon is filled/`--color-proven`, the chain input is disabled and mirrors the
  board URL (existing behavior, `effectiveChainUrl`). Tooltip: "Chain reads use the board
  URL. Click to set a separate URL." `aria-pressed=true`.
- Unlinked: the icon is hollow/dim, the chain input is editable. Tooltip: "Separate chain
  URL. Click to reuse the board URL." `aria-pressed=false`.
- The icon is a standard two-loop chain link (universal, language-free). A diagonal slash
  variant when unlinked is acceptable if the fill/hollow contrast reads poorly.
- Behavior preserved exactly: toggling to unlinked seeds the chain field with the board URL
  (`RpcSettings.tsx:198-202`); save writes `''` for chain while linked (`save()`,
  lines 165-171); each toggle resets that field's check to idle.
- The board field gets no icon. One icon, on the dependent field, states the dependency in
  the direction it flows.

## What does not change

- Per-field Check / Default buttons and their result lines (`Field`, lines 49-126).
- `checkBoard` / `checkChain` probes and their copy.
- The default-key note under the save button.
- Dialog semantics (`useDialog`, Escape, backdrop click).

## Acceptance

- No raw domain renders in the header; a screen reader still hears board health and hosts.
- A first-time reader of the modal can tell, without toggling anything, that the chain field
  currently follows the board field — from the disabled input, the mirrored value, and the
  lit link icon together.
- All strings added here go through the i18n keys once `2026-08-17-i18n.md` lands; the icons
  themselves are the language-free part.
- Works at 375px (the new icon must not wrap the label row).

## What shipped

Two components. `App.tsx` is not touched here — the header owner wires the button in.

**`app/src/components/EndpointsButton.tsx`.** Four props and nothing else:
`health: 'live' | 'waiting' | 'broken'`, `custom: boolean`, `host: string`,
`onClick: () => void`. The component owns the words: `HEALTH` maps the three states to
"board live", "board not accepting posts" and "board unreachable", which is the same split
`App.tsx` already computes from `status?.enabled` and `error`. The host renders in exactly
two places, the `TipUnder` tooltip and the `aria-label`, and a test counts the occurrences so
a third cannot appear unnoticed. The dot keeps its three shapes beside the mark, not over it.

The route mark is redrawn rather than divided. At 1/64 the source hub lands at r1.1 and the
nodes at r0.8 — under a pixel each, which renders as a grey smudge. The shipped glyph scales
the source 1.75x about the figure's own centre and uses filled discs at r1.5 and r1.25
against a 1.1 spoke, with the spokes stopping short of every disc. Six earlier parameter sets
were rendered at 16px and rejected: everything with a heavier spoke or a smaller node
contrast collapsed into a stick figure, which the header can least afford — the "mine" view
icon beside it is a person. A hollow hub was tried twice and rejected both times; at 16px the
hole is one pixel and fills with grey.

**`app/src/components/RpcSettings.tsx`.** The pill is gone and the title row is just the
heading. `Field` grew an `action` slot for its label row, and only the chain field passes
one. The toggle and the save write are pure functions, `toggleLink` and `savedUrls`, so the
three preserved behaviours are tested without a browser (`RpcSettings.test.tsx`). The link
glyph is a closed two-loop chain in `--color-proven` when linked and a parted one in
`--color-dim` when not — shape and colour, not colour alone.

The panel's `min-w-80` became `w-full max-w-lg`, per `2026-08-17-responsive-visuals.md`.

Measured in Chromium with the dialog open:
`document.documentElement.scrollWidth === clientWidth` at 320, 375 and 1280. The tooltip
appears on hover and on keyboard focus, and at 1280 it stays inside the viewport.
