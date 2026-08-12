# Changelog

## [0.5.3] - 2026-08-12

(0.5.2 was installed on a test host during review and then withdrawn, so
that number is spent -- the installer refuses to reuse a version.)

### Fixed

- A task-filter option's colour goes through the same `renderableColor`
  guard the chips use, so a stored colour the browser cannot parse leaves
  its filter swatch grey rather than blank. (Only reachable on a host that
  supports `registerTaskFilter`.)

## [0.5.1] - 2026-08-12

### Fixed

- A tag whose stored colour is not something the browser can render no
  longer produces an unreadable chip. `sanitizeCatalog` accepts any string
  as a colour while `normalizeColor` only guards the write path, so a value
  that never went through this plugin's UI reached the DOM unvalidated; the
  browser then dropped the declaration entirely, leaving a transparent
  background behind the chip's hard-coded white text. Such values now fall
  back to `DEFAULT_COLOR` at every chip surface and at the Tags box swatch.
  Hex is passed straight through, and a named or functional colour --
  `"red"`, `"rgb(1 2 3)"` -- is checked with `CSS.supports` rather than
  rejected, so catalogs holding one keep rendering it.

## [0.5.0] - 2026-08-12

### Changed

- **Tag names are now capped at 22 characters (was 32), and the Tags box is
  380px wide (was 320px).** These two are one budget: the Create input gets
  whatever the fixed-width box has left after its padding and the Create
  button. At 320px that was 222px of input, but a 32-character name needs
  ~253px for ordinary lowercase and ~373px for the widest glyphs -- so the
  input scrolled horizontally for most full-length names, which is the bug
  this was meant to fix. No box width makes "32 characters, never scrolls"
  true at a sensible size; 22 characters in 282px of input does. A tag whose
  stored name is already longer than 22 characters still renders in full --
  only creating or renaming past the cap is refused.
- The box's width is now an inline style rather than a `w-[320px]` class.
  Tailwind only emits an arbitrary-value utility for literals it finds in
  source it scans, and the host does not scan this bundle -- the old class
  resolved only because unrelated host components happened to use the same
  literal, which is not a dependency this plugin should have.

## [0.4.1] - 2026-08-11

### Fixed

- The shared data layer's coalescing no longer drops an invalidation. A
  change notification arriving while a `host.storage.get` is already in
  flight describes a write that `get` cannot see, so joining it left the
  store serving pre-write data until some later unrelated change. The
  request now marks the store dirty and re-issues the fetch on settle, so
  the last write wins.
- A re-entrant `initialize()` -- the host re-runs it without a matching
  `destroy()` on a boot race, an HMR re-boot, or a fresh store instance --
  now resets the shared stores alongside the drain that tore down their
  subscriptions. Previously the one-shot subscribe guards stayed set and
  `loaded` stayed true, so nothing resubscribed and nothing refetched, and
  every chip surface served a dead cache for the life of the page.

## [0.4.0] - 2026-08-11

### Added

- Tags now also render on the sidebar task row and the `/tasks` list row
  (a new `task-row-tags` slot), as a dense chip row capped at 3 visible
  chips plus a "+N" indicator, with no per-chip remove control -- removing
  a tag stays confined to the "Add tag..." modal on that surface. The
  existing kanban card chip row (`task-card-tags`) is unchanged.
- A shared data layer: the tag catalog and each task's applied-tag-id list
  are now cached in one module-level store apiece (one coalesced in-flight
  `host.storage.get`, one `host.storage.subscribe`), so N chip
  rows/dropdowns mounted at once for the same workspace/task issue exactly
  one read and one subscription between them, instead of one each.
- A stored tag id that looks like a generated catalog id (see `makeTagId`)
  but is no longer in the catalog -- an orphaned tag left behind by a
  deletion -- now renders no chip at all, on every chip surface, instead of
  a chip labeled with the raw id. A legacy v1 plain-string tag name still
  renders exactly as before.

### Changed

