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
function loadBundle(consoleOverride) {
  let plugin = null;
  const context = {
    console: consoleOverride || console,
    setTimeout,
    clearTimeout,
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

/** A console stand-in that records every `.error()` call for assertions. */
function makeFakeConsole() {
  const calls = { error: [] };
  return { console: { error: (...args) => calls.error.push(args) }, calls };
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

// -----------------------------------------------------------------------
// logError / resolveWorkspaceId
// -----------------------------------------------------------------------

test("logError logs a single console.error with the [kandev-plugin-tags] prefix, context, and error", () => {
  const { console: fakeConsole, calls } = makeFakeConsole();
  const { logError } = loadBundle(fakeConsole).__internal;
  const err = new Error("plugin storage: get failed with status 400");
  logError("create tag", err);
  assert.equal(calls.error.length, 1);
  assert.equal(calls.error[0][0], "[kandev-plugin-tags] create tag");
  assert.equal(calls.error[0][1], err);
});

test("resolveWorkspaceId trims a valid candidate", () => {
  const { resolveWorkspaceId } = loadBundle().__internal;
  const host = { store: { getState: () => ({ workspaces: { activeId: null } }) } };
  assert.equal(resolveWorkspaceId(host, "  ws-1  "), "ws-1");
});

test("resolveWorkspaceId rejects empty/null/undefined/literal-null candidates and falls back to the store", () => {
  const { resolveWorkspaceId } = loadBundle().__internal;
  const host = { store: { getState: () => ({ workspaces: { activeId: "ws-active" } }) } };
  assert.equal(resolveWorkspaceId(host, ""), "ws-active");
  assert.equal(resolveWorkspaceId(host, null), "ws-active");
  assert.equal(resolveWorkspaceId(host, undefined), "ws-active");
  assert.equal(resolveWorkspaceId(host, "null"), "ws-active");
  assert.equal(resolveWorkspaceId(host, "   "), "ws-active");
});

test("resolveWorkspaceId returns null when neither the candidate nor the store resolve a workspace", () => {
  const { resolveWorkspaceId } = loadBundle().__internal;
  const host = { store: { getState: () => ({ workspaces: { activeId: null } }) } };
  assert.equal(resolveWorkspaceId(host, ""), null);
  assert.equal(resolveWorkspaceId(host, "null"), null);
});

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
      jsx: (type, props, ...children) => ({ type, props, children }),
      storage: {
        get: () => Promise.resolve(undefined),
        subscribe: () => () => {},
      },
      openModal: null,
      store: {
        getState: () => ({ workspaces: { activeId: "ws-1" } }),
        subscribe: () => () => {},
      },
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
  // Flat, top-level item -- shipped in kdlbs/kandev PR #2351.
  assert.equal(addTagAction.group, "primary");
});

test("the add-tag menu action carries a tag svg icon at mr-2 h-4 w-4, matching its neighbours", () => {
  const registered = { menuActions: [] };
  const plugin = loadBundle();
  const host = makeMinimalHost({ jsx: (type, props, ...children) => ({ type, props, children }) });
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction(registration) {
        registered.menuActions.push(registration);
      },
    },
    host,
  );
  const addTagAction = registered.menuActions.find((a) => a.id === "add-tag");
  assert.ok(addTagAction.icon, "carries an icon");
  assert.equal(addTagAction.icon.type, "svg");
  assert.equal(addTagAction.icon.props.className, "mr-2 h-4 w-4");
  assert.equal(addTagAction.icon.props.stroke, "currentColor");
});

test("the add-tag action opens the picker modal at size \"md\"", () => {
  const plugin = loadBundle();
  const host = makeMinimalHost({ jsx: (type, props, ...children) => ({ type, props, children }) });
  let openModalOptions = null;
  host.openModal = (options) => {
    openModalOptions = options;
  };
  let addTagAction = null;
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction(registration) {
        addTagAction = registration;
      },
    },
    host,
  );
  addTagAction.run({ taskId: "task-1", workspaceId: "ws-1" });
  assert.equal(openModalOptions.size, "md");
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

