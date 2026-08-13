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
- `ui/bundle.js:372` — `renderableColor` rejected a background only at alpha
  exactly 0, and `relativeLuminance` ignored alpha outright, so a colour with
  `0 < alpha < 1` was measured as if opaque and the invisible-chip bug this
  branch closes stayed open by degree. `chipStyle("#00000019")` returned
  background `#00000019` with text `#ffffff` — a 10%-opaque black chip
  (≈ `#e6e6e6` over a light card) carrying white text, contrast ≈ 1.2 —
  reachable by the same `tags-catalog` user-state PUT that QA used for
  `"transparent"` and `"currentcolor"`. Anything not fully opaque now falls
  back to `DEFAULT_COLOR`. Compositing was rejected as the alternative: the
  surface behind a chip belongs to the host and changes with its theme, so
  there is nothing here to composite against without hard-coding a guess that
  is wrong on the other theme. Nothing this plugin writes is affected —
  `normalizeColor` only ever emits opaque 3/6-digit hex — so only out-of-band
  values change, for which falling back is already the established answer.
  An alpha-carrying hex is now settled before the `CSS.supports` branch,
  closing a related gap where a host with no `CSS` object let `#ffffff00`
  through untouched. Three regression tests added; all three fail against the
  previous implementation. (commit `dbbf067`)

- `ui/bundle.js:147` — the `currentcolor` guard was anchored to the whole
  value (`/^currentcolor$/i`), so the keyword slipped through nested inside a
  colour function. The probe canvas resolves the nesting confidently — against
  its own elementless context, i.e. black — so nothing downstream had reason to
  doubt it, while the DOM resolves it against the chip's own `color`, which
  `chipStyle` sets. Measured in headless Chromium on both the light and the
  dark host theme, before the fix:

  | catalog colour | rendered background | text | contrast |
  |---|---|---|---|
  | `color-mix(in srgb, currentcolor 50%, white)` | `color(srgb 1 1 1)` | `#ffffff` | **1.00** |
  | `rgb(from currentcolor r g b)` | `color(srgb 1 1 1)` | `#ffffff` | **1.00** |

  That is the bug this task was filed for, reached by nesting rather than by
  the bare keyword. Now matched as an ident token anywhere in the value; both
  render `DEFAULT_COLOR` at 4.83. The test fake modelled these as canvas
  *rejections*, which is not what Chrome does — it now models the measured
  acceptance, and the new test fails against the previous bundle.
  (commit `674c2a4`)

## Action required by author

- **BLOCKER — a CSS system colour in the catalog renders illegibly on a dark
  host theme, and this branch made two cases worse than before it.** The probe
  canvas is detached, so it resolves system colours in the light scheme
  always; the chip resolves them against its own `color-scheme`. The contrast
  pass then measures the light-scheme colour and pairs text with the
  dark-scheme one. Measured in headless Chromium under `color-scheme: dark`:

  | catalog colour | before this branch | after this branch |
  |---|---|---|
  | `Canvas` | 18.73 | **1.06** — dark text on a dark chip |
  | `Field` | 11.20 | **1.58** |
  | `ButtonFace` | 5.33 | 3.33 (still passes) |
  | `CanvasText` | 1.00 | 1.00 (already broken, unchanged) |

  Hard-coded white text happened to be right for these; a contrast pass fed
  the wrong background is worse than no contrast pass. Same reachability as
  every other case this branch handles — an imported, legacy, or
  hand-written catalog, never the plugin's own picker (Chrome accepts 42
  system-colour keywords; 33 of them change with `color-scheme`).

  Left unfixed because the three candidate fixes are real trade-offs and the
  choice is yours:

  1. **Return the canvas-resolved `rgb(...)` as the background** instead of
     passing the authored value through. The rendered colour then *is* the
     measured one, by construction, for every value — no keyword list, and it
     closes system colours, nested `currentcolor` and anything else
     context-dependent at once. Cost: a wide-gamut colour
     (`color(display-p3 ...)`, `oklch(...)` outside sRGB) is clamped to sRGB
     on a wide-gamut display, partly undoing round-1 QA's F2 intent — and I
     have no wide-gamut display to verify that on. **Recommended.**
  2. **Refuse system-colour keywords by name**, like `currentcolor`. Cheap and
     surgical, but the list is browser-specific (Chrome's 42 differ from
     Firefox's and Safari's) and is exactly the denylist the plan rejected.
  3. **Accept it** and note the limitation. Defensible — the values are
     out-of-band only — but `Canvas` and `Field` are strictly worse than
     before this branch, so a reader who hits it sees a regression.

  Rig: `/tmp/rig/dark.html` (renders each value under `color-scheme: light`
  and `dark`, resolves the computed background through a canvas so modern
  colour functions measure, and prints the real ratio). Not committed,
  matching the earlier QA rigs.


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
- **A translucent tag colour now renders gray.** Any catalog colour with
  `0 < alpha < 1` falls back to `DEFAULT_COLOR` rather than rendering
  semi-transparent (see the alpha entry above). This cannot arise from the
  plugin's own picker, which only writes opaque hex, but an imported or
  hand-written catalog holding e.g. `rgba(59,130,246,0.9)` will show gray
  chips for that tag instead of a slightly transparent blue. Worth a line in
  the PR description alongside the palette flip. Recorded in `CHANGELOG.md`
  under `0.5.5`.
