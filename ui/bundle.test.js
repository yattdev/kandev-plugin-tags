"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// bundle.js is evaluated in a fresh `vm` context per `loadBundle()` call, so
// any array/object it *constructs itself* (object literals; `Array.prototype`
// methods whose receiver also originated inside that vm context) is a
// cross-realm value. `node:assert/strict`'s deepEqual/deepStrictEqual treats
// cross-realm objects/arrays as unequal even when structurally identical
// (differing `Object.getPrototypeOf`), so structural comparisons that may
// involve a vm-realm value use the non-strict `node:assert` deepEqual
// instead, which compares structurally without that prototype-identity
// check. Scalar assertions (`equal`/`ok`) are unaffected by this and keep
// using the strict `assert` import.
const assertStructural = require("node:assert");

const bundleSource = fs.readFileSync(path.join(__dirname, "bundle.js"), "utf8");

/**
 * Loads bundle.js in a fresh vm context, capturing the object it passes to
 * `window.registerKandevPlugin`. Mirrors kandev-plugin-kandy's ui/bundle.test.js
 * harness: bundle.js has no module exports (it is a plain, host-loaded
 * script), so tests recover its internals via the plugin definition object
 * itself (`__internal`, populated at the bottom of bundle.js for this
 * purpose only).
 */
function loadBundle() {
  let plugin = null;
  const context = {
    console,
    window: {
      registerKandevPlugin(id, definition) {
        assert.equal(id, "kandev-plugin-tags");
        plugin = definition;
      },
    },
  };
  vm.runInNewContext(bundleSource, context, { filename: "ui/bundle.js" });
  assert.ok(plugin, "bundle registered the plugin");
  return plugin;
}

// -----------------------------------------------------------------------
// normalizeName / normalizeColor
// -----------------------------------------------------------------------

test("normalizeName trims whitespace", () => {
  const { normalizeName } = loadBundle().__internal;
  assert.equal(normalizeName("  urgent  "), "urgent");
});

test("normalizeName rejects an empty or whitespace-only string", () => {
  const { normalizeName } = loadBundle().__internal;
  assert.equal(normalizeName(""), null);
  assert.equal(normalizeName("   "), null);
});

test("normalizeName rejects a name over MAX_TAG_LENGTH characters", () => {
  const { normalizeName, MAX_TAG_LENGTH } = loadBundle().__internal;
  assert.equal(MAX_TAG_LENGTH, 32);
  assert.equal(normalizeName("a".repeat(MAX_TAG_LENGTH)), "a".repeat(MAX_TAG_LENGTH));
  assert.equal(normalizeName("a".repeat(MAX_TAG_LENGTH + 1)), null);
});

test("normalizeName rejects non-string input", () => {
  const { normalizeName } = loadBundle().__internal;
  assert.equal(normalizeName(undefined), null);
  assert.equal(normalizeName(42), null);
});

test("normalizeColor accepts 6-digit and 3-digit hex, lowercased", () => {
  const { normalizeColor } = loadBundle().__internal;
  assert.equal(normalizeColor("#FF00AA"), "#ff00aa");
  assert.equal(normalizeColor("#f0a"), "#f0a");
});

test("normalizeColor rejects malformed or non-hex input", () => {
  const { normalizeColor } = loadBundle().__internal;
  assert.equal(normalizeColor("red"), null);
  assert.equal(normalizeColor("ff00aa"), null);
  assert.equal(normalizeColor("#ff00a"), null);
  assert.equal(normalizeColor(""), null);
  assert.equal(normalizeColor(null), null);
});

// -----------------------------------------------------------------------
// catalog helpers
// -----------------------------------------------------------------------

test("makeTagId returns a unique-looking string id each call", () => {
  const { makeTagId } = loadBundle().__internal;
  const a = makeTagId();
  const b = makeTagId();
  assert.notEqual(a, b);
  assert.match(a, /^tag-/);
});

test("nextPaletteColor cycles through PALETTE by catalog length", () => {
  const { nextPaletteColor, PALETTE } = loadBundle().__internal;
  assert.equal(nextPaletteColor([]), PALETTE[0]);
  assert.equal(nextPaletteColor(new Array(1)), PALETTE[1]);
  assert.equal(nextPaletteColor(new Array(PALETTE.length)), PALETTE[0]);
});