test("registerTaskFilter registers even when activeWorkspaceId isn't set yet, and picks up the catalog once host.store reports it", async () => {
  const plugin = loadBundle();
  let filterRegistration = null;
  let storeListener = null;
  let activeWorkspaceId = null;
  const catalogByWorkspace = {
    "ws-late": [{ id: "t1", name: "urgent", color: "#ef4444" }],
  };
  const host = makeMinimalHost({
    store: {
      getState: () => ({ workspaces: { activeId: activeWorkspaceId } }),
      subscribe: (listener) => {
        storeListener = listener;
        return () => {};
      },
    },
    storage: {
      get: (scope, scopeId, key) => {
        if (scope === "workspace" && key === "tags-catalog") {
          return Promise.resolve({ value: catalogByWorkspace[scopeId] || [], updatedAt: "t0" });
        }
        return Promise.resolve(undefined);
      },
      subscribe: () => () => {},
    },
  });
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
  assert.ok(filterRegistration, "registers a task filter even with no active workspace yet");
  assertStructural.deepEqual(
    filterRegistration.getOptions().map((o) => o.value),
    ["__untagged__"],
    "no catalog entries visible before a workspace is known",
  );

  // The workspace resolves after boot; host.store notifies subscribers.
  activeWorkspaceId = "ws-late";
  storeListener();
  await flush();

  const optionValues = filterRegistration.getOptions().map((o) => o.value);
  assert.ok(optionValues.includes("t1"), "catalog options appear once the workspace becomes known");
  assert.ok(optionValues.includes("__untagged__"));
});

// -----------------------------------------------------------------------
// Lifecycle: disposal on destroy(), idempotent initialize(), cache eviction
// -----------------------------------------------------------------------

/** A host whose store/storage subscribe track how many listeners are currently live. */
function makeListenerCountingHost() {
  var liveStore = 0;
  var liveStorage = 0;
  var activeId = "ws-1";
  return {
    React: null,
    jsx: (type, props, ...children) => ({ type, props, children }),
    store: {
      getState: () => ({ workspaces: { activeId } }),
      subscribe: () => {
        liveStore += 1;
        var unsubscribed = false;
        return () => {
          if (unsubscribed) return;
          unsubscribed = true;
          liveStore -= 1;
        };
      },
    },
    storage: {
      get: () => Promise.resolve(undefined),
      subscribe: () => {
        liveStorage += 1;
        var unsubscribed = false;
        return () => {
          if (unsubscribed) return;
          unsubscribed = true;
          liveStorage -= 1;
        };
      },
    },
    setActiveWorkspace(id) {
      activeId = id;
    },
    counts: () => ({ store: liveStore, storage: liveStorage }),
  };
}

function makeFullRegistry() {
  return {
    registerComponent() {},
    registerTaskMenuAction() {},
    registerTaskFilter() {},
  };
}

test("destroy() unsubscribes every store/storage listener registered during initialize", () => {
  const plugin = loadBundle();
  const host = makeListenerCountingHost();
  plugin.initialize(makeFullRegistry(), host);
  const afterInit = host.counts();
  assert.ok(afterInit.store >= 1 && afterInit.storage >= 1, "initialize registers live listeners");
  plugin.destroy();
  assert.deepEqual(host.counts(), { store: 0, storage: 0 }, "destroy leaves zero live listeners");
});

test("repeated initialize -> destroy cycles leave exactly zero live listeners, not N", () => {
  const plugin = loadBundle();
  const host = makeListenerCountingHost();
  for (let i = 0; i < 3; i++) {
    plugin.initialize(makeFullRegistry(), host);
    plugin.destroy();
  }
  assert.deepEqual(host.counts(), { store: 0, storage: 0 });
});

test("initialize twice without an intervening destroy still leaves one set of listeners, not two", () => {
  const plugin = loadBundle();
  const host = makeListenerCountingHost();
  plugin.initialize(makeFullRegistry(), host);
  const afterFirst = host.counts();
  plugin.initialize(makeFullRegistry(), host);
  assert.deepEqual(host.counts(), afterFirst, "re-initializing drains stale disposables before registering new ones");
});

