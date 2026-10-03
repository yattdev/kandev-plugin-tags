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
other than its own. Colors are chosen rather than randomized: a tag created
without one gets a color derived from its name, `create_tag` accepts an explicit
hex color when the agent wants a specific one, and an operator can turn the
derivation off in the plugin's settings (see **Tag colors** below).

When an agent creates or applies a tag, its chip is workspace-shared and shows
the same yellow robot glyph used for autopilot tasks, as well as a dashed
border. Its title and accessible label use “<tag> — <note>” when the application
note contains text, or the tag name when it does not. An agent-created
definition keeps the robot marker even when a person later applies it; a person
can remove any chip entirely. The UI refreshes shared tags on focus and at most
every 30 seconds.

Tags created before 0.8.0 in private browser storage are preserved and still
render for their owner. They cannot be safely auto-migrated or shared because
the host intentionally does not expose another user's private storage to the
plugin backend; create a shared tag when you want agents and teammates to use
it.

If a temporary backend outage interrupts a private tag read, the Tags box shows
an error instead of an empty catalog. The plugin makes a bounded set of
automatic retries, then retries again when the browser regains focus or
connectivity, the view remounts, or the user selects Retry, without rewriting
saved tags.

### Agent MCP workflow

The tools are exposed only while an agent is running on a kanban task. Kandev
binds the invocation to that task and workspace. The workspace is never an
argument and the agent must never invent one; the task defaults to the calling
agent's own card, which the three task-scoped tools let you override.

| Tool | Purpose | Required input |
| --- | --- | --- |
| `create_tag` | Create an agent-owned shared definition. | `name`; optional hex `color` (derived from `name` when omitted, unless the auto-color setting is off) |
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
  tag...** (a tag icon, top-level item between "Move to" and "Link"). A
  medium modal shows a "Select or create a tag..." input (typing a name
  that doesn't exist yet enables **Add**, which creates it in your tag
  catalog and applies it to the card) above a scrollable list of your
  existing colored tags rendered as pills -- click a row to apply/remove it
  from this card; applied tags show a checkmark. A tag created here gets the
  color its name derives -- or the neutral gray, if the auto-color setting is
  off (see **Tag colors** below) -- and either way you can recolor it from its
  swatch in the Tags box.
- **Quick pick**: on a host that renders plugin submenus, **Add tag...** is
  a submenu instead: **More tags...** first (the same modal), then a native
  separator and up to five tags used most recently anywhere in the workspace,
  most recent first; each tag has a dot matching its color. The separator
  requires the host's `separatorBefore` submenu-child support; older hosts keep
  the same actions without the divider.
  Choosing one applies it to this card in a single click and refreshes the
  chips, so the tag you reach for constantly is one click from the card menu
  and from the sidebar/`/tasks` row menu, wherever that item appears. Tags
  the card already carries are left out -- the list only ever adds what you
  picked, and removing a tag stays on the card's chips and in the modal.
  Recency is workspace-wide (an agent's application counts too) and comes
  from the application timestamps the shared read already returns; the plugin
  stores no extra history, and the menu build itself never fetches -- it reads
  the catalog the chips, the filter and the periodic refresh keep warm. When
  there is nothing recent to offer -- a workspace nothing has been applied in
  yet, a catalog that has not loaded, or a card already carrying every recent
  tag -- **Add tag...** stays a plain item that opens the modal, instead of
  nesting the same modal one level deeper behind an extra click. On a host
  predating plugin submenus the item stays flat and opens the modal, exactly
  as before, and the manifest states that boundary: `min_kandev_version:
  "0.96.0"` is the first release carrying the API, so a release host older
  than that declines to install the package instead of shipping a menu that
  cannot render the list (a dev/nightly host has no release boundary, skips
  the check, and keeps the flat item).
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
  case-insensitively within your catalog. The 12-applied-tags cap covers the
  plugin's own private per-card list (the pre-0.8 layer, and what an older
  host stores): the shared catalog layer has no per-card cap, so on a shared
  host neither the Add tag modal nor the quick pick refuses a 13th tag.
  Deleting a tag leaves any card that still carried it (a rare race with the
  cascade removal above) showing no chip for it at all, rather than a chip
  labeled with the raw id.