test("findTagByName / findTagById are case-insensitive-by-name and exact-by-id", () => {
  const { findTagByName, findTagById } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: "Urgent", color: "#fff" }];
  assert.equal(findTagByName(catalog, "urgent"), catalog[0]);
  assert.equal(findTagByName(catalog, "URGENT"), catalog[0]);
  assert.equal(findTagByName(catalog, "missing"), null);
  assert.equal(findTagById(catalog, "t1"), catalog[0]);
  assert.equal(findTagById(catalog, "missing"), null);
});

test("addCatalogTag creates a new tag with a default palette color", () => {
  const { addCatalogTag, PALETTE } = loadBundle().__internal;
  const result = addCatalogTag([], "urgent", null);
  assert.ok(result);
  assert.equal(result.catalog.length, 1);
  assert.equal(result.tag.name, "urgent");
  assert.equal(result.tag.color, PALETTE[0]);
  assert.ok(result.tag.id);
});

test("addCatalogTag honors an explicit valid hex color", () => {
  const { addCatalogTag } = loadBundle().__internal;
  const result = addCatalogTag([], "urgent", "#123456");
  assert.equal(result.tag.color, "#123456");
});

test("addCatalogTag returns null for an invalid name", () => {
  const { addCatalogTag } = loadBundle().__internal;
  assert.equal(addCatalogTag([], "   ", null), null);
});

test("addCatalogTag returns null when the name already exists case-insensitively", () => {
  const { addCatalogTag } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: "Urgent", color: "#fff" }];
  assert.equal(addCatalogTag(catalog, "URGENT", null), null);
});

test("updateCatalogTag renames a tag", () => {
  const { updateCatalogTag } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: "bug", color: "#fff" }];
  const next = updateCatalogTag(catalog, "t1", { name: "defect" });
  assert.equal(next[0].name, "defect");
  assert.equal(next[0].color, "#fff");
});

test("updateCatalogTag recolors a tag", () => {
  const { updateCatalogTag } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: "bug", color: "#fff" }];
  const next = updateCatalogTag(catalog, "t1", { color: "#123456" });
  assert.equal(next[0].color, "#123456");
});

test("updateCatalogTag is a no-op when renaming to another tag's existing name", () => {
  const { updateCatalogTag } = loadBundle().__internal;
  const catalog = [
    { id: "t1", name: "bug", color: "#fff" },
    { id: "t2", name: "urgent", color: "#000" },
  ];
  const next = updateCatalogTag(catalog, "t1", { name: "urgent" });
  assert.equal(next, catalog);
});

test("updateCatalogTag allows renaming a tag to its own current name", () => {
  const { updateCatalogTag } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: "Bug", color: "#fff" }];
  const next = updateCatalogTag(catalog, "t1", { name: "bug" });
  assert.equal(next[0].name, "bug");
});

test("updateCatalogTag is a no-op for an invalid color or missing id", () => {
  const { updateCatalogTag } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: "bug", color: "#fff" }];
  assert.equal(updateCatalogTag(catalog, "t1", { color: "not-a-color" }), catalog);
  assert.equal(updateCatalogTag(catalog, "missing", { name: "x" }), catalog);
});

test("removeCatalogTag drops the matching tag, no-ops when absent", () => {
  const { removeCatalogTag } = loadBundle().__internal;
  const catalog = [
    { id: "t1", name: "bug", color: "#fff" },
    { id: "t2", name: "urgent", color: "#000" },
  ];
  const next = removeCatalogTag(catalog, "t1");
  assertStructural.deepEqual(next.map((t) => t.id), ["t2"]);
  assert.equal(removeCatalogTag(catalog, "missing"), catalog);
});

// -----------------------------------------------------------------------
// task tag-id list helpers
// -----------------------------------------------------------------------

test("addTaskTagId appends, dedupes, and caps at MAX_TAGS_PER_TASK", () => {
  const { addTaskTagId, MAX_TAGS_PER_TASK } = loadBundle().__internal;
  assertStructural.deepEqual(addTaskTagId(["a"], "b"), ["a", "b"]);
  const tags = ["a"];
  assert.equal(addTaskTagId(tags, "a"), tags);
  const full = Array.from({ length: MAX_TAGS_PER_TASK }, (_, i) => "tag" + i);
  assert.equal(addTaskTagId(full, "one-too-many"), full);
});

