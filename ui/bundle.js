/**
 * Native JS UI bundle for kandev-plugin-tags (docs/plans/plugins/PLUGIN-API.md).
 * A self-contained ES module -- no imports, no bundled React -- that calls
 * `window.registerKandevPlugin(id, plugin)` at evaluation time and, on
 * `initialize(registry, host)`, registers:
 *
 *   - a "task-card-tags" slot component (TagChips) rendering the current
 *     user's tags for a card as a colored chip row;
 *   - a registerTaskMenuAction under the kanban card's "primary" group
 *     ("Add tag...") that opens a redesigned host.openModal editor
 *     (TagPickerModal) to search/create and multi-select tags for the card;
 *   - a "main-top-bar" slot button ("Tags") that opens a management modal
 *     (TagManagerModal) to add/edit(name, color)/remove tags from the
 *     user's tag catalog;
 *   - (feature-detected) a `registerTaskFilter` contribution to the board's
 *     filter dropdown, active only on hosts that ship that extension point
 *     (shipped in kdlbs/kandev PR #2351; no-ops on older hosts).
 *
 * Data model (v2): each user has a *catalog* of named, colored tags --
 * `{ id, name, color }` -- stored once per workspace (host.storage scope
 * "workspace", key "tags-catalog"). Each card stores only the *ids* of the
 * tags applied to it (host.storage scope "task", key "tags"). This lets a
 * tag's name/color be edited or a tag be reused across many cards without
 * rewriting every card's storage entry.
 *
 * Back-compat: v1 stored a card's tags as a plain array of tag-name strings
 * (no catalog, no color). Those entries are still valid task-scope values --
 * `resolveTag` treats any id that isn't found in the catalog as a legacy
 * plain-string tag, rendering the id itself as the name with DEFAULT_COLOR.
 * No migration write is performed; legacy and v2 tags can coexist on a card.
 *
 * Every write races against a concurrent write from another tab/surface, so
 * all mutations read-modify-write against the entry's `updatedAt` via
 * `ifUnmodifiedSince`, retrying on a PluginStorageConflictError (HTTP 409) by
 * re-reading and reapplying the caller's intent once. Uses only
 * host.React/host.jsx -- no host.ui primitives, to keep the bundle a single
 * dependency-free file (matches the v1 convention).
 */