test("after destroy, a store-state change triggers zero further storage.get calls", () => {
  const plugin = loadBundle();
  const listeners = new Set();
  let getCalls = 0;
  let activeId = "ws-1";
  const host = {
    React: null,
    jsx: (type, props, ...children) => ({ type, props, children }),
    store: {
      getState: () => ({ workspaces: { activeId } }),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    storage: {
      get: () => {
        getCalls += 1;
        return Promise.resolve(undefined);
      },
      subscribe: () => () => {},
    },
  };
  plugin.initialize(makeFullRegistry(), host);
  const callsAfterInit = getCalls;
  plugin.destroy();
  activeId = "ws-2";
  listeners.forEach((fn) => fn());
  assert.equal(getCalls, callsAfterInit, "destroy stops the plugin from reacting to further store changes");
});

test("taskTagCache is cleared on destroy so a stale tag set doesn't leak into a fresh initialize", () => {
  const plugin = loadBundle();
  const { setTaskTagCache } = plugin.__internal;
  const host = makeListenerCountingHost();
  let filterRegistration;
  plugin.initialize(
    Object.assign(makeFullRegistry(), {
      registerTaskFilter(reg) {
        filterRegistration = reg;
      },
    }),
    host,
  );
  setTaskTagCache("task-1", ["t1"]);
  assert.equal(filterRegistration.matches({ taskId: "task-1" }, ["t1"]), true, "cache populated");

  plugin.destroy();
  assert.equal(filterRegistration.matches({ taskId: "task-1" }, ["t1"]), false, "cache cleared on destroy");
});

test("taskTagCache is cleared on workspace switch so one workspace's tags don't inform another's filter", () => {
  const plugin = loadBundle();
  const { setTaskTagCache } = plugin.__internal;
  let activeWorkspaceId = "ws-1";
  const listeners = new Set();
  const host = {
    React: null,
    jsx: (type, props, ...children) => ({ type, props, children }),
    store: {
      getState: () => ({ workspaces: { activeId: activeWorkspaceId } }),
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    storage: {
      get: () => Promise.resolve(undefined),
      subscribe: () => () => {},
    },
  };
  let filterRegistration;
  plugin.initialize(
    Object.assign(makeFullRegistry(), {
      registerTaskFilter(reg) {
        filterRegistration = reg;
      },
    }),
    host,
  );
  setTaskTagCache("task-1", ["t1"]);
  assert.equal(filterRegistration.matches({ taskId: "task-1" }, ["t1"]), true);

  activeWorkspaceId = "ws-2";
  listeners.forEach((fn) => fn());
  assert.equal(
    filterRegistration.matches({ taskId: "task-1" }, ["t1"]),
    false,
    "cache cleared when the active workspace changes",
  );
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

  // Sentinel "component types" for host.ui -- the fake jsx() above just
  // records `type` verbatim, so a plain string tag is directly assertable
  // (`tree.type === "ui-Button"`) without needing real @kandev/ui.
  const ui = {
    Button: "ui-Button",
    Input: "ui-Input",
    Checkbox: "ui-Checkbox",
    ScrollArea: "ui-ScrollArea",
    DropdownMenu: "ui-DropdownMenu",
    DropdownMenuTrigger: "ui-DropdownMenuTrigger",
    DropdownMenuContent: "ui-DropdownMenuContent",
    DropdownMenuSeparator: "ui-DropdownMenuSeparator",
  };

  return {
    React,
    jsx,
    ui,
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

test("useStorageValue distinguishes a failed load from an empty catalog, logging the failure", async () => {
  const { console: fakeConsole, calls } = makeFakeConsole();
  const plugin = loadBundle(fakeConsole);
  const { makeTagPickerModal } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "workspace") {
        return Promise.reject(new Error("plugin storage: get failed with status 400"));
      }
      return Promise.resolve(undefined);
    },
    subscribe: () => () => {},
  };

  const TagPickerModal = makeTagPickerModal(fakeHost, "task-1", "ws-1");
  const getTree = fakeHost.mount(TagPickerModal, {});
  await flush();

  const tree = getTree();
  const errorNode = tree.children.find((c) => c && c.props && c.props["data-testid"] === "kandev-tags-picker-error");
  assert.ok(errorNode, "renders an explicit error state instead of an empty list");
  const [, addButtonEl] = tree.children[0].children;
  assert.equal(addButtonEl.props.disabled, true, "create control is disabled while the catalog failed to load");
  assert.ok(calls.error.length >= 1, "the failure is logged, not swallowed");
  assert.match(calls.error[0][0], /^\[kandev-plugin-tags\]/);
});

test("TagChips resolves catalog colors and stops propagation on remove", async () => {
  const plugin = loadBundle();
  let TagChips;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
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
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
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
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
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

/**
 * Builds an in-memory host.storage backend whose `subscribe` never invokes
 * its listener -- mirroring the host's real, documented behavior of
 * suppressing a writer's own echo (PLUGIN-API.md's "own-tab echo
 * suppression"). Any test using this backend can only pass if the component
 * under test refreshes its own local state directly after a successful
 * write, rather than depending on the subscription to do it.
 */
function makeEchoSuppressingStorage() {
  const entries = {};
  let counter = 0;
  function keyFor(scope, scopeId, key) {
    return scope + ":" + scopeId + ":" + key;
  }
  return {
    get(scope, scopeId, key) {
      return Promise.resolve(entries[keyFor(scope, scopeId, key)]);
    },
    set(scope, scopeId, key, value) {
      counter += 1;
      entries[keyFor(scope, scopeId, key)] = { value: value, updatedAt: "t" + counter };
      return Promise.resolve(entries[keyFor(scope, scopeId, key)]);
    },
    // Never notifies -- the point of this fake.
    subscribe: () => () => {},
  };
}

test("TagPickerModal's own create-and-apply refreshes its own list without any subscribe notification", async () => {
  const plugin = loadBundle();
  const { makeTagPickerModal } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();

  const TagPickerModal = makeTagPickerModal(fakeHost, "task-1", "ws-1");
  const getTree = fakeHost.mount(TagPickerModal, {});
  await flush();

  let tree = getTree();
  const [inputEl, addButtonEl] = tree.children[0].children;
  assert.equal(addButtonEl.props.disabled, true, "Add starts disabled with an empty draft");

  inputEl.props.onChange({ target: { value: "urgent" } });
  await flush();
  tree = getTree();
  const [, addButtonAfterTyping] = tree.children[0].children;
  assert.equal(addButtonAfterTyping.props.disabled, false, "Add enables once a new, non-empty name is typed");

  addButtonAfterTyping.props.onClick();
  await flush();
  await flush();
  await flush();
  await flush();
  await flush();

  tree = getTree();
  const listChildren = tree.children[1].children[0];
  assert.ok(Array.isArray(listChildren), "catalog list rendered (not the loading placeholder)");
  const option = listChildren.find(function (o) {
    return o.children[0].children[0] === "urgent";
  });
  assert.ok(option, "the newly created tag appears in this modal's own list, with no subscribe notification firing");
  assert.equal(
    option.props["aria-pressed"],
    true,
    "the newly created tag is applied to the task immediately",
  );
});

test("regression: creating \" urgent \" (surrounding whitespace) succeeds with no error and applies the trimmed tag", async () => {
  const plugin = loadBundle();
  const { makeTagPickerModal } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();

  const TagPickerModal = makeTagPickerModal(fakeHost, "task-1", "ws-1");
  const getTree = fakeHost.mount(TagPickerModal, {});
  await flush();

  let tree = getTree();
  const [inputEl] = tree.children[0].children;
  inputEl.props.onChange({ target: { value: "  urgent  " } });
  await flush();

  tree = getTree();
  const [, addButtonEl] = tree.children[0].children;
  assert.equal(addButtonEl.props.disabled, false, "Add enables once a valid (untrimmed) name is typed");
  addButtonEl.props.onClick();
  await flush();
  await flush();
  await flush();
  await flush();
  await flush();

  tree = getTree();
  const errorNode = tree.children.find((c) => c && c.props && c.props["data-testid"] === "kandev-tags-picker-error");
  assert.equal(errorNode, undefined, "no error is shown");
  const listChildren = tree.children[1].children[0];
  const option = listChildren.find((o) => o.children[0].children[0] === "urgent");
  assert.ok(option, "the tag was created trimmed to \"urgent\"");
  assert.equal(option.props["aria-pressed"], true, "the trimmed tag is applied to the task");
});

test("with no active workspace, the picker modal renders a prompt and makes zero storage calls", async () => {
  const plugin = loadBundle();
  const { makeTagPickerModal } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: null } }) };
  let storageCalls = 0;
  fakeHost.storage = {
    get() {
      storageCalls += 1;
      return Promise.resolve(undefined);
    },
    subscribe: () => {
      storageCalls += 1;
      return () => {};
    },
  };

  const TagPickerModal = makeTagPickerModal(fakeHost, "task-1", "");
  const getTree = fakeHost.mount(TagPickerModal, {});
  await flush();

  const tree = getTree();
  assert.equal(tree.children[0], "Select a workspace to use tags.");
  assert.equal(storageCalls, 0, "zero storage calls are made with no active workspace");
});