test("removeTaskTagId drops a matching id, no-ops when absent", () => {
  const { removeTaskTagId } = loadBundle().__internal;
  assertStructural.deepEqual(removeTaskTagId(["a", "b"], "a"), ["b"]);
  const tags = ["a"];
  assert.equal(removeTaskTagId(tags, "missing"), tags);
});

test("resolveTag returns the catalog entry when found", () => {
  const { resolveTag } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: "bug", color: "#123456" }];
  assertStructural.deepEqual(resolveTag(catalog, "t1"), catalog[0]);
});

test("resolveTag falls back to a legacy plain-string tag (id as name, DEFAULT_COLOR)", () => {
  const { resolveTag, DEFAULT_COLOR } = loadBundle().__internal;
  const resolved = resolveTag([], "urgent");
  assertStructural.deepEqual(resolved, { id: "urgent", name: "urgent", color: DEFAULT_COLOR });
});

// -----------------------------------------------------------------------
// sanitize helpers
// -----------------------------------------------------------------------

test("sanitizeTagIdList drops non-string/empty entries and non-arrays", () => {
  const { sanitizeTagIdList } = loadBundle().__internal;
  assertStructural.deepEqual(sanitizeTagIdList([123, null, "", "valid", "  ok  "]), ["valid", "  ok  "]);
  assertStructural.deepEqual(sanitizeTagIdList(undefined), []);
  assertStructural.deepEqual(sanitizeTagIdList("not-an-array"), []);
});

test("sanitizeCatalog drops entries missing id/name/color", () => {
  const { sanitizeCatalog } = loadBundle().__internal;
  const valid = { id: "t1", name: "bug", color: "#fff" };
  const result = sanitizeCatalog([valid, { id: "t2" }, null, 42, "x"]);
  assertStructural.deepEqual(result, [valid]);
  assertStructural.deepEqual(sanitizeCatalog(undefined), []);
});

// -----------------------------------------------------------------------
// isConflictError / readModifyWrite
// -----------------------------------------------------------------------

test("isConflictError recognizes PluginStorageConflictError by name", () => {
  const { isConflictError } = loadBundle().__internal;
  const err = new Error("conflict");
  err.name = "PluginStorageConflictError";
  assert.equal(isConflictError(err), true);
  assert.equal(isConflictError(new Error("other")), false);
  assert.equal(isConflictError(null), false);
});

function makeConflictError() {
  const err = new Error("plugin storage: value was modified since ifUnmodifiedSince");
  err.name = "PluginStorageConflictError";
  return err;
}

function makeFakeStorage(initial) {
  let entry = initial !== undefined ? { value: initial, updatedAt: "t0" } : undefined;
  const calls = { set: [] };
  return {
    entry: () => entry,
    calls,
    get() {
      return Promise.resolve(entry);
    },
    set(scope, scopeId, key, value, options) {
      calls.set.push({ value, options });
      entry = { value, updatedAt: "t" + calls.set.length };
      return Promise.resolve({ updatedAt: entry.updatedAt });
    },
  };
}

test("readModifyWrite reads current value, applies mutate, and writes with ifUnmodifiedSince", async () => {
  const { readModifyWrite } = loadBundle().__internal;
  const storage = makeFakeStorage(["bug"]);
  const host = { storage };
  await readModifyWrite(host, "task", "task-1", "tags", "tags-chips", [], (current) =>
    current.concat(["urgent"]),
  );
  assert.equal(storage.calls.set.length, 1);
  assertStructural.deepEqual(storage.calls.set[0].value, ["bug", "urgent"]);
  assert.equal(storage.calls.set[0].options.ifUnmodifiedSince, "t0");
  assert.equal(storage.calls.set[0].options.writerId, "tags-chips");
});

test("readModifyWrite uses defaultValue when no entry exists yet", async () => {
  const { readModifyWrite } = loadBundle().__internal;
  const storage = makeFakeStorage(undefined);
  const host = { storage };
  await readModifyWrite(host, "workspace", "ws-1", "tags-catalog", "tags-manager", [], (current) =>
    current.concat(["new"]),
  );
  assertStructural.deepEqual(storage.calls.set[0].value, ["new"]);
  assert.equal(storage.calls.set[0].options.ifUnmodifiedSince, undefined);
});

