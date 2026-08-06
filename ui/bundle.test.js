"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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

test("normalizeTag trims whitespace", () => {
  const { normalizeTag } = loadBundle().__internal;
  assert.equal(normalizeTag("  urgent  "), "urgent");
});

test("normalizeTag rejects an empty or whitespace-only string", () => {
  const { normalizeTag } = loadBundle().__internal;
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag("   "), null);
});

test("normalizeTag rejects a tag over MAX_TAG_LENGTH characters", () => {
  const { normalizeTag, MAX_TAG_LENGTH } = loadBundle().__internal;
  assert.equal(normalizeTag("a".repeat(MAX_TAG_LENGTH)), "a".repeat(MAX_TAG_LENGTH));
  assert.equal(normalizeTag("a".repeat(MAX_TAG_LENGTH + 1)), null);
});

test("normalizeTag rejects non-string input", () => {
  const { normalizeTag } = loadBundle().__internal;
  assert.equal(normalizeTag(undefined), null);
  assert.equal(normalizeTag(42), null);
});

test("addTag appends a new, valid tag", () => {
  const { addTag } = loadBundle().__internal;
  assert.deepEqual(addTag(["bug"], "urgent"), ["bug", "urgent"]);
});

test("addTag trims the raw value before storing it", () => {
  const { addTag } = loadBundle().__internal;
  assert.deepEqual(addTag([], "  urgent  "), ["urgent"]);
});

test("addTag is a no-op for an empty/invalid tag", () => {
  const { addTag } = loadBundle().__internal;
  const tags = ["bug"];
  assert.equal(addTag(tags, "   "), tags);
  assert.equal(addTag(tags, ""), tags);
});

test("addTag dedupes case-insensitively and returns the same reference", () => {
  const { addTag } = loadBundle().__internal;
  const tags = ["Urgent"];
  assert.equal(addTag(tags, "urgent"), tags);
  assert.equal(addTag(tags, "URGENT"), tags);
});

test("addTag refuses to grow past MAX_TAGS", () => {
  const { addTag, MAX_TAGS } = loadBundle().__internal;
  const full = Array.from({ length: MAX_TAGS }, (_, i) => "tag" + i);
  assert.equal(addTag(full, "one-too-many"), full);
  assert.equal(full.length, MAX_TAGS);
});

test("removeTag drops a matching tag case-insensitively", () => {
  const { removeTag } = loadBundle().__internal;
  assert.deepEqual(removeTag(["Bug", "urgent"], "BUG"), ["urgent"]);
});

test("removeTag is a no-op when the tag isn't present", () => {
  const { removeTag } = loadBundle().__internal;
  assert.deepEqual(removeTag(["bug"], "missing"), ["bug"]);
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
  let entry = initial ? { value: initial, updatedAt: "t0" } : undefined;
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

test("readModifyWrite reads current tags, applies mutate, and writes with ifUnmodifiedSince", async () => {
  const { readModifyWrite } = loadBundle().__internal;
  const storage = makeFakeStorage(["bug"]);
  const host = { storage };
  await readModifyWrite(host, "task-1", "tags-chips", (current) => current.concat(["urgent"]));
  assert.equal(storage.calls.set.length, 1);
  assert.deepEqual(storage.calls.set[0].value, ["bug", "urgent"]);
  assert.equal(storage.calls.set[0].options.ifUnmodifiedSince, "t0");
  assert.equal(storage.calls.set[0].options.writerId, "tags-chips");
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
  await readModifyWrite(host, "task-1", "tags-modal", (current) => current.concat(["urgent"]));
  assert.equal(setCallCount, 2);
  assert.deepEqual(entry.value, ["bug", "concurrent", "urgent"]);
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
    () => readModifyWrite(host, "task-1", "tags-modal", (current) => current.concat(["urgent"])),
    (err) => err.name === "PluginStorageConflictError",
  );
});

test("bundle registers the task-card-tags slot and the add-tag menu action", () => {
  const registered = { components: [], menuActions: [] };
  const plugin = loadBundle();
  const host = { React: null, jsx: null, storage: null, openModal: null };
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
  const addTagAction = registered.menuActions.find((a) => a.id === "add-tag");
  assert.ok(addTagAction, "registers an add-tag menu action");
  assert.equal(addTagAction.group, "edit");
});