### Tag colors

A new tag's color comes from one of two places, and never from randomness or
catalog position:

- **Derived from the name** (the default). A tag created without an explicit
  color -- typed into either Create input, or created by an agent via
  `create_tag` with no `color` -- gets the color its name hashes to, the way
  Proxmox tag colors and GitHub label colors work: FNV-1a over the name's
  UTF-8 bytes picks one of fourteen curated, nuanced hues inspired by Proxmox's
  richer labeling palette. A given name always *starts* from the same color in
  every workspace and whoever creates it; it no longer depends on which other
  tags happen to exist (0.14.x assigned colors by catalog position, so creating
  or deleting one tag could recolor a different one). The color is stored when
  the tag is created; renaming a tag keeps it, exactly as with an explicit
  color -- it is never re-derived afterward, which could silently restyle a tag
  somebody may already recognize by its color.
- **Chosen by the person or agent**, by passing an explicit hex `color` or by
  recoloring the tag afterwards from its swatch in the Tags box (the palette or
  a custom hex, with a live preview; nothing is written until **Update**). An
  explicit color is normalized to lowercase hex (the backend also expands the
  3-digit form to six digits) and then kept as given: it is never re-derived,
  not by a rename and not by the setting below.

The derivation is controlled by one setting, **Settings > Plugins > Tags >
Generate a color for new tags** (declared as `auto_color` in the manifest,
default **on**):

- **On** (default, and what happens when the setting has never been saved): new
  tags derive their color from their name as described above.
- **Off**: a new tag with no explicit color starts in the neutral gray, and its
  color is picked afterward in the Tags box. Agents' `create_tag` follows the
  same rule; an agent that wants a color passes one.
- The setting never touches tags that already exist, and never overrides an
  explicit color, so flipping it cannot restyle an existing board.

Three things are worth knowing:

- Two names can hash to the same color -- fourteen colors cannot keep a large
  catalog distinct. That is expected: the chip always shows the name, and the
  picker is there when the color is meant to carry meaning.
- The setting is fail-open: if it cannot be read at all (a host error, or a
  value that is not a boolean), the plugin derives the color, i.e. it behaves as
  the documented default rather than refusing to create the tag.
- The setting lives in the plugin's backend, which is what assigns colors when
  a tag is created. On a host old enough to predate plugin actions, the UI
  falls back to private browser storage and derives colors itself, where the
  setting cannot reach it -- such a host always derives.

Tags carried over from the 0.7.x agent status document (workspace state, which
is what 0.7 actually wrote -- a person's pre-0.8 private tags are never migrated,
as the compatibility note above says) keep the neutral gray they have always
rendered as; the upgrade does not restyle an existing board.

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
filter only reasons about cards whose chips have actually rendered). A scan
the host had to cap degrades the same way rather than pretending: the
confirmation says it cannot state a count, and a cascade that could not see
every card says so instead of reporting a clean sweep.
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

Its one operator setting (`auto_color`, see **Tag colors**) lives in the
plugin's own configuration on the kandev side, read by the plugin through
`Host.GetConfig`; it is not stored in the workspace document and is not part
of a user's private tag storage.

## Version changes and data safety

Update or roll back by installing the other package over the existing
`kandev-plugin-tags` installation. Kandev's in-place version-change path
replaces the plugin process and package while retaining both its workspace
state and its per-user compatibility state. The plugin keeps the same
`agent-tags` workspace document across those process replacements, so
shared tag definitions, task applications, colors, ownership, agent notes,
and human/agent provenance remain intact. The operator's `auto_color` setting
lives in the plugin's kandev-side configuration rather than in that document,
and survives an in-place version change the same way; only an explicit
uninstall removes it.