test("readModifyWrite retries once on a conflict, reapplying mutate to the fresh value", async () => {
  const { readModifyWrite } = loadBundle().__internal;
  let entry = { value: ["bug"], updatedAt: "t0" };
  let setCallCount = 0;
  const host = {
    storage: {
      get() {
        return Promise.resolve(entry);
      },
      set(scope, scopeId, key, value) {
        setCallCount += 1;
        if (setCallCount === 1) {
          // Simulate a concurrent writer landing between our get and set.
          entry = { value: ["bug", "concurrent"], updatedAt: "t1" };
          return Promise.reject(makeConflictError());
        }
        entry = { value, updatedAt: "t2" };
        return Promise.resolve({ updatedAt: "t2" });
      },
    },
  };
  await readModifyWrite(host, "task", "task-1", "tags", "tags-picker", [], (current) =>
    current.concat(["urgent"]),
  );
  assert.equal(setCallCount, 2);
  assertStructural.deepEqual(entry.value, ["bug", "concurrent", "urgent"]);
});

test("readModifyWrite gives up and rethrows after exceeding the retry limit", async () => {
  const { readModifyWrite } = loadBundle().__internal;
  const host = {
    storage: {
      get() {
        return Promise.resolve({ value: ["bug"], updatedAt: "t0" });
      },
      set() {
        return Promise.reject(makeConflictError());
      },
    },
  };
  await assert.rejects(
    () => readModifyWrite(host, "task", "task-1", "tags", "tags-picker", [], (current) => current.concat(["urgent"])),
    (err) => err.name === "PluginStorageConflictError",
  );
});

// -----------------------------------------------------------------------
// initialize(registry, host): registration wiring
// -----------------------------------------------------------------------

function makeMinimalHost(overrides) {
  return Object.assign(
    {
      React: null,
      jsx: null,
      storage: {
        get: () => Promise.resolve(undefined),
        subscribe: () => () => {},
      },
      openModal: null,
      store: { getState: () => ({ activeWorkspaceId: "ws-1" }) },
    },
    overrides,
  );
}

test("bundle registers the task-card-tags slot, the main-top-bar button, and the add-tag menu action", () => {
  const registered = { components: [], menuActions: [] };
  const plugin = loadBundle();
  const host = makeMinimalHost();
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        registered.components.push({ slot, Component });
      },
      registerTaskMenuAction(registration) {
        registered.menuActions.push(registration);
      },
    },
    host,
  );
  assert.ok(registered.components.some((c) => c.slot === "task-card-tags"));
  assert.ok(registered.components.some((c) => c.slot === "main-top-bar"));
  const addTagAction = registered.menuActions.find((a) => a.id === "add-tag");
  assert.ok(addTagAction, "registers an add-tag menu action");
  // Stays under "edit" until the host ships the "primary" flat top-level
  // group -- see the NOTE in bundle.js next to this registration.
  assert.equal(addTagAction.group, "edit");
});

test("bundle registers a Tags task filter when the host supports registerTaskFilter", () => {
  const plugin = loadBundle();
  const host = makeMinimalHost();
  let filterRegistration = null;
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction() {},
      registerTaskFilter(registration) {
        filterRegistration = registration;
      },
    },
    host,
  );
  assert.ok(filterRegistration, "registers a task filter");
  assert.equal(filterRegistration.id, "tags");
  assert.equal(typeof filterRegistration.getOptions, "function");
  assert.equal(typeof filterRegistration.matches, "function");
  const options = filterRegistration.getOptions();
  assert.ok(options.some((o) => o.value === "__untagged__"));
});

test("bundle does not throw when the host predates registerTaskFilter (feature detection)", () => {
  const plugin = loadBundle();
  const host = makeMinimalHost();
  assert.doesNotThrow(() => {
    plugin.initialize(
      {
        registerComponent() {},
        registerTaskMenuAction() {},
        // no registerTaskFilter on this registry -- simulates an older host
      },
      host,
    );
  });
});

test("registerTaskFilter's matches() treats an unseen card as untagged", () => {
  const plugin = loadBundle();
  const host = makeMinimalHost();
  let filterRegistration = null;
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction() {},
      registerTaskFilter(registration) {
        filterRegistration = registration;
      },
    },
    host,
  );
  // No card has mounted TagChips for "task-never-seen" -- treated as untagged.
  assert.equal(
    filterRegistration.matches({ taskId: "task-never-seen" }, ["__untagged__"]),
    true,
  );
  assert.equal(filterRegistration.matches({ taskId: "task-never-seen" }, ["tag-1"]), false);
  assert.equal(filterRegistration.matches({ taskId: "task-never-seen" }, []), true);
});

