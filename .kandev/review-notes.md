# Review notes (kandev-plugin-tags)

## Fixed during review

- `ui/bundle.test.js:1715` — the width-budget regression test compared a
  22-character worst case against the Create input's *border* box, so the host
  `Input`'s own 16px padding and 2px border counted as room for text, and the
  budget read 18px roomier than it is. The guard now measures the content box
  and is calibrated against measured glyph widths (commits `8d092d7`,
  `3aa9ba6`). Measured in Chrome at the input's computed 12px font: the
  self-hosted app font (Figtree) is 11.22px at its widest ASCII glyph, the
  fallback stack (Segoe UI / Arial) 12.18px. The 12px/char bound is therefore
  a deliberate cover for the fallback, not a margin over the app font — which
  is why the guard holds 22 and rejects 23 (23 fits the app font at 258px but
  not the fallback at 280px). Before the fix the two modelling errors cancelled
  at 22 characters, which is what made the budget look closed.
- `ui/bundle.js:68-89`, `:1556` — the geometry comments stated the budget wrong
  in three places: `262px` twice where the arithmetic gives `282px`, and
  `w-[360px]` for the `w-[320px]` class that was actually replaced. Those
  comments are the only record of why `MAX_TAG_LENGTH`, `TOPBAR_WIDTH` and
  `CREATE_BUTTON_WIDTH` move together, so a wrong number in them is a trap for
  the next edit. (commit `8d092d7`)
- `ui/bundle.js:1902` — a task-filter option's colour was the one place a stored
  colour still reached a rendered swatch without `renderableColor()`. Only
  reachable on a host that supports `registerTaskFilter` (this one does not),
  but the invariant should hold everywhere. (commit `8d092d7`)

Version is `0.5.3`, not `0.5.2`: `ui/bundle.js` changed, so the installer needs a
new version, and 0.5.2 was spent on a build installed on the QA host during
review and then withdrawn.

### Considered and rejected

A `max-width` cap on the Tags box, on the theory that a fixed 380px dropdown
would clip the Create button on a 375px phone. Measured live at 375px and 360px:
Radix already constrains the content to the viewport minus 16px (359px / 344px),
button fully visible, with or without the cap. The cap was redundant, so it was
reverted rather than shipped as dead CSS.

## Follow-up tasks created (out of scope for this PR)

- **Tag chips: white text is hard-coded regardless of colour**
  (task `61cdcf0a-9205-4593-b25f-56aa9d1c4ae8`) — `ui/bundle.js:193` and `:207`
  hard-code `color: "#fff"` for a chip's label whatever its background is.
  `renderableColor()` closes the *unparseable* colour case, but a colour that
  parses fine can still be unreadable: `"transparent"` passes `CSS.supports` and
  renders an invisible chip (the exact symptom `f082f7f` fixed, reached another
  way), `"currentcolor"` resolves to the chip's own `#fff` (white on white), and
  `rgba(0,0,0,0)` or any pale hex is unreadable. Introduced in `12ac076`
  (2026-08-07) by ayattara <alassane.yattara@savoirfairelinux.com>; the
  `denseChipStyle` copy came with `03bed70`, same author.

## Action required by author

None.
