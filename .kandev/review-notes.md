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
  aimed at the fallback rather than being a margin over the app font — which is
  why the guard holds 22 and rejects 23 (23 fits the app font at 258px but not
  the fallback at 280px). Before the fix the two modelling errors cancelled at
  22 characters, which is what made the budget look closed. See the 0.5.5 entry
  below for the one respect in which 12px/char is *not* a full cover.
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

- `ui/bundle.js:74-79`, `CHANGELOG.md` — the geometry comment claimed the
  regression test "sizes the budget for the wider of the two" measured glyphs,
  and the changelog that the 12px bound "holds for both". Neither is true at
  the cap: 22 x 12.18px = 268px against 264px of text area, so the bound sits
  ~4px *under* the fallback's worst case rather than covering it (the app font
  fits outright at 247px). The comment now says so; 0.5.4's changelog entry is
  left as written, since that build shipped to the QA host, and the correction
  is recorded in the new 0.5.5 entry instead. Practical exposure is a
  22-character all-wide-glyph name during the font-load window only.
  `MAX_TAG_LENGTH` stays 22 — the requested cap — and the guard still holds 22
  and rejects 23. This is the
  third pass over these same numbers, which is the argument for keeping the
  arithmetic in the comment rather than the intent. Version moved to 0.5.5 for
  it, since `ui/bundle.js` changed and 0.5.4 was already installed on QA.

Version is `0.5.5`. Each bump here is forced by the same rule, not cosmetic: any
`ui/bundle.js` change needs a new version because the installer rejects a reused
one with a 409, and every preceding number is spent on a build that was actually
installed on the QA host — 0.5.2 during review (then withdrawn), 0.5.3, and
0.5.4 for the QA re-run that validated the nine requirement checks against a
served bundle diffed byte-identical to source. 0.5.5 covers the comment
correction above.

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

- **`fix/tag-chip-contrast` collides with this branch on version and base.**
  That branch (task `61cdcf0a`, the follow-up below) is stacked on `85a76e6`,
  two commits behind this branch's tip, and independently bumps
  `manifest.yaml` from `0.5.3` to **`0.5.4`** — a number this branch had
  already taken in `3aa9ba6` *and* installed on the QA host. Because both
  sides write the identical value, `manifest.yaml` merges *cleanly* and ships
  a different bundle under a version already claimed, which is exactly the
  reuse the installer answers with a 409. `CHANGELOG.md` will conflict
  outright, as both add a `[0.5.4]` section. This branch is now at `0.5.5`, so
  land it first, then rebase that one onto this tip and renumber it to
  **`0.5.6`**. Flagged to that task directly.