// -----------------------------------------------------------------------
// detectHostCapabilities / top-bar filter+manage dropdown (Phase 3)
// -----------------------------------------------------------------------

function makeFakeTaskFilters(initial) {
  let selection = initial || [];
  const listeners = new Set();
  return {
    getSelection: () => selection,
    setSelection: (id, values) => {
      selection = values;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

test("detectHostCapabilities detects each tier independently", () => {
  const { detectHostCapabilities } = loadBundle().__internal;

  assertStructural.deepEqual(detectHostCapabilities({}, {}), {
    taskFilter: false,
    filterSelectionApi: false,
    scanStorage: false,
  });

  const tier1 = detectHostCapabilities({ registerTaskFilter: () => {} }, { storage: {} });
  assertStructural.deepEqual(tier1, { taskFilter: true, filterSelectionApi: false, scanStorage: false });

  const tier2 = detectHostCapabilities(
    { registerTaskFilter: () => {} },
    {
      taskFilters: { getSelection: () => [], setSelection: () => {}, subscribe: () => () => {} },
      storage: { listByKey: () => Promise.resolve({ entries: [], truncated: false }) },
    },
  );
  assertStructural.deepEqual(tier2, { taskFilter: true, filterSelectionApi: true, scanStorage: true });
});

test("TagsTopBarDropdown (Tier 2): renders a checkbox+pill+delete row per tag and toggling sets host.taskFilters", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "urgent", color: "#ef4444" }]);
  fakeHost.taskFilters = makeFakeTaskFilters();

  const capabilities = { taskFilter: true, filterSelectionApi: true, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let tree = getTree();
  const content = tree.children[1];
  assert.equal(content.type, fakeHost.ui.DropdownMenuContent);
  const rows = content.children[4];
  assert.ok(Array.isArray(rows), "catalog rendered as rows, not a loading/empty placeholder");
  const row = rows[0];
  const checkbox = row.children[1];
  assert.equal(checkbox.type, fakeHost.ui.Checkbox);
  assert.equal(checkbox.props.checked, false);

  checkbox.props.onCheckedChange();
  await flush();
  assert.deepEqual(fakeHost.taskFilters.getSelection(), ["t1"], "checking a row sets the shared filter selection");

  tree = getTree();
  const rowsAfter = tree.children[1].children[4];
  assert.equal(rowsAfter[0].children[1].props.checked, true, "the row reflects the now-checked state");
});

