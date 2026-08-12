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

No version bump for these: `0.5.4` has not shipped, so both were introduced and
closed inside the same unreleased version.

## Action required by author

- **Merge order.** This branch stacks on `feature/fix-tag-display-and-e00`
  (sibling task `ae8fc022`, unmerged). That branch must land first.
- **Surface the user-visible colour change in the PR.** Three palette colours
  flip from white to dark (`#111827`) chip text because white on them scored
  below the 3.0 contrast floor: `#eab308` yellow (1.92), `#22c55e` green (2.28),
  `#f97316` orange (2.80). The other four palette colours and `DEFAULT_COLOR`
  are unchanged. Already recorded in `CHANGELOG.md` under `0.5.4`.