/**
 * Minimal React-hooks-and-jsx stand-in sufficient to mount a plugin
 * component: useState/useEffect run against a single persistent state
 * array (mount runs effects once; state setters re-invoke the component),
 * and jsx() records the element tree as plain objects so tests can walk it.
 */
function makeFakeReactHost() {
  let hookIndex;
  const hookStates = [];
  let renderComponent = null;
  let tree;

  function rerender() {
    hookIndex = 0;
    tree = renderComponent();
  }

  const React = {
    useState(initial) {
      const i = hookIndex++;
      if (!(i in hookStates)) hookStates[i] = initial;
      const setState = (updater) => {
        hookStates[i] = typeof updater === "function" ? updater(hookStates[i]) : updater;
        rerender();
      };
      return [hookStates[i], setState];
    },
    useEffect(fn, deps) {
      const i = hookIndex++;
      if (!(i in hookStates)) {
        hookStates[i] = deps;
        fn();
      }
    },
  };
  const jsx = (type, props, ...children) => ({ type, props, children });

  return {
    React,
    jsx,
    mount(Component, props) {
      renderComponent = () => Component(props);
      rerender();
      return () => tree;
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("TagChips resolves catalog colors and stops propagation on remove", async () => {
  const plugin = loadBundle();
  let TagChips;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ activeWorkspaceId: "ws-1" }) };
  fakeHost.storage = {
    get(scope, scopeId, key) {
      if (scope === "task") return Promise.resolve({ value: ["t1"], updatedAt: "t0" });
      if (scope === "workspace") {
        return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
      }
      return Promise.resolve(undefined);
    },
    subscribe: () => () => {},
  };
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-card-tags") TagChips = Component;
      },
      registerTaskMenuAction() {},
    },
    fakeHost,
  );
  assert.ok(TagChips, "task-card-tags component registered");

  const getTree = fakeHost.mount(TagChips, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();

  const row = getTree();
  assert.ok(row, "chip row renders once tags finish loading");
  const chip = row.children[0][0];
  assert.equal(chip.children[0], "urgent");
  assert.equal(chip.props.style.background, "#ef4444");
  const removeButton = chip.children[1];
  assert.equal(removeButton.props["data-testid"], "kandev-tags-chip-remove");

  let stopped = false;
  removeButton.props.onClick({ stopPropagation: () => (stopped = true) });
  assert.ok(
    stopped,
    "remove button's onClick must call stopPropagation so it doesn't bubble into the card's click-to-open handler",
  );

  let pointerDownStopped = false;
  removeButton.props.onPointerDown({ stopPropagation: () => (pointerDownStopped = true) });
  assert.ok(pointerDownStopped, "remove button's onPointerDown must also call stopPropagation");
});

test("TagChips falls back to legacy plain-string tags (unresolved id) with DEFAULT_COLOR", async () => {
  const plugin = loadBundle();
  const { DEFAULT_COLOR } = plugin.__internal;
  let TagChips;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ activeWorkspaceId: "ws-1" }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: ["legacy-tag"], updatedAt: "t0" });
      return Promise.resolve({ value: [], updatedAt: "t0" }); // empty catalog
    },
    subscribe: () => () => {},
  };
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-card-tags") TagChips = Component;
      },
      registerTaskMenuAction() {},
    },
    fakeHost,
  );

  const getTree = fakeHost.mount(TagChips, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();

  const row = getTree();
  const chip = row.children[0][0];
  assert.equal(chip.children[0], "legacy-tag");
  assert.equal(chip.props.style.background, DEFAULT_COLOR);
});

test("TagChips renders nothing while loading or when there are no tags", async () => {
  const plugin = loadBundle();
  let TagChips;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ activeWorkspaceId: "ws-1" }) };
  fakeHost.storage = {
    get: () => Promise.resolve({ value: [], updatedAt: "t0" }),
    subscribe: () => () => {},
  };
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-card-tags") TagChips = Component;
      },
      registerTaskMenuAction() {},
    },
    fakeHost,
  );

  const getTree = fakeHost.mount(TagChips, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();
  assert.equal(getTree(), null);
});