Compatible shared-catalog releases (0.9.0 and newer) can read the same
document in either direction. A pre-0.9 release cannot display tags created
in the newer shared catalog, but it does not migrate or erase that catalog;
installing a compatible release again makes those tags visible. Pre-0.9
private browser tags continue to use the legacy read-only layer described
above.

Do not uninstall as part of an update or rollback: explicit uninstall is the
destructive lifecycle action and intentionally removes plugin state. During
an in-place replacement the UI may briefly show a loading error while the new
process starts; it keeps shared state authoritative and retries the read
instead of treating the catalog as empty.

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

### Host support: the menu submenu (merged upstream)

The card menu's quick pick needs a host that renders plugin submenus
(`TaskMenuActionRegistration.items`, see `docs/plans/plugins/PLUGIN-API.md`
in the monorepo). That host API is **merged in kandev main**: kdlbs/kandev PR
[#3874](https://github.com/kdlbs/kandev/pull/3874) ("feat(plugins): render a
task menu action as a submenu") landed on 2026-09-23 as merge commit
`f8708da1e0c6261d98229ca2cf1901eee9bfdf2a`, so a host built from that commit
or a later release renders the quick pick.

A host older than that keeps the flat behaviour, by design: **Add tag...**
stays the item it has always been and opens the picker modal.

The package states the boundary in its manifest: `min_kandev_version:
"0.96.0"` is the first *release* containing the API -- the merge commit is an
ancestor of `v0.96.0` and not of `v0.95.1`. Kandev enforces that on install for
release builds only (`requires kandev >= 0.96.0, running v0.95.1`); a `dev` or
nightly build carries no release boundary and skips the check, which is where
the flat fallback above is still reachable -- a host that has the API always
renders the list, so the fallback is a safety net, not the supported path.

`contrib/kandev-plugin-submenus.patch` is the reference implementation those
twenty-three commits were reviewed into, kept for the reasoning behind each
step rather than as a prerequisite. One piece of it is not in the merged
version: `isPluginIconComponent` there accepts a component by its `$$typeof`
tag alone, so an object forged to carry `react.memo`/`react.forward_ref` -- or
a `forward_ref` whose `render` is a class -- reaches `createElement` and
throws during a render, where the patch validates the payload and refuses
classes. That only concerns a *malformed* registration; this plugin's are
well-formed, so it is unaffected either way.

<details>
<summary>Reference patch commits</summary>

1. `feat(plugins): render a task menu action as a submenu` -- the
   `TaskMenuActionRegistration.items` contract, its menu-entry builder, the
   API doc, and its tests.
2. `fix(plugins): keep element-form plugin menu icons` -- menu entries
   render a ready-made element icon as-is instead of replacing it with the
   fallback puzzle glyph, which is the shape this plugin's tag icon uses.
3. `fix(plugins): keep a plugin submenu reachable in command lists` -- the
   command palette and the sidebar's task commands flatten a submenu's item
   children instead of dropping the action.
4. `fix(plugins): validate submenu children at the host boundary` -- a
   malformed or async `items()` result degrades to the flat item instead of
   breaking the card render.
5. `docs(plugins): document submenu items in the authoring guide` -- the
   authoring guide and `apps/web/AGENTS.md` stop calling group `primary`
   flat-only.
6. `docs(plugins): align the task menu icon type with the SDK` -- the two
   task-menu interface blocks name `PluginIcon`, like every other icon field
   in the document.
7. `test(plugins): pin the submenu registration in the SDK contract` -- the
   public/host SDK contract test covers the two registrations this adds,
   including that a flat-only registration still compiles.
8. `perf(plugins): build a card's plugin menu entries once per render` -- the
   card builds its dropdown and context variants from one render, so each
   plugin action's `items()` is evaluated once instead of twice.
9. `fix(plugins): keep a submenu trigger label in the command palette` -- the
   sidebar command builder stamped its own context over the trigger label a
   flattened child carries, so the label never reached a palette row.
10. `fix(plugins): keep flattened palette command ids unique` -- a child's id
    could spell a different action's key, which collides in the palette where
    the id is also the search value.
11. `fix(plugins): guard the registration's own label and icon` -- an action
    whose label was not a usable string is omitted instead of handing React an
    object, a non-string icon is no longer coerced into a name lookup on any
    surface, and the new tests typecheck again.
12. `fix(plugins): keep an explicit null icon, and finish the child-filter
    docs` -- `icon: null` counts as "no icon" rather than dropping the child,
    and both docs state the whole child filter and the shared per-render
    evaluation.
13. `fix(plugins): recognise component-object icons and escape child keys` --
    a `forwardRef`/`memo`/`lazy` component icon (what every `@tabler` icon is)
    no longer drops its child, and a child's key delimits and escapes its id
    so two actions cannot produce one key.
14. `fix(plugins): make child keys unforgeable and keep the native Edit item`
    -- every key part escapes the delimiter, so even an action id carrying it
    cannot spell another action's child key, and a group `edit` registration
    the host cannot render no longer wraps the native `Edit` item in an empty
    submenu.
15. `fix(plugins): drop lazy icons, encode key parts, and resolve own keys
    only` -- a `lazy` icon would suspend a menu instead of falling back, both
    key id parts are percent-encoded so two plugins cannot spell one key, and
    the curated icon map is only read for its own keys (`__proto__`,
    `constructor` and friends no longer reach React).
16. `fix(plugins): force the flat Edit item over a prebuilt bundle` --
    `forceFlatEdit` outranks a prebuilt contribution bundle instead of being
    silently undone by it, and the API doc's fallback list no longer claims a
    partly broken array falls back whole.
17. `fix(plugins): encode key parts without throwing on a lone surrogate` --
    `encodeURIComponent` raises `URIError` on an unpaired surrogate, which a
    truncated emoji in a plugin id produces and which would take the whole
    kanban route down from inside a render; a non-throwing per-code-unit
    encoder replaces it, and `disabled: null` now counts as absent.
18. `docs(plugins): state the action-id uniqueness requirement` -- the SDK
    type and the API doc say an action id must be unique within its plugin and
    group (and why the registry does not enforce it), and the palette comment
    describing the old dash-joined key scheme is corrected.
19. `fix(plugins): make the key escape injective` -- the previous encoder
    collided (`U+25E9` with `%E9`; plugin `p` + action `E9é` with plugin `pé`
    + action `E9`); escaping only the key's own three special characters makes
    it injective and delimiter-free by construction while staying
    non-throwing on lone surrogates.
20. `test(plugins): pin the escaping's width independence` -- the regression
    pairs a per-code-unit hex escape collides on (`%0` vs U+0250, `%` vs
    `%25`, U+00E9+"a" vs U+0E9A) are asserted distinct, and the key tests live
    in their own file.
21. `fix(plugins): resolve a child's icon inside the guard, and finish the
    null docs` -- the snapshot holds the resolved icon node, so a `$$typeof`
    getter that answers once and throws cannot escape the guard, and the SDK
    type, PLUGIN-API.md and the authoring guide all say `null`/absent
    `disabled` means enabled.
22. `fix(plugins): stop the diagnostics and the icon guard from throwing` --
    an action id that is a Symbol (or whose `toString` throws) is reported
    instead of throwing out of the report, and a component icon must carry the
    payload React can call, so a plain object faking `$$typeof` falls back to
    the glyph instead of reaching `createElement`.
23. `fix(plugins): make the icon guard total and the registry read defensive`
    -- a class payload is refused (React cannot call a constructor as a
    function component), the guard answers "no icon" for a throwing getter or
    a cyclic wrapper instead of throwing through surfaces with no error
    boundary, and `getTaskMenuActions` drops a registration it cannot read
    instead of letting its getter escape during a card's render.
</details>

```sh
# only to pick up the payload validation above on a host built before the merge
git -C ../kandev am /path/to/kandev-plugin-tags/contrib/kandev-plugin-submenus.patch
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