(function () {
  var CATALOG_SCOPE = "workspace";
  var CATALOG_KEY = "tags-catalog";
  var TASK_SCOPE = "task";
  var TASK_KEY = "tags";
  var MAX_TAG_LENGTH = 32;
  var MAX_TAGS_PER_TASK = 12;
  var CONFLICT_RETRY_LIMIT = 1;
  var UNTAGGED_FILTER_VALUE = "__untagged__";

  // Distinct writerIds (not the shared per-tab default) so one surface's own
  // subscription doesn't treat another open surface's writes as its own echo
  // -- the chip row, the add/pick modal, and the manager modal can all be
  // open on the same card/workspace at once (see PluginStorageSetOptions).
  var CHIPS_WRITER_ID = "tags-chips";
  var PICKER_WRITER_ID = "tags-picker";
  var MANAGER_WRITER_ID = "tags-manager";

  // Plugin-owned color palette (a plugin-owned counterpart to the host's own
  // task-color palette, `apps/web/lib/task-colors.ts`) -- new catalog tags
  // cycle through these before a user picks/types a custom hex.
  var PALETTE = [
    "#ef4444", // red
    "#f97316", // orange
    "#eab308", // yellow
    "#22c55e", // green
    "#3b82f6", // blue
    "#a855f7", // purple
    "#ec4899", // pink
  ];
  var DEFAULT_COLOR = "#6b7280"; // gray -- used for unresolvable/legacy tags

  var HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

  var CHIP_ROW_STYLE = { display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" };
  var CHIP_REMOVE_BUTTON_STYLE = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    background: "transparent",
    color: "inherit",
    opacity: 0.75,
    cursor: "pointer",
    lineHeight: 1,
    fontSize: "11px",
  };

  function chipStyle(color) {
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "1px 7px",
      borderRadius: "999px",
      background: color,
      color: "#fff",
      fontSize: "11px",
      fontWeight: 500,
      whiteSpace: "nowrap",
    };
  }

  // ---------------------------------------------------------------------
  // Pure helpers (catalog + task tag-id lists + color/name validation).
  // Exposed via __internal for ui/bundle.test.js.
  // ---------------------------------------------------------------------

  /** Trims a raw tag name, rejects empty or over-MAX_TAG_LENGTH. Null if invalid. */
  function normalizeName(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TAG_LENGTH) return null;
    return trimmed;
  }

  /** Validates/normalizes a hex color string (3 or 6 digit, `#` required). Null if invalid. */
  function normalizeColor(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = raw.trim();
    if (!HEX_COLOR_RE.test(trimmed)) return null;
    return trimmed.toLowerCase();
  }

  /** Deterministic-enough unique id for a new catalog tag (no uuid dependency). */
  function makeTagId() {
    return "tag-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /** Next palette color for a catalog of the given current size, cycling through PALETTE. */
  function nextPaletteColor(catalog) {
    return PALETTE[catalog.length % PALETTE.length];
  }

  /** Case-insensitive name lookup within a catalog array. */
  function findTagByName(catalog, name) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].name.toLowerCase() === lower) return catalog[i];
    }
    return null;
  }

  function findTagById(catalog, id) {
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].id === id) return catalog[i];
    }
    return null;
  }

  /**
   * Adds a new catalog tag with the given raw name/color. Returns
   * `{ catalog, tag }` (a new catalog array plus the created entry) or
   * `null` when the name is invalid or already exists case-insensitively
   * (callers should treat an existing match as "nothing to create" and use
   * the existing tag's id instead).
   */
  function addCatalogTag(catalog, rawName, rawColor) {
    var name = normalizeName(rawName);
    if (name === null) return null;
    if (findTagByName(catalog, name)) return null;
    var color = normalizeColor(rawColor) || nextPaletteColor(catalog);
    var tag = { id: makeTagId(), name: name, color: color };
    return { catalog: catalog.concat([tag]), tag: tag };
  }

  /** Returns a new catalog with `id`'s name/color patched. No-op (same reference) if not found or invalid. */
  function updateCatalogTag(catalog, id, patch) {
    var next = {};
    if (patch && "name" in patch) {
      var name = normalizeName(patch.name);
      if (name === null) return catalog;
      var clashing = findTagByName(catalog, name);
      if (clashing && clashing.id !== id) return catalog;
      next.name = name;
    }
    if (patch && "color" in patch) {
      var color = normalizeColor(patch.color);
      if (color === null) return catalog;
      next.color = color;
    }
    var found = false;
    var updated = catalog.map(function (tag) {
      if (tag.id !== id) return tag;
      found = true;
      return Object.assign({}, tag, next);
    });
    return found ? updated : catalog;
  }

  /** Returns a new catalog with `id` removed. Same reference if not present. */
  function removeCatalogTag(catalog, id) {
    var next = catalog.filter(function (tag) {
      return tag.id !== id;
    });
    return next.length === catalog.length ? catalog : next;
  }

  /** Adds `id` to a task's tag-id list, deduped, capped at MAX_TAGS_PER_TASK. Same reference if a no-op. */
  function addTaskTagId(tagIds, id) {
    if (!id || tagIds.indexOf(id) !== -1 || tagIds.length >= MAX_TAGS_PER_TASK) return tagIds;
    return tagIds.concat([id]);
  }

  /** Removes `id` from a task's tag-id list. Same reference if not present. */
  function removeTaskTagId(tagIds, id) {
    var next = tagIds.filter(function (existing) {
      return existing !== id;
    });
    return next.length === tagIds.length ? tagIds : next;
  }

  /**
   * Resolves a stored task tag-id to a displayable `{ id, name, color }`.
   * Falls back to treating `id` itself as a legacy v1 plain-string tag name
   * (DEFAULT_COLOR) when no catalog entry matches -- see the back-compat
   * note at the top of this file.
   */
  function resolveTag(catalog, id) {
    var found = findTagById(catalog, id);
    if (found) return found;
    return { id: id, name: String(id), color: DEFAULT_COLOR };
  }

  function isConflictError(err) {
    return !!err && err.name === "PluginStorageConflictError";
  }

  /**
   * Reads the current value at (scope, scopeId, key), applies `mutate`, and
   * writes the result back with `ifUnmodifiedSince` set to what was just
   * read. Retries once on a PluginStorageConflictError by re-reading and
   * reapplying `mutate` against the fresher value, then rethrows.
   */
  function readModifyWrite(host, scope, scopeId, key, writerId, defaultValue, mutate, attempt) {
    attempt = attempt || 0;
    return host.storage.get(scope, scopeId, key).then(function (entry) {
      var current = entry && entry.value !== undefined ? entry.value : defaultValue;
      var next = mutate(current);
      var options = { writerId: writerId };
      if (entry) options.ifUnmodifiedSince = entry.updatedAt;
      return host.storage.set(scope, scopeId, key, next, options).catch(function (err) {
        if (isConflictError(err) && attempt < CONFLICT_RETRY_LIMIT) {
          return readModifyWrite(host, scope, scopeId, key, writerId, defaultValue, mutate, attempt + 1);
        }
        throw err;
      });
    });
  }

  function readModifyWriteCatalog(host, workspaceId, writerId, mutate) {
    return readModifyWrite(host, CATALOG_SCOPE, workspaceId, CATALOG_KEY, writerId, [], function (current) {
      return mutate(sanitizeCatalog(current));
    });
  }

  function readModifyWriteTaskTags(host, taskId, writerId, mutate) {
    return readModifyWrite(host, TASK_SCOPE, taskId, TASK_KEY, writerId, [], function (current) {
      return mutate(sanitizeTagIdList(current));
    });
  }

  /** Drops anything that isn't a non-empty string (defensive against a schema-less blob store). */
  function sanitizeTagIdList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (v) {
      return typeof v === "string" && v.length > 0;
    });
  }

  /** Drops catalog entries that don't look like `{ id, name, color }`. */
  function sanitizeCatalog(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (t) {
      return t && typeof t.id === "string" && typeof t.name === "string" && typeof t.color === "string";
    });
  }

  // ---------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------

  function useStorageValue(host, scope, scopeId, key, writerId, sanitize) {
    var React = host.React;
    var valueState = React.useState([]);
    var value = valueState[0];
    var setValue = valueState[1];
    var loadedState = React.useState(false);
    var loaded = loadedState[0];
    var setLoaded = loadedState[1];
    // Stable mutable box (used in lieu of useRef, which isn't guaranteed on
    // every host.React implementation) so `refresh` can be called directly
    // right after this component's own write completes -- host.storage's
    // subscribe intentionally suppresses a writer's own echo (see
    // PLUGIN-API.md's "own-tab echo suppression"), so relying on the
    // subscription alone would leave a modal that just wrote a value
    // showing stale data until some other write/tab happens to refresh it.
    // Not using a lazy initializer function here: the plugin's minimal test
    // React host doesn't invoke function-form useState initializers, so a
    // plain object literal (thrown away on renders after the first, same as
    // React does with any non-function initial value) keeps this portable.
    var box = React.useState({ generation: 0, cancelled: false })[0];

    function refresh() {
      var thisGeneration = ++box.generation;
      host.storage.get(scope, scopeId, key).then(
        function (entry) {
          if (box.cancelled || thisGeneration !== box.generation) return;
          setValue(sanitize(entry ? entry.value : undefined));
          setLoaded(true);
        },
        function () {
          if (box.cancelled || thisGeneration !== box.generation) return;
          setLoaded(true);
        },
      );
    }

    React.useEffect(
      function () {
        box.cancelled = false;
        refresh();
        var unsubscribe = host.storage.subscribe(
          { scope: scope, scopeId: scopeId, key: key, writerId: writerId },
          refresh,
        );
        return function () {
          box.cancelled = true;
          unsubscribe();
        };
      },
      [scope, scopeId, key, writerId],
    );

    return [value, loaded, refresh];
  }

  function useTaskTagIds(host, taskId, writerId) {
    return useStorageValue(host, TASK_SCOPE, taskId, TASK_KEY, writerId, sanitizeTagIdList);
  }

  function useCatalog(host, workspaceId, writerId) {
    return useStorageValue(host, CATALOG_SCOPE, workspaceId, CATALOG_KEY, writerId, sanitizeCatalog);
  }

  // In-memory cache of taskId -> resolved tag ids, populated as each card's
  // TagChips instance mounts/refreshes. This is the only cross-card index
  // the plugin has (host.storage has no bulk/cross-scopeId query -- see
  // PluginStorageApi.list, which is scoped to a single (scope, scopeId)),
  // so the board-wide Tags filter (once registerTaskFilter ships) can only
  // ever reason about cards that have actually rendered their chips.
  var taskTagCache = {};

  function setTaskTagCache(taskId, tagIds) {
    taskTagCache[taskId] = tagIds;
  }

  // ---------------------------------------------------------------------
  // task-card-tags: chip row
  // ---------------------------------------------------------------------

  function makeTagChips(host) {
    var React = host.React;
    var jsx = host.jsx;

    return function TagChips(props) {
      var slotProps = props.slotProps || {};
      var taskId = slotProps.taskId;
      var workspaceId = slotProps.workspaceId;
      var tagIdsAndLoaded = useTaskTagIds(host, taskId, CHIPS_WRITER_ID);
      var tagIds = tagIdsAndLoaded[0];
      var tagIdsLoaded = tagIdsAndLoaded[1];
      var catalogAndLoaded = useCatalog(host, workspaceId, CHIPS_WRITER_ID);
      var catalog = catalogAndLoaded[0];
      var catalogLoaded = catalogAndLoaded[1];

      React.useEffect(
        function () {
          if (tagIdsLoaded) setTaskTagCache(taskId, tagIds);
        },
        [taskId, tagIdsLoaded, tagIds],
      );

      if (!tagIdsLoaded || !catalogLoaded || tagIds.length === 0) return null;

      function handleRemove(id) {
        readModifyWriteTaskTags(host, taskId, CHIPS_WRITER_ID, function (current) {
          return removeTaskTagId(current, id);
        }).catch(function () {
          // Surface the failed removal on the next subscribe/refresh cycle
          // rather than throwing inside a React event handler.
        });
      }

      return jsx(
        "div",
        { "data-testid": "kandev-tags-chip-row", style: CHIP_ROW_STYLE },
        tagIds.map(function (id) {
          var tag = resolveTag(catalog, id);
          return jsx(
            "span",
            {
              key: id,
              "data-testid": "kandev-tags-chip",
              className: "kandev-tags-chip",
              style: chipStyle(tag.color),
            },
            tag.name,
            jsx(
              "button",
              {
                type: "button",
                "aria-label": "Remove tag " + tag.name,
                "data-testid": "kandev-tags-chip-remove",
                style: CHIP_REMOVE_BUTTON_STYLE,
                // The chip row lives inside the kanban card's own clickable
                // area (opens the task on click) -- without this, a click
                // here also navigates into the task.
                onClick: function (e) {
                  if (e && e.stopPropagation) e.stopPropagation();
                  handleRemove(id);
                },
                onPointerDown: function (e) {
                  if (e && e.stopPropagation) e.stopPropagation();
                },
              },
              "\u00d7",
            ),
          );
        }),
      );
    };
  }

  // ---------------------------------------------------------------------
  // Add/pick-tag modal (opened from the kanban card menu)
  // ---------------------------------------------------------------------

  function makeTagPickerModal(host, taskId, workspaceId) {
    var React = host.React;
    var jsx = host.jsx;

    return function TagPickerModal() {
      var tagIdsAndLoaded = useTaskTagIds(host, taskId, PICKER_WRITER_ID);
      var tagIds = tagIdsAndLoaded[0];
      var tagIdsLoaded = tagIdsAndLoaded[1];
      var refreshTagIds = tagIdsAndLoaded[2];
      var catalogAndLoaded = useCatalog(host, workspaceId, PICKER_WRITER_ID);
      var catalog = catalogAndLoaded[0];
      var catalogLoaded = catalogAndLoaded[1];
      var refreshCatalog = catalogAndLoaded[2];
      var draftState = React.useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var loaded = tagIdsLoaded && catalogLoaded;
      var name = normalizeName(draft);
      var existingMatch = name ? findTagByName(catalog, name) : null;
      // "Add" creates a brand-new catalog tag -- disabled once the typed name
      // already exists (case-insensitively), whether or not it's applied to
      // this card yet (selecting an existing tag is done via the list below).
      var canCreate = loaded && name !== null && existingMatch === null;

      function toggleTag(id) {
        setError(null);
        var applying = tagIds.indexOf(id) === -1;
        readModifyWriteTaskTags(host, taskId, PICKER_WRITER_ID, function (current) {
          return applying ? addTaskTagId(current, id) : removeTaskTagId(current, id);
        })
          .then(refreshTagIds)
          .catch(function () {
            setError("Could not update tag. Please try again.");
          });
      }

      function handleCreateAndApply() {
        if (!canCreate) return;
        setError(null);
        var nameToCreate = draft;
        readModifyWriteCatalog(host, workspaceId, PICKER_WRITER_ID, function (currentCatalog) {
          var result = addCatalogTag(currentCatalog, nameToCreate, null);
          if (result === null) return currentCatalog;
          return result.catalog;
        })
          .then(function () {
            refreshCatalog();
            // Re-read so we apply the id the write actually produced (also
            // covers the case another tab created the same name meanwhile).
            return host.storage.get(CATALOG_SCOPE, workspaceId, CATALOG_KEY);
          })
          .then(function (entry) {
            var latest = sanitizeCatalog(entry ? entry.value : []);
            var created = findTagByName(latest, nameToCreate);
            if (!created) throw new Error("tag not found after create");
            setDraft("");
            return readModifyWriteTaskTags(host, taskId, PICKER_WRITER_ID, function (current) {
              return addTaskTagId(current, created.id);
            });
          })
          .then(refreshTagIds)
          .catch(function () {
            setError("Could not create tag. Please try again.");
          });
      }

      function handleKeyDown(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          handleCreateAndApply();
        }
      }

      return jsx(
        "div",
        {
          "data-testid": "kandev-tags-picker-modal",
          style: { display: "flex", flexDirection: "column", gap: "10px" },
        },
        jsx(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "center" } },
          jsx("input", {
            "data-testid": "kandev-tags-picker-input",
            value: draft,
            placeholder: "Search or create a tag\u2026",
            maxLength: MAX_TAG_LENGTH,
            style: { flex: "0 0 80%", minWidth: 0 },
            onChange: function (e) {
              setDraft(e.target.value);
            },
            onKeyDown: handleKeyDown,
          }),
          jsx(
            "button",
            {
              type: "button",
              "data-testid": "kandev-tags-picker-add",
              disabled: !canCreate,
              onClick: handleCreateAndApply,
            },
            "Add",
          ),
        ),
        jsx(
          "div",
          {
            "data-testid": "kandev-tags-picker-list",
            style: { maxHeight: "220px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" },
          },
          !loaded
            ? "Loading\u2026"
            : catalog
                .filter(function (tag) {
                  return !name || tag.name.toLowerCase().indexOf(name.toLowerCase()) !== -1;
                })
                .map(function (tag) {
                  var checked = tagIds.indexOf(tag.id) !== -1;
                  return jsx(
                    "label",
                    {
                      key: tag.id,
                      "data-testid": "kandev-tags-picker-option",
                      style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" },
                    },
                    jsx("input", {
                      type: "checkbox",
                      checked: checked,
                      onChange: function () {
                        toggleTag(tag.id);
                      },
                    }),
                    jsx("span", { style: chipStyle(tag.color) }, tag.name),
                  );
                }),
        ),
        error ? jsx("div", { "data-testid": "kandev-tags-picker-error" }, error) : null,
      );
    };
  }

  // ---------------------------------------------------------------------
  // Tag manager modal (opened from the "main-top-bar" button)
  // ---------------------------------------------------------------------

  function makeTagManagerModal(host, workspaceId) {
    var React = host.React;
    var jsx = host.jsx;

    return function TagManagerModal() {
      var catalogAndLoaded = useCatalog(host, workspaceId, MANAGER_WRITER_ID);
      var catalog = catalogAndLoaded[0];
      var loaded = catalogAndLoaded[1];
      var refreshCatalog = catalogAndLoaded[2];
      var draftState = React.useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var name = normalizeName(draft);
      var canCreate = loaded && name !== null && findTagByName(catalog, name) === null;

      function handleCreate() {
        if (!canCreate) return;
        setError(null);
        readModifyWriteCatalog(host, workspaceId, MANAGER_WRITER_ID, function (current) {
          var result = addCatalogTag(current, draft, null);
          return result === null ? current : result.catalog;
        })
          .then(function () {
            setDraft("");
            refreshCatalog();
          })
          .catch(function () {
            setError("Could not create tag. Please try again.");
          });
      }

      function handleRename(id, nextName) {
        readModifyWriteCatalog(host, workspaceId, MANAGER_WRITER_ID, function (current) {
          return updateCatalogTag(current, id, { name: nextName });
        })
          .then(refreshCatalog)
          .catch(function () {
            setError("Could not rename tag. Please try again.");
          });
      }

      function handleRecolor(id, nextColor) {
        readModifyWriteCatalog(host, workspaceId, MANAGER_WRITER_ID, function (current) {
          return updateCatalogTag(current, id, { color: nextColor });
        })
          .then(refreshCatalog)
          .catch(function () {
            setError("Could not recolor tag. Please try again.");
          });
      }

      function handleRemove(id) {
        readModifyWriteCatalog(host, workspaceId, MANAGER_WRITER_ID, function (current) {
          return removeCatalogTag(current, id);
        })
          .then(refreshCatalog)
          .catch(function () {
            setError("Could not remove tag. Please try again.");
          });
      }

      return jsx(
        "div",
        {
          "data-testid": "kandev-tags-manager-modal",
          style: { display: "flex", flexDirection: "column", gap: "10px" },
        },
        jsx(
          "div",
          { style: { display: "flex", gap: "8px" } },
          jsx("input", {
            "data-testid": "kandev-tags-manager-input",
            value: draft,
            placeholder: "New tag name\u2026",
            maxLength: MAX_TAG_LENGTH,
            onChange: function (e) {
              setDraft(e.target.value);
            },
          }),
          jsx(
            "button",
            {
              type: "button",
              "data-testid": "kandev-tags-manager-create",
              disabled: !canCreate,
              onClick: handleCreate,
            },
            "Create",
          ),
        ),
        jsx(
          "div",
          {
            "data-testid": "kandev-tags-manager-list",
            style: { maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" },
          },
          !loaded
            ? "Loading\u2026"
            : catalog.map(function (tag) {
                return jsx(
                  "div",
                  {
                    key: tag.id,
                    "data-testid": "kandev-tags-manager-row",
                    style: { display: "flex", alignItems: "center", gap: "8px" },
                  },
                  jsx("input", {
                    type: "color",
                    "data-testid": "kandev-tags-manager-color-picker",
                    value: tag.color,
                    onChange: function (e) {
                      handleRecolor(tag.id, e.target.value);
                    },
                  }),
                  jsx("input", {
                    type: "text",
                    "data-testid": "kandev-tags-manager-hex",
                    value: tag.color,
                    maxLength: 7,
                    style: { width: "70px" },
                    onChange: function (e) {
                      var color = normalizeColor(e.target.value);
                      if (color) handleRecolor(tag.id, color);
                    },
                  }),
                  jsx("input", {
                    type: "text",
                    "data-testid": "kandev-tags-manager-name",
                    defaultValue: tag.name,
                    maxLength: MAX_TAG_LENGTH,
                    onBlur: function (e) {
                      if (e.target.value !== tag.name) handleRename(tag.id, e.target.value);
                    },
                  }),
                  jsx(
                    "button",
                    {
                      type: "button",
                      "data-testid": "kandev-tags-manager-remove",
                      "aria-label": "Remove tag " + tag.name,
                      onClick: function () {
                        handleRemove(tag.id);
                      },
                    },
                    "Remove",
                  ),
                );
              }),
        ),
        error ? jsx("div", { "data-testid": "kandev-tags-manager-error" }, error) : null,
      );
    };
  }

  // ---------------------------------------------------------------------
  // main-top-bar button
  // ---------------------------------------------------------------------

  function makeTopBarButton(host) {
    var jsx = host.jsx;

    return function TagsTopBarButton(props) {
      var slotProps = props.slotProps || {};
      var workspaceId = slotProps.workspaceId;

      function handleClick() {
        return host.openModal({
          title: "Manage tags",
          size: "md",
          content: makeTagManagerModal(host, workspaceId),
        });
      }

      return jsx(
        "button",
        {
          type: "button",
          "data-testid": "kandev-tags-manage-button",
          "aria-label": "Manage tags",
          onClick: handleClick,
        },
        "Tags",
      );
    };
  }

  // ---------------------------------------------------------------------
  // registerTaskFilter (feature-detected -- no-ops on hosts predating it)
  // ---------------------------------------------------------------------

  function registerTagFilter(registry, host) {
    if (typeof registry.registerTaskFilter !== "function") return;

    var catalog = [];
    var currentWorkspaceId = null;
    var unsubscribeStorage = null;

    function refreshCatalog() {
      if (!currentWorkspaceId) {
        catalog = [];
        return;
      }
      host.storage.get(CATALOG_SCOPE, currentWorkspaceId, CATALOG_KEY).then(function (entry) {
        catalog = sanitizeCatalog(entry ? entry.value : []);
      });
    }

    // The active workspace is not necessarily known yet the moment
    // initialize() runs (SPA route hydration can populate it slightly
    // later), so register unconditionally and track host.store's
    // activeWorkspaceId reactively instead of gating registration on an
    // initial snapshot -- otherwise the filter section could silently
    // never appear if the plugin initializes before the workspace route
    // resolves.
    function setWorkspace(workspaceId) {
      if (workspaceId === currentWorkspaceId) return;
      currentWorkspaceId = workspaceId || null;
      if (unsubscribeStorage) {
        unsubscribeStorage();
        unsubscribeStorage = null;
      }
      if (currentWorkspaceId) {
        refreshCatalog();
        unsubscribeStorage = host.storage.subscribe(
          { scope: CATALOG_SCOPE, scopeId: currentWorkspaceId, key: CATALOG_KEY },
          refreshCatalog,
        );
      } else {
        catalog = [];
      }
    }

    function getActiveWorkspaceId() {
      // The host's store keeps the active workspace at
      // `state.workspaces.activeId` (apps/web/lib/state/slices/workspace/
      // workspace-slice.ts) -- there is no top-level `activeWorkspaceId`
      // field. Reading the wrong path silently returns `undefined` forever,
      // which is why this must match the same shape every other workspaceId
      // consumer in this file relies on (slotProps.workspaceId /
      // context.workspaceId, both ultimately sourced from that slice).
      var state = host.store.getState();
      return (state && state.workspaces && state.workspaces.activeId) || null;
    }

    setWorkspace(getActiveWorkspaceId());
    host.store.subscribe(function () {
      setWorkspace(getActiveWorkspaceId());
    });

    registry.registerTaskFilter({
      id: "tags",
      label: "Tags",
      getOptions: function () {
        return catalog
          .map(function (tag) {
            return { value: tag.id, label: tag.name, color: tag.color };
          })
          .concat([{ value: UNTAGGED_FILTER_VALUE, label: "Untagged" }]);
      },
      matches: function (context, selected) {
        if (!selected || selected.length === 0) return true;
        // Cards that haven't mounted their TagChips yet have no cache entry
        // -- see the taskTagCache comment above. Treat that as "no tags"
        // rather than excluding the card outright.
        var tagIds = taskTagCache[context.taskId] || [];
        if (selected.indexOf(UNTAGGED_FILTER_VALUE) !== -1 && tagIds.length === 0) return true;
        return tagIds.some(function (id) {
          return selected.indexOf(id) !== -1;
        });
      },
    });
  }

  window.registerKandevPlugin("kandev-plugin-tags", {
    initialize: function (registry, host) {
      registry.registerComponent("task-card-tags", makeTagChips(host));
      registry.registerComponent("main-top-bar", makeTopBarButton(host));

      registry.registerTaskMenuAction({
        id: "add-tag",
        label: "Add tag\u2026",
        // Flat, top-level item between "Move to"/"Send to workflow" and
        // "Link" -- shipped in kdlbs/kandev PR #2351.
        group: "primary",
        run: function (context) {
          return host.openModal({
            title: "Tags",
            size: "sm",
            content: makeTagPickerModal(host, context.taskId, context.workspaceId),
          });
        },
      });

      // registerTagFilter tracks host.store's activeWorkspaceId reactively
      // (see its own comment) -- registerTaskFilter has no per-workspace
      // concept today, so the filter's options always reflect whichever
      // workspace is currently active, updating live if the user switches
      // workspaces. Registered unconditionally (safe no-op via feature
      // detection on hosts predating registerTaskFilter).
      registerTagFilter(registry, host);
    },
    // Exposed for ui/bundle.test.js only -- not part of the KandevPlugin
    // contract consumed by the host, which only reads `initialize`.
    __internal: {
      normalizeName: normalizeName,
      normalizeColor: normalizeColor,
      makeTagId: makeTagId,
      nextPaletteColor: nextPaletteColor,
      findTagByName: findTagByName,
      findTagById: findTagById,
      addCatalogTag: addCatalogTag,
      updateCatalogTag: updateCatalogTag,
      removeCatalogTag: removeCatalogTag,
      addTaskTagId: addTaskTagId,
      removeTaskTagId: removeTaskTagId,
      resolveTag: resolveTag,
      isConflictError: isConflictError,
      readModifyWrite: readModifyWrite,
      sanitizeTagIdList: sanitizeTagIdList,
      sanitizeCatalog: sanitizeCatalog,
      MAX_TAG_LENGTH: MAX_TAG_LENGTH,
      MAX_TAGS_PER_TASK: MAX_TAGS_PER_TASK,
      PALETTE: PALETTE,
      DEFAULT_COLOR: DEFAULT_COLOR,
      UNTAGGED_FILTER_VALUE: UNTAGGED_FILTER_VALUE,
      makeTagPickerModal: makeTagPickerModal,
      makeTagManagerModal: makeTagManagerModal,
    },
  });
})();