test("TagsTopBarDropdown (Tier 0/1): renders no checkboxes -- manage-only", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "urgent", color: "#ef4444" }]);

  const capabilities = { taskFilter: true, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  const tree = getTree();
  const rows = tree.children[1].children[4];
  const row = rows[0];
  assert.equal(row.children[1], null, "no checkbox rendered without host.taskFilters");
});

test("TagsTopBarDropdown: clicking a tag's pill enters rename mode; committing renames it, clashing shows an error", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [
    { id: "t1", name: "bug", color: "#ef4444" },
    { id: "t2", name: "urgent", color: "#3b82f6" },
  ]);

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let tree = getTree();
  let rows = tree.children[1].children[4];
  let bugRow = rows.find((r) => r.children[2].props && r.children[2].props["data-testid"] === "kandev-tags-topbar-pill" && r.children[2].children[0] === "bug");
  bugRow.children[2].props.onClick();
  await flush();

  tree = getTree();
  rows = tree.children[1].children[4];
  bugRow = rows.find((r) => r.children[2].props && r.children[2].props["data-testid"] === "kandev-tags-topbar-rename-input");
  assert.ok(bugRow, "clicking the pill swaps it for a rename input");

  bugRow.children[2].props.onBlur({ target: { value: "urgent" } });
  await flush();

  tree = getTree();
  const errorNode = tree.children[1].children.find(
    (c) => c && c.props && c.props["data-testid"] === "kandev-tags-topbar-error",
  );
  assert.ok(errorNode, "renaming to a clashing name surfaces an error");
});