- The Tags box (the top-bar dropdown) is redesigned:
  - its trigger is now `size: "icon-lg"` (previously smaller);
  - the dropdown itself is 320px wide (previously 260px), wide enough that
    a full 32-character tag name fits the Create input with no horizontal
    scroll;
  - each tag row is a `20px 1fr 24px` CSS grid (`20px 16px 1fr 24px` with a
    Tier-2 filter checkbox column), so the delete button's x-offset is
    identical on every row regardless of the tag name's length -- fixing
    the "delete button doesn't line up" bug;
  - the color swatch is now a button that opens a picker box beneath that
    row: the color palette and a native hex input feed a single pending
    color (no storage write), with a live preview pill and explicit
    **Update**/**Cancel** buttons -- fixing the "color doesn't apply until
    blur, with no way to preview or discard it first" bug. Only one row's
    picker may be open at a time.

## [0.3.0] - 2026-08-10

### Changed

- fix: restore the top-bar dropdown's Create input (AC2) (fb35c9e)
- fix: restore tag recoloring and the 12-tag cap message (342ed9b)
- fix: creating a tag always failed, and rebuild the tag UX (40bb3a0)
- Revert "fix: document and preflight-check the Kandev SDK sibling checkout" (8d9a6c5)
- Revert "fix: make local SDK setup self-contained" (6ad14ce)
- fix: make local SDK setup self-contained (5b5c945)
- fix: document and preflight-check the Kandev SDK sibling checkout (8a871c8)
- fix: make local SDK setup self-contained (3a3c065)
- fix: document and preflight-check the Kandev SDK sibling checkout (46444b9)
- fix: read active workspace from state.workspaces.activeId (be99296)
- fix: refresh own-write local state and track workspace reactively (e3cceb2)
- feat: switch add-tag menu action to the host's flat primary group (b0fc9ef)
- feat: redesign tag data model with a colored catalog, picker/manager modals (12ac076)
- fix: drop non-string entries from stored tags before rendering (f69f8f3)
- test: cover chip remove button stopPropagation regression (9abb61b)


## [0.2.0] - 2026-08-09

### Fixed

- fix: creating a tag from the picker's Add button or Manage Tags' Create
  always failed with "Could not create tag. Please try again." Root causes:
  a failing catalog load rendered as an empty catalog instead of an error
  (masking the real HTTP status), no guard against an empty/blank active
  workspace id (the actual trigger on the Home/all-workspaces board, which
  the backend rejects as an invalid scopeId), and a post-create lookup by
  the untrimmed input name (`addCatalogTag` stores the trimmed name, so
  `" urgent "` created the tag but then failed to find it). All three are
  fixed; every `host.storage` failure now logs
  `[kandev-plugin-tags] <operation>` plus the underlying error to the
  console with the real HTTP status, and the UI message includes it too.
- fix: a disable/re-enable cycle leaked one more `host.store`/`host.storage`
  listener every time (the plugin never implemented `destroy()`), each
  still polling storage after the plugin was disabled. `destroy()` is now
  implemented and `initialize()` is idempotent.
- fix: `taskTagCache` (the board filter's cross-card index) never evicted
  and was never keyed by workspace, so a tag set from one workspace could
  inform another's filter. Cleared on plugin unload and on workspace
  switch.

### Added

- The `Add tag...` kanban menu item now has a tag icon, sized and stroked to
  match its neighbours (`Move to`/`Archive`/`Delete`).
- The top-bar "Tags" button is now a filter-icon dropdown that combines
  filtering and management in one place: its own **Create** input, a color
  swatch, inline rename, and delete with an exact "used by N cards" count
  and cascade removal from every affected card -- plus, on a host that
  supports `host.taskFilters` and `host.storage.listByKey`, a checkbox per
  row for filtering. On a host with only `registerTaskFilter`, the
  checkboxes are omitted and the board's built-in filter dropdown keeps its
  own "Tags" section as before; on an even older host, there's no filtering
  at all. Create/recolor/rename/delete are available in this dropdown
  regardless of tier.
- The add-tags picker modal is rebuilt on `host.ui` primitives (Input,
  Button, ScrollArea), opens at `size: "md"`, and lets you click any row in
  the scrollable tag list to apply/remove it (a checkmark marks applied
  tags) instead of a separate checkbox.
- Deleting a tag now strips it from every card that carried it, instead of
  leaving orphaned raw-id chips.

### Changed

- The separate "Manage tags" modal is retired; renaming, recoloring, and
  deleting a tag now happen inline in the top-bar dropdown.
- Renaming to a name that already exists, or applying a 13th tag, now shows
  a specific error message instead of silently reverting or no-opping.
- The color-picker swatch now commits on blur instead of on every drag
  event; the hex text field debounces its writes.

## [0.1.2] - 2026-08-06

### Changed

- fix: style tag chips and stop remove-button clicks from opening the task (33ec845)


## [0.1.1] - 2026-08-06

### Changed

- feat: initial Tags plugin implementation (bb0c970)


## [0.1.0] - 2026-08-06

### Added

- Initial release: add, remove, and display per-user tags on kanban cards
  via the `task-card-tags` slot and an `Edit > Add tag...` kanban menu
  action.
