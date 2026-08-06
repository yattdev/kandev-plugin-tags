# Tags

Add one or more tags to any kanban card. Tags are yours alone: each user's
tags on a card are private and never shown to teammates.

- **On every card**: tags you've added render as a row of small chips below
  the card's other badges. No tags, no row -- the row only appears once
  you've added at least one.
- **Add a tag**: open a card's context/dropdown menu, choose **Edit > Add
  tag...**. A small dialog lists your current tags on that card (each
  removable) and a text field to add a new one.
- **Remove a tag**: click the `x` on a chip, either on the card itself or in
  the Add tag dialog.
- Tags are trimmed, capped at 32 characters, deduplicated
  case-insensitively, and capped at 12 tags per card.

## Install

Build a package (`make package-host` for your platform, `make package` for
all platforms) and install the tarball via **Settings > Plugins > Install**
or `POST /api/plugins/install`.

## How it works and what it reads

Tags is a per-card, per-user annotation tool. It does not call an agent,
read a conversation, or analyze work.

The plugin stores one array of strings per card, in kandev Host per-user
state (`host.storage`, scope `task`, key `tags`) -- one entry per
(user, card) pair. It stores nothing else: no conversation content, no
token data, no cross-card index. Because storage is per-user, two people
looking at the same card each see only their own tags; adding, removing, or
even the presence of any tags is invisible to teammates.

Tags does not use, request, or spend LLM tokens, and has no external
service or analytics integration.

## Development

Developed against a local checkout of the kandev monorepo (see the
`replace` directive in `go.mod`) -- check this repository out as a sibling
directory of your `kandev` checkout (e.g. `../kandev` relative to this
repo), or adjust the `replace` path accordingly.

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

One small array of tag strings per card, in kandev Host per-user state
(scope `task`), so a user's tags participate in kandev backups, survive
plugin upgrades, and are removed on uninstall.