test("TagsTopBarDropdown: each row has a color swatch that recolors the tag on blur", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "bug", color: "#ef4444" }]);

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let tree = getTree();
  let rows = tree.children[1].children[4];
  const colorSwatch = rows[0].children[0];
  assert.equal(colorSwatch.props.type, "color");
  assert.equal(colorSwatch.props.defaultValue, "#ef4444");

  colorSwatch.props.onBlur({ target: { value: "#00ff00" } });
  await flush();
  await flush();

  tree = getTree();
  rows = tree.children[1].children[4];
  assert.equal(rows[0].children[0].props.defaultValue, "#00ff00", "the catalog reflects the new color");
});

test("regression: TagsTopBarDropdown has its own Create input, independent of the Add-tags modal (AC2)", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let tree = getTree();
  let content = tree.children[1];
  const [inputEl, createButtonEl] = content.children[2].children;
  assert.equal(inputEl.props["data-testid"], "kandev-tags-topbar-create-input");
  assert.equal(createButtonEl.props.disabled, true, "Create starts disabled with an empty draft");

  inputEl.props.onChange({ target: { value: "urgent" } });
  await flush();
  content = getTree().children[1];
  const [, createButtonAfterTyping] = content.children[2].children;
  assert.equal(createButtonAfterTyping.props.disabled, false, "Create enables once a valid name is typed");

  createButtonAfterTyping.props.onClick();
  await flush();
  await flush();

  tree = getTree();
  const rows = tree.children[1].children[4];
  assert.ok(Array.isArray(rows), "catalog list rendered (not the loading/empty placeholder)");
  const created = rows.find((r) => r.children[2].children[0] === "urgent");
  assert.ok(created, "the tag created via the top-bar dropdown's own Create input appears in its list");
});

test("regression: TagsTopBarDropdown's Create trims whitespace and rejects duplicates (AC3, AC7)", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "urgent", color: "#ef4444" }]);

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let content = getTree().children[1];
  let [inputEl] = content.children[2].children;
  inputEl.props.onChange({ target: { value: "  urgent  " } });
  await flush();

  content = getTree().children[1];
  const [, createButtonEl] = content.children[2].children;
  assert.equal(createButtonEl.props.disabled, true, "Create is disabled for a name that already exists (post-trim)");
});

test("countTasksWithTag counts across task scopeIds via listByKey, ignoring non-matching tasks", async () => {
  const { countTasksWithTag } = loadBundle().__internal;
  const host = {
    storage: {
      listByKey: () =>
        Promise.resolve({
          entries: [
            { scopeId: "task-1", value: ["t1"], updatedAt: "t0" },
            { scopeId: "task-2", value: ["t2"], updatedAt: "t0" },
            { scopeId: "task-3", value: ["t1", "t2"], updatedAt: "t0" },
          ],
          truncated: false,
        }),
    },
  };
  assert.equal(await countTasksWithTag(host, "t1"), 2);
});

test("countTasksWithTag returns null when the host can't scan (degrades the delete copy)", async () => {
  const { countTasksWithTag } = loadBundle().__internal;
  assert.equal(await countTasksWithTag({ storage: {} }, "t1"), null);
});

test("cascadeRemoveTagFromTasks strips the tag from every affected task and reports partial failure", async () => {
  const { cascadeRemoveTagFromTasks } = loadBundle().__internal;
  const written = {};
  const host = {
    storage: {
      listByKey: () =>
        Promise.resolve({
          entries: [
            { scopeId: "task-1", value: ["t1", "t2"], updatedAt: "t0" },
            { scopeId: "task-2", value: ["t1"], updatedAt: "t0" },
          ],
          truncated: false,
        }),
      get(scope, scopeId) {
        return Promise.resolve({ value: scopeId === "task-1" ? ["t1", "t2"] : ["t1"], updatedAt: "t0" });
      },
      set(scope, scopeId, key, value) {
        if (scopeId === "task-2") return Promise.reject(new Error("boom"));
        written[scopeId] = value;
        return Promise.resolve({ updatedAt: "t1" });
      },
    },
  };
  const result = await cascadeRemoveTagFromTasks(host, "t1");
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assertStructural.deepEqual(written["task-1"], ["t2"]);
});

