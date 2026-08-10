# Changelog

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
