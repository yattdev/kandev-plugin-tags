# Tags

## Demo

[Screencast from 2026-08-10 20-27-55.webm](https://github.com/user-attachments/assets/48e20153-c77d-4816-83a2-d9a9fa7c37a3)

Add one or more colored tags to any kanban card. New tags are a shared
workspace catalog: people and agents see the same definitions and task chips.
Humans can manage every shared tag; agents can manage only agent-created tags.

## Shared tags and agent tools

The shared catalog has no fixed status vocabulary. A person creates, renames,
recolors, applies, and deletes any tag from the existing picker and Tags box.
An agent on a kanban task receives `create_tag`, `update_tag`, `delete_tag`,
`add_tag`, `remove_tag`, and `list_tags` MCP tools. Agents may create and
manage any tag whose origin is `agent`, including one made by a different
agent; they cannot modify a human-created definition. Agent `add_tag` takes a
`tag_id` from `list_tags` or `create_tag` and may include a note up to 200
characters. `add_tag`, `remove_tag`, and `list_tags` also accept an optional
`task_id`, so an agent organising a board — a coordinator, say — can tag cards
other than its own.

When an agent creates or applies a tag, its chip is workspace-shared and shows
the same yellow robot glyph used for autopilot tasks, as well as a dashed
border and an accessible “applied by agent” label. An agent-created definition
keeps that marker even when a person later applies it; a person can remove any
chip entirely. The UI refreshes shared tags on focus and at most every 30
seconds.

Tags created before 0.8.0 in private browser storage are preserved and still
render for their owner. They cannot be safely auto-migrated or shared because
the host intentionally does not expose another user's private storage to the
plugin backend; create a shared tag when you want agents and teammates to use
it.

### Agent MCP workflow

The tools are exposed only while an agent is running on a kanban task. Kandev
binds the invocation to that task and workspace. The workspace is never an
argument and the agent must never invent one; the task defaults to the calling
agent's own card, which the three task-scoped tools let you override.

| Tool | Purpose | Required input |
| --- | --- | --- |
| `create_tag` | Create an agent-owned shared definition. | `name`; optional hex `color` |
| `list_tags` | Read the shared catalog and a task's applications. | none; optional `task_id` |
| `update_tag` | Rename and/or recolor an agent-owned definition. | `tag_id`, plus `name` and/or `color` |
| `add_tag` | Apply an agent-owned tag to a task. | `tag_id`; optional `task_id`, `note` |
| `remove_tag` | Remove the agent application from a task. | `tag_id`; optional `task_id` |
| `delete_tag` | Delete an agent-owned definition and every application of it. | `tag_id` |

#### Targeting another task

`add_tag`, `remove_tag`, and `list_tags` act on the calling agent's own task
unless you pass `task_id`. Omit it and behaviour is exactly as before.

`create_tag`, `update_tag`, and `delete_tag` take no `task_id`: they act on the
workspace-wide catalog rather than on any one card's applications, and
`delete_tag` already cascades across every task.

A `task_id` can only ever name a task in the **same workspace** — tags are
stored in one document per workspace and the target is a key inside it, so an
id belonging to another workspace is unreachable by construction rather than by
a check. The plugin does not verify that the id names a real task; it has no
platform client to ask. A mistyped id therefore creates an entry that renders on
no card and occupies one of the workspace document's 200 task slots. Once all
200 slots are occupied, `add_tag` rejects a target not already in the document
without changing any stored applications. Existing self and cross-card targets
remain writable at capacity; `list_tags` and `remove_tag` also continue to work,
and removing a task's last application or deleting a tag can free a slot.
Consequently, repeated invented ids cannot evict another card's agent- or
human-applied tags. Read the id from the board rather than guessing it.

`create_tag` and `list_tags` return `structuredContent.catalog`; copy the
returned tag `id` into later calls. `add_tag` updates the existing agent
application rather than duplicating it, and truncates notes to 200 characters.
`remove_tag` is safe to retry, and removes only *this* agent's application: a
person's application of the same tag on that task survives. `delete_tag` is
intentionally destructive: it removes the definition from all workspace tasks,
so prefer `remove_tag` when a task has merely become unblocked or complete.

Example instruction to give an agent:

```text
Use the Tags plugin MCP tools for this task.

1. Call create_tag with {"name":"Waiting on design","color":"#f59e0b"}.
2. Copy the returned catalog entry's id.
3. Call add_tag with that tag_id and note "Need final empty-state copy".
4. Call list_tags and confirm the tag is applied to this task.
5. When the copy arrives, call update_tag with the same tag_id, name
   "Ready for implementation", and color "#2563eb".

Leave the tag applied so a person can see the robot-marked chip. Do not delete
the definition unless it is no longer useful anywhere in the workspace.
```

For cleanup after a task-specific tag is no longer needed:

```text
Call remove_tag with the tag_id, then call list_tags to confirm it is gone from
this task. Call delete_tag only if the agent-created definition should also be
removed from every other task in this workspace.
```

To label a card other than the one the agent is running on:

```text
Call add_tag with the tag_id, the target card's task_id, and a short note
saying why. Call list_tags with the same task_id to confirm the chip landed on
that card. The target must be a task in this workspace.
```

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
  (`host.taskFilters`/`host.storage.listByKey`), the box instead includes a
  labeled single-select: **All tags**, one colored option per catalog tag, or
  **Untagged**. Choosing a tag filters the board to that one tag; All tags
  clears the selection. The same dropdown is where you recolor (click the
  swatch to open a picker box with the color palette, a custom hex input,
  and a live preview -- nothing is written until you press **Update**;
  **Cancel** discards your pick), rename (click a pill), or delete a tag --
  delete asks for confirmation stating the exact number of cards carrying
  the tag, and removes it from both the catalog and every one of those
  cards. On an older host without `host.taskFilters`/`host.storage.listByKey`,
  the single-select is omitted and, if the host at least ships
  `registerTaskFilter`, the board's existing built-in filter dropdown keeps
  its own "Tags" section/Untagged option instead, so filtering is never
  lost, only relocated depending on what the host supports -- creating,
  recoloring, renaming, and deleting stay available here regardless of tier.
- **Task list Sort and Group**: on hosts that expose
  `registerTaskListFacet`, this plugin contributes **Tag** to `/tasks` Sort
  and Group. Sorting uses the alphabetically first resolved tag name
  (case-insensitive), keeps untagged tasks last, and preserves the incoming
  order for ties. Grouping creates a colored section for every tag and an
  Untagged section; multi-tag tasks appear in each matching section. This is
  deliberately page-local: it operates on the task rows already loaded by
  `/tasks`, not across backend pages.
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

Tags is a per-card annotation tool. It does not read a conversation or analyze
work. Its shared catalog and task applications live in workspace plugin state,
and are exposed to the browser only through declared, host-authorized plugin
actions. A tag definition records an `agent` or `human` origin; a task
application separately records human and agent presence so agents never erase
human state.

For backwards compatibility only, the UI still reads an owner's pre-0.8.0
private `host.storage` catalog and task ids, and renders those chips beside the
shared layer. New interactions use the shared actions whenever the host
supports them.

It stores nothing else: no conversation content, no token data. On a host
that supports `host.storage.listByKey`, the plugin also issues a read-only
cross-scope scan (every task's `tags` entry, capped, ordered by task id) to
know exactly how many cards carry a tag before deleting it, to strip a
deleted tag from every one of those cards, and to keep the board filter
correct even for cards that haven't scrolled into view yet -- on an older
host without that API this all degrades gracefully (no count, no cascade,
filter only reasons about cards whose chips have actually rendered).
Shared tags are visible to everyone who can access the workspace. The host
authorizes every browser action against the signed-in person and constrains
each agent invocation to its running task/session. Task-scoped agent tools may
accept another task id, but no workspace id is accepted in agent-tool input.

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