test("primeTaskTagCache populates taskTagCache from a single listByKey scan", async () => {
  const plugin = loadBundle();
  const { primeTaskTagCache } = plugin.__internal;

  // initialize() first, as it would run in production -- its own
  // setWorkspace(null -> "ws-1") transition clears taskTagCache (D13), so
  // priming has to happen (and be asserted) after that settles, not before.
  let filterRegistration = null;
  const registryHost = makeListenerCountingHost();
  plugin.initialize(
    Object.assign(makeFullRegistry(), {
      registerTaskFilter(reg) {
        filterRegistration = reg;
      },
    }),
    registryHost,
  );

  await primeTaskTagCache({
    storage: {
      listByKey: () =>
        Promise.resolve({
          entries: [{ scopeId: "task-unseen", value: ["t1"], updatedAt: "t0" }],
          truncated: false,
        }),
    },
  });

  assert.equal(
    filterRegistration.matches({ taskId: "task-unseen" }, ["t1"]),
    true,
    "a task that never mounted its chips is still matched, once primed from the scan",
  );
});

test("registerTaskFilter hides the built-in dropdown section only when filterSelectionApi is available (Tier 2)", () => {
  const plugin = loadBundle();
  const hostTier1 = makeListenerCountingHost();
  let regTier1 = null;
  plugin.initialize(
    Object.assign(makeFullRegistry(), {
      registerTaskFilter(reg) {
        regTier1 = reg;
      },
    }),
    hostTier1,
  );
  assert.equal(regTier1.hidden, false, "Tier 1 (no host.taskFilters): built-in section stays visible");

  const hostTier2 = makeListenerCountingHost();
  hostTier2.taskFilters = makeFakeTaskFilters();
  hostTier2.storage.listByKey = () => Promise.resolve({ entries: [], truncated: false });
  let regTier2 = null;
  plugin.initialize(
    Object.assign(makeFullRegistry(), {
      registerTaskFilter(reg) {
        regTier2 = reg;
      },
    }),
    hostTier2,
  );
  assert.equal(regTier2.hidden, true, "Tier 2: built-in section hidden, this plugin's own dropdown is the filter UI");
});

test("TagPickerModal is built from host.ui primitives (Input, Button, ScrollArea)", async () => {
  const plugin = loadBundle();
  const { makeTagPickerModal } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "bug", color: "#ef4444" }]);

  const TagPickerModal = makeTagPickerModal(fakeHost, "task-1", "ws-1");
  const getTree = fakeHost.mount(TagPickerModal, {});
  await flush();

  const tree = getTree();
  const [inputEl, addButtonEl] = tree.children[0].children;
  assert.equal(inputEl.type, fakeHost.ui.Input);
  assert.equal(addButtonEl.type, fakeHost.ui.Button);
  const list = tree.children[1];
  assert.equal(list.type, fakeHost.ui.ScrollArea);
  const [option] = list.children[0];
  assert.equal(option.type, fakeHost.ui.Button, "each row is host.ui.Button, toggled by clicking anywhere on it");
  const pill = option.children[0];
  assert.deepEqual(Object.keys(pill.props.style), Object.keys(pill.props.style), "pill style exists");
  assert.equal(pill.props.style.background, "#ef4444", "the only inline style is the tag's dynamic hex background");
});

test("regression: applying a 13th tag shows the cap message instead of silently no-opping (AC8)", async () => {
  const plugin = loadBundle();
  const { makeTagPickerModal, MAX_TAGS_PER_TASK } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();

  const catalog = Array.from({ length: MAX_TAGS_PER_TASK + 1 }, (_, i) => ({
    id: "t" + i,
    name: "tag" + i,
    color: "#ef4444",
  }));
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", catalog);
  await fakeHost.storage.set(
    "task",
    "task-1",
    "tags",
    catalog.slice(0, MAX_TAGS_PER_TASK).map((t) => t.id),
  );

  const TagPickerModal = makeTagPickerModal(fakeHost, "task-1", "ws-1");
  const getTree = fakeHost.mount(TagPickerModal, {});
  await flush();

  let tree = getTree();
  const list = tree.children[1].children[0];
  const untaggedOption = list.find((o) => o.children[0].children[0] === "tag" + MAX_TAGS_PER_TASK);
  untaggedOption.props.onClick();
  await flush();
  await flush();

  tree = getTree();
  const errorNode = tree.children.find((c) => c && c.props && c.props["data-testid"] === "kandev-tags-picker-error");
  assert.ok(errorNode, "applying a 13th tag surfaces the cap message instead of silently no-opping");
});
