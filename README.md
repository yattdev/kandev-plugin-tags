# Tags

Add one or more colored tags to any kanban card. Tags are yours alone: each
user's tags and tag catalog are private and never shown to teammates.

- **On every card**: tags you've added render as a row of small colored
  chips below the card's other badges. No tags, no row -- the row only
  appears once you've added at least one.
- **Add/pick a tag**: open a card's context/dropdown menu, choose **Add
  tag...** (a flat, top-level item between "Move to" and "Link"). A modal
  shows a large search/create input (typing a name that doesn't exist yet
  enables **Add**, which creates it in your tag catalog and applies it to
  the card) plus a scrollable, multi-select list of your existing colored
  tags -- check/uncheck to apply/remove them from this card.
- **Manage your tags**: a **Tags** button in the app's top bar opens a
  management modal listing your whole tag catalog, where you can create,
  rename, recolor (hex input or a native color-picker swatch), and delete
  tags. Deleting a tag from the catalog un-applies it everywhere (it simply
  stops resolving, so it no longer renders).
- **Remove a tag from a card**: click the `x` on a chip on the card itself,
  or uncheck it in the Add tag modal.
- **Filter the board by tags**: a **Tags** section in the board's existing
  filter dropdown supports multi-select plus an **Untagged** option
  (requires a host that ships `registerTaskFilter`, e.g. kdlbs/kandev
  main after PR #2351; this plugin feature-detects the hook and silently
  no-ops on older hosts).
- Tag names are trimmed, capped at 32 characters, deduplicated
  case-insensitively within your catalog; each card is capped at 12 applied
  tags.

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

It stores nothing else: no conversation content, no token data, no
cross-card index (there is no bulk/board-wide read -- the board filter, once
available, only reasons about cards whose chips have actually rendered in
this session). Because storage is per-user, two people looking at the same
card, or the same workspace's tag catalog, each see only their own; adding,
removing, or even the presence of any tags is invisible to teammates.

Cards tagged before this release (a plain array of tag-name strings, no
catalog) keep working: an id that isn't found in the catalog is rendered
using the id itself as the tag's name, with a neutral default color -- no
migration write is performed, so v1 and v2 tags can coexist on a card.

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
