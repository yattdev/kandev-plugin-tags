# Tags

## Demo

[Screencast from 2026-08-10 20-27-55.webm](https://github.com/user-attachments/assets/48e20153-c77d-4816-83a2-d9a9fa7c37a3)

Add one or more colored tags to any kanban card. Tags are yours alone: each
user's tags and tag catalog are private and never shown to teammates.

- **On every card**: tags you've added render as a row of small colored
  chips below the card's other badges. No tags, no row -- the row only
  appears once you've added at least one.
- **On the sidebar row and the `/tasks` list row too**: the same tags
  render there as a smaller, denser chip row, capped at 3 visible chips
  plus a `+N` indicator when a task has more. There's no remove control on
  this row -- removing a tag stays confined to the card chip row or the Add
  tag modal.
- **Add/pick a tag**: open a card's context/dropdown menu, choose **Add
  tag...** (a tag icon, flat top-level item between "Move to" and "Link").
  A medium modal shows a "Select or create a tag..." input (typing a name
  that doesn't exist yet enables **Add**, which creates it in your tag
  catalog and applies it to the card) above a scrollable list of your
  existing colored tags rendered as pills -- click a row to apply/remove it
  from this card; applied tags show a checkmark.
- **Filter and manage from one place**: an icon-lg filter-icon button in
  the app's top bar opens the Tags box, a 380px-wide dropdown listing your
  whole tag catalog as grid-aligned rows (color swatch, name pill, delete
  button in a fixed-width column so it lines up identically regardless of
  the tag's name length), with its own **Create** input above the list
  (independent of the Add tag modal -- creating a tag here works the same
  way: trimmed, deduplicated case-insensitively, a specific error if the
  name already exists). On a host new enough to support it
  (`host.taskFilters`/`host.storage.listByKey`), each row also gets a
  checkbox, and checking one filters the board to cards carrying that tag
  (multi-select is OR). The same dropdown is where you recolor (click the
  swatch to open a picker box with the color palette, a custom hex input,
  and a live preview -- nothing is written until you press **Update**;
  **Cancel** discards your pick), rename (click a pill), or delete a tag --
  delete asks for confirmation stating the exact number of cards carrying
  the tag, and removes it from both the catalog and every one of those
  cards. On an older host without `host.taskFilters`/`host.storage.listByKey`,
  the checkboxes are omitted and, if the host at least ships
  `registerTaskFilter`, the board's existing built-in filter dropdown keeps
  its own "Tags" section/Untagged option instead, so filtering is never
  lost, only relocated depending on what the host supports -- creating,
  recoloring, renaming, and deleting stay available here regardless of tier.
- **Remove a tag from a card**: click the `x` on a chip on the card itself,
  or click it off in the Add tag modal.
- Tag names are trimmed, capped at 22 characters, deduplicated
  case-insensitively within your catalog; each card is capped at 12 applied
  tags. Deleting a tag leaves any card that still carried it (a rare race
  with the cascade removal above) showing no chip for it at all, rather
  than a chip labeled with the raw id.

## Install

Building requires a local checkout of the Kandev SDK first -- run `make
setup` once (see **Development > Setup / Prerequisites** below), then build
a package (`make package-host` for your platform, `make package` for all
platforms) and install the tarball via **Settings > Plugins > Install** or
`POST /api/plugins/install`.

## How it works and what it reads

Tags is a per-card, per-user annotation tool. It does not call an agent,
read a conversation, or analyze work.

The plugin keeps two things in kandev Host per-user state (`host.storage`):

- a **tag catalog** -- one array of `{ id, name, color }` per
  (user, workspace) pair, scope `workspace`, key `tags-catalog`;
- **applied tag ids** -- one array of catalog tag ids per (user, card) pair,
  scope `task`, key `tags`.

It stores nothing else: no conversation content, no token data. On a host
that supports `host.storage.listByKey`, the plugin also issues a read-only
cross-scope scan (every task's `tags` entry, capped, ordered by task id) to
know exactly how many cards carry a tag before deleting it, to strip a
deleted tag from every one of those cards, and to keep the board filter
correct even for cards that haven't scrolled into view yet -- on an older
host without that API this all degrades gracefully (no count, no cascade,
filter only reasons about cards whose chips have actually rendered).
Because storage is per-user, two people looking at the same card, or the
same workspace's tag catalog, each see only their own; adding, removing, or
even the presence of any tags is invisible to teammates.

Cards tagged before this release (a plain array of tag-name strings, no
catalog) keep working: an id that isn't found in the catalog is rendered
using the id itself as the tag's name, with a neutral default color -- no
migration write is performed, so v1 and v2 tags can coexist on a card. The
one exception is an id shaped like a generated catalog id that isn't found
in the catalog -- an orphaned tag left behind by a deletion -- which renders
no chip at all rather than a chip labeled with the raw id.

Tags does not use, request, or spend LLM tokens, and has no external
service or analytics integration.

## Development

Developed against a local checkout of the kandev monorepo (see the
`replace` directive in `go.mod`). CI and monorepo development use a sibling
checkout named `kandev` next to this repo, e.g.:

```
some-parent-dir/
├── kandev-plugin-tags/   (this repo)
└── kandev/
    └── apps/backend/     (from kdlbs/kandev)
```

### Setup / Prerequisites

Before building, get the Kandev SDK checked out using:

```sh
make setup   # sparse-clones kdlbs/kandev's apps/backend into .build/kandev
```

Makefile targets use `../kandev/apps/backend` automatically when that sibling
checkout already exists. Otherwise `make setup` creates the SDK under this
repo's ignored `.build/kandev/apps/backend` directory and the Makefile
temporarily points Go's local `replace` there while each target runs.

If you prefer the sibling layout, create it manually:

```sh
git clone --filter=blob:none --sparse https://github.com/kdlbs/kandev ../kandev
git -C ../kandev sparse-checkout set apps/backend
```

If your monorepo checkout lives elsewhere, override the path instead of
editing `go.mod`:

```sh
make setup KANDEV_SDK=/path/to/kandev/apps/backend
make package-host KANDEV_SDK=/path/to/kandev/apps/backend
```

`build`, `test`, `vet`, `package`, and `package-host` all check for the SDK
first (`make check-sdk`) and fail fast with an actionable message if it's
missing.

```sh
make test        # Go unit tests + dependency-free UI helper/storage tests
make fmt vet     # gofmt + go vet
make package-host
```

## Automation and releases

Pull requests to `main` run separate verification and packaging workflows.
They check module tidiness, formatting, `go vet`, tests, a host build, and a
cross-platform package build. Pushing a `v*` tag verifies the plugin, builds
the all-platform package, and publishes a GitHub Release with the package
and its `checksums.txt` asset.

## State

A per-(user, workspace) tag catalog (scope `workspace`) plus a small array
of applied tag ids per (user, card) (scope `task`), both in kandev Host
per-user state, so a user's tags participate in kandev backups, survive
plugin upgrades, and are removed on uninstall.
