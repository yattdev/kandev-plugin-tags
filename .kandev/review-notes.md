## Fixed during review

- `ui/bundle.js:2476` (`registerTagTaskListFacet`) — the new task-list Tag facet
  kept its own catalog, fetched with a private
  `invokeAction("shared-tags")` and refreshed only by its own
  `CATALOG_SCOPE`/`TASK_SCOPE` storage subscriptions. On a shared-tags host
  nothing writes that storage (every mutation is an action followed by
  `refreshSharedTags()`), so those subscriptions never fired and the facet froze
  at load time: `/tasks` Group-by-Tag kept the pre-rename header and a newly
  applied tag never left the Untagged section until a full page reload. It now
  reads and listens to the one shared-tag store the rest of the plugin already
  keeps fresh. This also removed the second, independent shared-tags request and
  the second `clearTaskTagCache()` owner, whose interleaving could drop a
  task-tag update the other refresh had just applied. Regression test added
  (`ui/bundle.test.js`, "task-list facet re-projects live when a shared tag is
  renamed or a task-tag action lands"); verified failing before the fix.
  (commit ce103e7)

## Follow-up tasks created (out of scope for this PR)

- Clear tag board filter when its tag is deleted (task
  `0f691fd3-0f86-4706-ac64-ccc5839e3581`) — `ui/bundle.js` `openDeleteConfirm`.
  Deleting the tag currently selected as the board filter leaves a dangling
  value in `host.taskFilters`, so `registerTagFilter.matches()` rejects every
  card and the board renders empty while the Tags Select falls back to its
  "All tags" placeholder. Pre-dates this branch (the checkbox UI it replaced
  behaved the same way, just without the misleading label). Introduced in
  commit `40bb3a0a` by ayattara.
