# Review notes (kandev-plugin-tags)

Scope: the tag-chip contrast fix (`fix/tag-chip-contrast`, commit `83602f2`).
This branch is stacked on `feature/fix-tag-display-and-e00`; the notes this file
previously held belong to that branch's own review and travel with its PR.

## Fixed during review

- `ui/bundle.js:218` — `resolveRgbViaCanvas` detected a rejected `fillStyle`
  assignment by probing with two sentinels but comparing a single read against
  only the second one, so the first sentinel did no work. Any colour that
  legitimately normalises to that sentinel — `rgb(253, 254, 255)` and its
  equivalents normalise to `#fdfeff` — read as a rejection, and
  `renderableColor` then recoloured that perfectly renderable tag to
  `DEFAULT_COLOR`. `raw` is now assigned after each sentinel and the two reads
  compared; they agree only when the canvas accepted the value. The test fake
  now models a real canvas's opaque-to-`#rrggbb` normalisation, which is what
  makes the case reachable, and the new regression test fails against the
  previous implementation. (commit `d2bd0a9`)
- `ui/bundle.js:2174` — dropped `relativeLuminance` from `__internal`; that
  object exists for `ui/bundle.test.js` only and no test read it.
  (commit `d2bd0a9`)

No version bump for those two: they were introduced and closed inside the same
unreleased version.

- `Makefile:4`, `manifest.yaml:6`, `CHANGELOG.md:3` — renumbered this branch's
  release `0.5.4` -> `0.5.5`. `feature/fix-tag-display-and-e00`, the branch this
  one is stacked on, bumped to `0.5.4` independently (commit `3aa9ba6`) while
  this branch was open, so both claimed the same version with different
  contents. Since that branch merges first, this one would have shipped a second
  `0.5.4` and the installer rejects a reused version with
  `409 version already installed`. `0.5.5` is free (`0.5.2` is spent — installed
  on the QA host during review, then withdrawn).

## Action required by author

- **Merge order.** This branch stacks on `feature/fix-tag-display-and-e00`
  (sibling task `ae8fc022`, unmerged). That branch must land first.
- **This branch was not rebased onto the new base.** `fix/tag-chip-contrast` is
  pushed to `origin`; `feature/fix-tag-display-and-e00` is local-only. Rebasing
  onto it would rewrite published history *and* make the pushed branch depend on
  commits that are not on `origin`, so the review left history alone and fixed
  only the version collision. Expect a `CHANGELOG.md` conflict at merge (both
  branches prepend a section); resolving it means dropping this branch's
  placeholder note and letting `0.5.4` sit between `0.5.5` and `0.5.3`.
- **Surface the user-visible colour change in the PR.** Three palette colours
  flip from white to dark (`#111827`) chip text because white on them scored
  below the 3.0 contrast floor: `#eab308` yellow (1.92), `#22c55e` green (2.28),
  `#f97316` orange (2.80). The other four palette colours and `DEFAULT_COLOR`
  are unchanged. Already recorded in `CHANGELOG.md` under `0.5.5`.
- **Open blocker — partially transparent backgrounds still get unreadable
  text.** `ui/bundle.js:299` (`relativeLuminance`) ignores alpha, and
  `renderableColor` (`ui/bundle.js:372`) only rejects `a === 0`. A background
  with `0 < a < 1` is therefore measured as if it were opaque, so the same
  invisible-chip bug this branch closes stays open by degree. Verified against
  this commit: `chipStyle("#00000019")` returns background `#00000019` with
  text `#ffffff` — a 10%-opaque black chip (≈ `#e6e6e6` over a light card)
  carrying white text, contrast ≈ 1.2. Reachable by the same route QA used for
  `"transparent"` and `"currentcolor"`: PUT the colour straight into the
  `tags-catalog` user-state key. Left unfixed deliberately — the two defensible
  fixes (reject `a < 1` outright, consistent with the existing `a === 0` rule
  and with `normalizeColor` only ever writing opaque hex; or composite over an
  assumed backdrop, which this plugin cannot know since the chip's surface is
  host-theme-dependent) trade off differently and change documented
  user-visible rendering, so the choice belongs to the author.
