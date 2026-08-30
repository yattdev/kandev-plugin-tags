# Changelog

## [0.14.0] - 2026-08-30

### Changed

- docs: clarify orphan tag eviction guarantee (6b3f28c)
- qa: protect human-applied tags from eviction by an invented task_id (1e9a58c)
- feat: let agent tag tools target another task (b755410)

### Added

- Agent `add_tag`, `remove_tag`, and `list_tags` MCP tools now accept an
  optional `task_id`, letting an agent tag a card other than its own — the
  case a coordinator organising a board needs. Omitting `task_id` behaves
  exactly as before, acting on the calling agent's own task.

### Changed

- `create_tag`, `update_tag`, and `delete_tag` deliberately take no `task_id`:
  they act on the workspace-wide catalog, not on one card's applications.
- Tool descriptions no longer claim the task-scoped tools only act on "the
  current task".

### Fixed

- Agent `add_tag` now rejects creation of a new task key when the workspace tag
  document already tracks 200 tasks. Existing self and cross-card keys remain
  writable, and removing a task's last application frees capacity. This keeps
  200+ invented `task_id` calls from evicting another card's agent-applied tags
  without adding a platform task-existence lookup.
- Task-tag eviction now discards entries no human has curated before ones a
  person applied, and breaks ties on task id instead of Go's randomized map
  order. Because an agent may name any `task_id`, the previous oldest-first
  rule let a mistyped target -- stamped with the current time, so always the
  newest entry -- survive at the cap while a real card's human-applied tags
  were silently dropped.

Targeting stays inside the caller's workspace: tags live in one document per
workspace and a `task_id` is a key within it, so another workspace's tasks
remain unreachable. Agent-ownership semantics are unchanged — `remove_tag`
still removes only this agent's application and leaves a human's intact.


## [0.13.0] - 2026-08-28

### Changed

- docs: add QA screenshots for tag filter fix (5bdfc4e)
- fix: clear stale tag filter selections (8563918)


## [0.12.0] - 2026-08-24

### Changed

- fix: allow release-time manifest version (78808d2)
- qa: cover the Tier 0/1 host that ships today (9ac3e9b)


## [0.11.0] - 2026-08-22

### Changed

- review: notes for PR/MR description (72355d8)
- review: make the task-list tag facet react to shared tag changes (ce103e7)
- feat: add single-select tag filtering and task-list facet (be6c532)


## [0.10.0] - 2026-08-22

### Added

- Replaced the top-bar tag checkbox filter with a labeled single-select for
  **All tags**, one colored tag, or **Untagged**.
- On hosts with the new task-list facet API, added page-local `/tasks` Tag
  sorting and multi-membership colored grouping while preserving the older
  host compatibility tiers. The facet resolves tags from the shared
  workspace catalog (falling back to the legacy private catalog on older
  hosts), matching the board filter's data source.

## [0.9.0] - 2026-08-22

### Changed

- docs: explain agent tag MCP workflow (17cea09)
- feat: share editable tags with agents (a2fcc97)
- qa: keep tags dropdown above mobile actions (0c120b3)
- fix: align tags with task row metadata slot (0e8793e)
- fix: tidy go module dependencies (b6175d4)
- test: cover truncated agent tag action projection (8b5891e)
- fix: allow agent tag note truncation (247dd38)
- qa: fix agent tag action loading (bff6604)
- feat: add shared agent status tags (afee8c6)


## [0.8.3] - 2026-08-22

### Changed

- Replace the fixed agent-status vocabulary with a shared, editable workspace
  tag catalog. Humans manage all shared tags; agents can create, update,
  delete, and apply agent-origin tags only.
- Mark agent-applied chips with the existing autopilot robot glyph, a dashed
  border, and accessible provenance instead of relying on colour alone.
- Preserve and continue rendering pre-0.8.0 private browser tags as a legacy
  compatibility layer; they are not silently migrated across users.

## [0.7.0] - 2026-08-19

### Added

- Shared agent status tags for kanban tasks. Agents can add, remove, and list
  fixed status tags, which render as distinguishable dashed chips in the UI.

## [0.6.2] - 2026-08-20

### Fixed

- Keep the Tags dropdown above mobile fixed actions so the Tasks page floating
  add button cannot cover the tag row controls when the dropdown is constrained
  near the viewport bottom.

