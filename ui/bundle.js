/**
 * Native JS UI bundle for kandev-plugin-tags (docs/plans/plugins/PLUGIN-API.md).
 * A self-contained ES module -- no imports, no bundled React -- that calls
 * `window.registerKandevPlugin(id, plugin)` at evaluation time and, on
 * `initialize(registry, host)`, registers:
 *
 *   - a "task-card-tags" slot component (TagChips) rendering the current
 *     user's tags for a card as a chip row, with a per-chip remove button;
 *   - a registerTaskMenuAction under the kanban card's "edit" group
 *     ("Add tag...") that opens a host.openModal editor (AddTagModal) to add
 *     a new tag.
 *
 * Tags are plain strings, stored as a single array under host.storage's
 * scope "task", key "tags" -- per-user, per-card, per docs/specs/plugins/spec.md.
 * Every write races against a concurrent write from another tab/surface, so
 * both TagChips and AddTagModal read-modify-write against the entry's
 * `updatedAt` via `ifUnmodifiedSince`, retrying on a
 * PluginStorageConflictError (HTTP 409) by re-reading and reapplying the
 * user's intent once. Uses only host.React/host.jsx.
 */
(function () {
  var STORAGE_SCOPE = "task";
  var STORAGE_KEY = "tags";
  var MAX_TAG_LENGTH = 32;
  var MAX_TAGS = 12;
  var CONFLICT_RETRY_LIMIT = 1;

  // "tags-chips" / "tags-modal" are distinct writerIds (not the shared
  // per-tab default) so the chip row's own subscription doesn't treat the
  // modal's writes (or vice versa) as its own echo -- both surfaces can be
  // open on the same card at once (see PluginStorageSetOptions.writerId).
  var CHIPS_WRITER_ID = "tags-chips";
  var MODAL_WRITER_ID = "tags-modal";

  // Inline styles (not a global stylesheet -- avoids any injection/cleanup
  // lifecycle) using the host's CSS custom properties so chips match the
  // surrounding theme instead of rendering as unstyled, unspaced inline text.
  var CHIP_ROW_STYLE = { display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" };
  var CHIP_STYLE = {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 7px",
    borderRadius: "999px",
    background: "var(--muted)",
    fontSize: "11px",
    fontWeight: 500,
    whiteSpace: "nowrap",
  };
  var CHIP_REMOVE_BUTTON_STYLE = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    background: "transparent",
    color: "inherit",
    opacity: 0.6,
    cursor: "pointer",
    lineHeight: 1,
    fontSize: "11px",
  };

  /**
   * Normalizes one raw tag: trims whitespace, rejects empty strings and
   * anything over MAX_TAG_LENGTH characters. Returns null when invalid.
   */
  function normalizeTag(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TAG_LENGTH) return null;
    return trimmed;
  }

  /**
   * Returns a new tags array with `raw` added, or the same array reference
   * (no-op) when `raw` normalizes to invalid, already exists
   * (case-insensitively), or the list is already at MAX_TAGS.
   */
  function addTag(tags, raw) {
    var normalized = normalizeTag(raw);
    if (normalized === null) return tags;
    var lower = normalized.toLowerCase();
    var exists = tags.some(function (tag) {
      return tag.toLowerCase() === lower;
    });
    if (exists || tags.length >= MAX_TAGS) return tags;
    return tags.concat([normalized]);
  }

  /** Returns a new tags array with `target` removed (case-insensitive match). */
  function removeTag(tags, target) {
    var lower = String(target).toLowerCase();
    return tags.filter(function (tag) {
      return tag.toLowerCase() !== lower;
    });
  }

  function isConflictError(err) {
    return !!err && err.name === "PluginStorageConflictError";
  }

  /**
   * Reads the current tags entry, applies `mutate` to its value, and writes
   * the result back with `ifUnmodifiedSince` set to what was just read. If
   * the write loses a race (PluginStorageConflictError), re-reads and
   * retries `mutate` against the fresher value, up to CONFLICT_RETRY_LIMIT
   * times, before giving up and rethrowing.
   */
  function readModifyWrite(host, taskId, writerId, mutate, attempt) {
    attempt = attempt || 0;
    return host.storage.get(STORAGE_SCOPE, taskId, STORAGE_KEY).then(function (entry) {
      var current = entry && Array.isArray(entry.value) ? entry.value : [];
      var next = mutate(current);
      var options = { writerId: writerId };
      if (entry) options.ifUnmodifiedSince = entry.updatedAt;
      return host.storage.set(STORAGE_SCOPE, taskId, STORAGE_KEY, next, options).catch(function (err) {
        if (isConflictError(err) && attempt < CONFLICT_RETRY_LIMIT) {
          return readModifyWrite(host, taskId, writerId, mutate, attempt + 1);
        }
        throw err;
      });
    });
  }

  function useTags(host, taskId, writerId) {
    var React = host.React;
    var valueState = React.useState([]);
    var tags = valueState[0];
    var setTags = valueState[1];
    var loadedState = React.useState(false);
    var loaded = loadedState[0];
    var setLoaded = loadedState[1];

    React.useEffect(
      function () {
        var cancelled = false;
        // Guards against an older in-flight read (triggered by an earlier
        // subscribe notification) resolving after a newer one and clobbering
        // it -- same ordering hazard as the fixture plugin's Notes panel.
        var generation = 0;
        function refresh() {
          var thisGeneration = ++generation;
          host.storage.get(STORAGE_SCOPE, taskId, STORAGE_KEY).then(
            function (entry) {
              if (cancelled || thisGeneration !== generation) return;
              // Defensive: storage is a generic, schema-less blob store, so
              // a direct API call or an incompatible plugin version could
              // stash non-string entries. Rendering those as React children
              // throws ("Objects are not valid as a React child"), so drop
              // anything that doesn't normalize to a valid string tag.
              var rawValue = entry && Array.isArray(entry.value) ? entry.value : [];
              setTags(
                rawValue
                  .map(function (t) {
                    return typeof t === "string" ? t.trim() : null;
                  })
                  .filter(function (t) {
                    return t !== null && t.length > 0;
                  }),
              );
              setLoaded(true);
            },
            function () {
              if (cancelled || thisGeneration !== generation) return;
              setLoaded(true);
            },
          );
        }
        refresh();
        var unsubscribe = host.storage.subscribe(
          { scope: STORAGE_SCOPE, scopeId: taskId, key: STORAGE_KEY, writerId: writerId },
          refresh,
        );
        return function () {
          cancelled = true;
          unsubscribe();
        };
      },
      [taskId, writerId],
    );

    return [tags, loaded];
  }

  function makeTagChips(host) {
    var React = host.React;
    var jsx = host.jsx;

    return function TagChips(props) {
      var slotProps = props.slotProps || {};
      var taskId = slotProps.taskId;
      var tagsAndLoaded = useTags(host, taskId, CHIPS_WRITER_ID);
      var tags = tagsAndLoaded[0];
      var loaded = tagsAndLoaded[1];

      if (!loaded || tags.length === 0) return null;

      function handleRemove(tag) {
        readModifyWrite(host, taskId, CHIPS_WRITER_ID, function (current) {
          return removeTag(current, tag);
        }).catch(function () {
          // Surface the failed removal on the next subscribe/refresh cycle
          // rather than throwing inside a React event handler.
        });
      }

      return jsx(
        "div",
        { "data-testid": "kandev-tags-chip-row", style: CHIP_ROW_STYLE },
        tags.map(function (tag) {
          return jsx(
            "span",
            {
              key: tag,
              "data-testid": "kandev-tags-chip",
              className: "kandev-tags-chip",
              style: CHIP_STYLE,
            },
            tag,
            jsx(
              "button",
              {
                type: "button",
                "aria-label": "Remove tag " + tag,
                "data-testid": "kandev-tags-chip-remove",
                style: CHIP_REMOVE_BUTTON_STYLE,
                // The chip row lives inside the kanban card's own clickable
                // area (opens the task on click, e.g. KanbanCardMenu's
                // "More options" trigger in kanban-card-content.tsx follows
                // the same stopPropagation convention) -- without this, a
                // click here also navigates into the task.
                onClick: function (e) {
                  if (e && e.stopPropagation) e.stopPropagation();
                  handleRemove(tag);
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

  function makeAddTagModal(host, taskId, close) {
    var React = host.React;
    var jsx = host.jsx;

    return function AddTagModal() {
      var tagsAndLoaded = useTags(host, taskId, MODAL_WRITER_ID);
      var tags = tagsAndLoaded[0];
      var loaded = tagsAndLoaded[1];
      var inputState = React.useState("");
      var draft = inputState[0];
      var setDraft = inputState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      function handleAdd() {
        var candidate = draft;
        setError(null);
        readModifyWrite(host, taskId, MODAL_WRITER_ID, function (current) {
          return addTag(current, candidate);
        })
          .then(function () {
            setDraft("");
          })
          .catch(function () {
            setError("Could not save tag. Please try again.");
          });
      }

      function handleRemove(tag) {
        readModifyWrite(host, taskId, MODAL_WRITER_ID, function (current) {
          return removeTag(current, tag);
        }).catch(function () {
          setError("Could not remove tag. Please try again.");
        });
      }

      function handleKeyDown(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          handleAdd();
        }
      }

      return jsx(
        "div",
        { "data-testid": "kandev-tags-modal" },
        jsx(
          "div",
          { "data-testid": "kandev-tags-modal-list", style: CHIP_ROW_STYLE },
          !loaded
            ? "Loading\u2026"
            : tags.map(function (tag) {
                return jsx(
                  "span",
                  { key: tag, "data-testid": "kandev-tags-modal-chip", style: CHIP_STYLE },
                  tag,
                  jsx(
                    "button",
                    {
                      type: "button",
                      "aria-label": "Remove tag " + tag,
                      style: CHIP_REMOVE_BUTTON_STYLE,
                      onClick: function () {
                        handleRemove(tag);
                      },
                    },
                    "\u00d7",
                  ),
                );
              }),
        ),
        jsx("input", {
          "data-testid": "kandev-tags-modal-input",
          value: draft,
          placeholder: "Add a tag\u2026",
          maxLength: MAX_TAG_LENGTH,
          onChange: function (e) {
            setDraft(e.target.value);
          },
          onKeyDown: handleKeyDown,
        }),
        jsx(
          "button",
          {
            type: "button",
            "data-testid": "kandev-tags-modal-add",
            onClick: handleAdd,
          },
          "Add",
        ),
        error ? jsx("div", { "data-testid": "kandev-tags-modal-error" }, error) : null,
        jsx(
          "button",
          {
            type: "button",
            "data-testid": "kandev-tags-modal-close",
            onClick: close,
          },
          "Close",
        ),
      );
    };
  }

  window.registerKandevPlugin("kandev-plugin-tags", {
    initialize: function (registry, host) {
      registry.registerComponent("task-card-tags", makeTagChips(host));

      registry.registerTaskMenuAction({
        id: "add-tag",
        label: "Add tag\u2026",
        group: "edit",
        run: function (context) {
          var handle = host.openModal({
            title: "Tags",
            size: "sm",
            content: makeAddTagModal(host, context.taskId, function () {
              handle.close();
            }),
          });
        },
      });
    },
    // Exposed for ui/bundle.test.js only -- not part of the KandevPlugin
    // contract consumed by the host, which only reads `initialize`.
    __internal: {
      normalizeTag: normalizeTag,
      addTag: addTag,
      removeTag: removeTag,
      isConflictError: isConflictError,
      readModifyWrite: readModifyWrite,
      MAX_TAG_LENGTH: MAX_TAG_LENGTH,
      MAX_TAGS: MAX_TAGS,
    },
  });
})();