## [0.6.1] - 2026-08-20

### Fixed

- Register the dense sidebar and `/tasks` chip row in the host's generalized
  `task-row-metadata` slot. The prior `task-row-tags` slot name is no longer
  mounted by current hosts, so otherwise the Tags plugin rendered only on
  kanban cards.

## [0.6.0] - 2026-08-18

### Changed

- fix: close plugin packaging Makefile calls (f8def7a)
- fix: run plugin-pack from the SDK module (cd0a912)
- fix: add missing packaging checksum (0361329)
- review: render the colour that was measured, not the one the catalog held (be8a4fa)
- review: notes for PR/MR description (b832329)
- review: refuse currentcolor nested inside a colour function (674c2a4)
- qa: lock the opacity cutoff to the alpha byte (ac1dafe)
- review: notes for PR/MR description (3716960)
- review: state the width budget's fallback-font margin honestly (2febfe0)
- review: notes for PR/MR description (090b9ea)
- review: reject any non-opaque chip background, not just alpha zero (dbbf067)
- review: renumber to 0.5.5, the base branch took 0.5.4 (dfa111e)
- qa: close currentcolor for real, and stop greying out modern colours (6106a57)
- qa: correct the glyph calibration in the PR notes (bcf43f4)
- qa: calibrate the width budget against a measured worst-case glyph (3aa9ba6)
- review: notes for PR/MR description (60c1a39)
- review: stop the canvas probe rejecting a colour that matches its sentinel (d2bd0a9)
- fix: derive tag chip text colour from the background instead of white (83602f2)
- review: notes for PR/MR description (85a76e6)
- review: close the width-budget guard and the last unguarded colour (8d092d7)
- qa: never render a chip in a colour the browser cannot parse (f082f7f)
- fix: size the Tags box to its name limit (22 chars, 380px) (3a4c386)
- release: 0.4.1 (cd65f15)
- fix: never drop a store invalidation, and reset stores on re-initialize (4a9d5fe)
- release: 0.4.0 (5519f6d)
- feat: add task-row-tags slot, shared data layer, and Tags box redesign (03bed70)
- Update README.md to a demo screencast (bdb61c3)


## [0.5.6] - 2026-08-13

### Fixed

- Tag chips no longer hard-code white text: `chipStyle`/`denseChipStyle` now
  pick between white and a dark (`#111827`) token from the resolved
  background's WCAG contrast ratio. Yellow (`#eab308`), green (`#22c55e`),
  and orange (`#f97316`) now use dark text; the other palette colours and
  `DEFAULT_COLOR` retain white text.
- `renderableColor` rejects transparent or partially transparent backgrounds,
  `currentcolor` (including nested uses), and values the browser cannot
  resolve, falling back to the legible default gray.
- Non-hex colours are painted as the RGB value measured by the probe canvas,
  so theme-dependent CSS system colours and the contrast-derived text colour
  cannot resolve in different contexts. Modern colour functions remain
  supported, but are rendered in their measured sRGB form.

## [0.5.5] - 2026-08-12

### Fixed

- Corrected the width budget's own description of itself. The geometry comment
  claimed the regression test sized the budget "for the wider of the two"
  measured glyphs and the 0.5.4 note that the 12px bound "holds for both";
  at the 22-character cap neither is true. 22 x 12.18px = 268px against 264px
  of text area, so the bound sits ~4px *under* the fallback stack's worst case
  rather than covering it, while the app font fits outright at 247px. The
  practical exposure is a 22-character all-wide-glyph name during the
  font-load window only. `MAX_TAG_LENGTH` is unchanged at 22 (the requested
  cap) and the guard still holds 22 and rejects 23. Comment- and
  changelog-only; the version moves because `ui/bundle.js` changed at all and
  0.5.4 was already installed on the QA host.

## [0.5.4] - 2026-08-12

### Fixed

- The Create input's width budget is now calibrated against a measured
  worst-case glyph. The regression test compared a 22-character name to the
  input's *border* box, so the host `Input`'s own 16px padding and 2px
  border counted as room for text -- the budget read 18px roomier than it
  is. Measured in Chrome at the input's 12px font: the self-hosted app font
  (Figtree) is 11.22px at its widest ASCII glyph, the fallback stack
  (Segoe UI / Arial) 12.18px. The test now measures the content box against
  a 12px bound, which holds for both.

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
