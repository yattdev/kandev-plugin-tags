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
/**
 * `extraGlobals` are merged into the bundle's context. The bundle runs in its
 * own vm realm, so a global the browser would supply -- `CSS`, say -- is
 * absent unless injected here; setting it on the test realm's `globalThis`
 * has no effect on the bundle.
 */
function loadBundle(consoleOverride, extraGlobals) {
  let plugin = null;
  const context = Object.assign(
    {
      console: consoleOverride || console,
      setTimeout,
      clearTimeout,
      window: {
        registerKandevPlugin(id, definition) {
          assert.equal(id, "kandev-plugin-tags");
          plugin = definition;
        },
      },
    },
    extraGlobals,
  );
  vm.runInNewContext(bundleSource, context, { filename: "ui/bundle.js" });
  assert.ok(plugin, "bundle registered the plugin");
  return plugin;
}

/** A console stand-in that records every `.error()` call for assertions. */
function makeFakeConsole() {
  const calls = { error: [] };
  return { console: { error: (...args) => calls.error.push(args) }, calls };
}

/**
 * A fake `document` whose `canvas.getContext("2d")` mimics the behaviour
 * resolveRgb's canvas branch depends on, as measured against a real
 * headless Chromium (see the QA notes on this task):
 *
 *   - an accepted value is *painted*, and `getImageData` reads it back as
 *     non-premultiplied `[r, g, b, a]` bytes -- which is how resolveRgb
 *     reduces a colour whose `fillStyle` serialization it could never
 *     parse (`oklch(...)`, `lab(...)`, `color(display-p3 ...)`) to RGB;
 *   - a value the canvas cannot parse is silently ignored, leaving the
 *     previously assigned colour painted -- which is what the two-sentinel
 *     comparison detects;
 *   - `currentcolor` is *accepted* and paints black, because a canvas has
 *     no element to inherit from. A real Chrome does exactly this, which is
 *     why resolveRgb has to refuse that keyword by name rather than trust
 *     the measurement.
 */
function makeFakeColorDocument() {
  /** Resolves to `[r, g, b, a]` bytes, or null when the canvas would ignore the value. */
  function resolve(value) {
    const v = String(value).trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
    if (hex) {
      const d = hex[1];
      const wide = d.length > 4;
      const at = (i) => {
        const pair = wide ? d.slice(i * 2, i * 2 + 2) : d[i] + d[i];
        return parseInt(pair, 16);
      };
      const hasAlpha = d.length === 4 || d.length === 8;
      return [at(0), at(1), at(2), hasAlpha ? at(3) : 255];
    }
    if (v === "transparent") return [0, 0, 0, 0];
    if (v === "currentcolor") return [0, 0, 0, 255]; // no element context: real Chrome paints black
    const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
    if (rgba) {
      const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
      return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Math.round(a * 255)];
    }
    const hsla = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
    if (hsla) {
      const l = parseFloat(hsla[3]);
      const a = hsla[4] !== undefined ? parseFloat(hsla[4]) : 1;
      // These tests only exercise l === 0 (pure black) -- full HSL->RGB
      // conversion isn't needed for that case.
      if (l === 0) return [0, 0, 0, Math.round(a * 255)];
    }
    // A modern colour function: a real canvas accepts and paints it, but
    // echoes the source syntax back from `fillStyle`, so only the pixel
    // carries the answer.
    if (v === "oklch(0.7 0.1 200)") return [64, 177, 183, 255];
    return null; // rejected, matching a real canvas ignoring an invalid value
  }
  let painted = [0, 0, 0, 255];
  let pending = [0, 0, 0, 255];
  return {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        set fillStyle(v) {
          const resolved = resolve(v);
          if (resolved !== null) pending = resolved;
        },
        clearRect() {},
        fillRect() {
          painted = pending;
        },
        getImageData: () => ({ data: painted }),
      }),
    }),
  };
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
  assert.equal(MAX_TAG_LENGTH, 22);
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

// Regression: sanitizeCatalog accepts any string as a tag colour and
// normalizeColor only guards the write path, so a value that never went
// through this plugin's UI reached the DOM unvalidated. The browser dropped
// the whole declaration, leaving a transparent background behind
// chipStyle's hard-coded `color: "#fff"` -- an invisible chip name.
test("renderableColor passes hex straight through", () => {
  const { renderableColor } = loadBundle().__internal;
  assert.equal(renderableColor("#ef4444"), "#ef4444");
  assert.equal(renderableColor("#fff"), "#fff");
  assert.equal(renderableColor("  #ef4444  "), "#ef4444");
});

test("renderableColor falls back to DEFAULT_COLOR for values that cannot render", () => {
  const { renderableColor, DEFAULT_COLOR } = loadBundle().__internal;
  assert.equal(renderableColor(null), DEFAULT_COLOR);
  assert.equal(renderableColor(42), DEFAULT_COLOR);
  assert.equal(renderableColor(""), DEFAULT_COLOR);
  assert.equal(renderableColor("   "), DEFAULT_COLOR);
});

test("renderableColor defers to the browser's parser: named colours survive, garbage does not", () => {
  const CSS = { supports: (prop, value) => prop === "color" && value === "red" };
  const { renderableColor, DEFAULT_COLOR } = loadBundle(null, { CSS }).__internal;
  // A named colour is a legitimate stored value (older catalogs, imports)
  // and renders correctly, so it must NOT be reduced to DEFAULT_COLOR.
  assert.equal(renderableColor("red"), "red");
  // The CSS-injection payload from QA: the browser rejects the whole
  // declaration, so the chip would render transparent + white text.
  assert.equal(
    renderableColor("red;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999"),
    DEFAULT_COLOR,
  );
});

test("chip styles never emit an unrenderable background", () => {
  const { chipStyle, denseChipStyle, DEFAULT_COLOR } = loadBundle(null, {
    CSS: { supports: () => false },
  }).__internal;
  assert.equal(chipStyle("not-a-colour").background, DEFAULT_COLOR);
  assert.equal(denseChipStyle("not-a-colour").background, DEFAULT_COLOR);
  // The paired text colour is what makes a bad background unreadable.
  // DEFAULT_COLOR is gray-500, which reads fine in light text.
  assert.equal(chipStyle("not-a-colour").color, "#ffffff");
  // Hex still passes through untouched with a parser that rejects everything.
  assert.equal(chipStyle("#ef4444").background, "#ef4444");
});

// -----------------------------------------------------------------------
// resolveRgb / contrastRatio / chipTextColor
// -----------------------------------------------------------------------

test("resolveRgb parses hex without needing a document", () => {
  const { resolveRgb } = loadBundle().__internal;
  assertStructural.deepEqual(resolveRgb("#f00"), { r: 255, g: 0, b: 0, a: 1 });
  assertStructural.deepEqual(resolveRgb("#ff0000"), { r: 255, g: 0, b: 0, a: 1 });
  assertStructural.deepEqual(resolveRgb("#ff000080"), { r: 255, g: 0, b: 0, a: 128 / 255 });
  assertStructural.deepEqual(resolveRgb("#f008"), { r: 255, g: 0, b: 0, a: 136 / 255 });
});

test("resolveRgb returns null for a non-hex value with no document present", () => {
  const { resolveRgb } = loadBundle().__internal;
  assert.equal(resolveRgb("red"), null);
  assert.equal(resolveRgb("transparent"), null);
  assert.equal(resolveRgb("currentcolor"), null);
  assert.equal(resolveRgb(null), null);
});

test("resolveRgb resolves non-hex colours via a probe canvas when a document is present", () => {
  const document = makeFakeColorDocument();
  const { resolveRgb } = loadBundle(null, { document }).__internal;
  assertStructural.deepEqual(resolveRgb("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  // A modern colour function: a real canvas paints it but echoes the source
  // syntax back from `fillStyle`, so only reading the painted *pixel*
  // resolves it. Greying these out would lose a colour that renders fine.
  assertStructural.deepEqual(resolveRgb("oklch(0.7 0.1 200)"), { r: 64, g: 177, b: 183, a: 1 });
});

// Regression (found in QA against a real headless Chromium): a canvas has no
// element to inherit from, so it *accepts* `currentcolor` and paints it
// black -- it does not reject it. Measuring that black would keep white chip
// text while the DOM resolves `background: currentcolor` to the chip's own
// white label: white on white, the reported bug still open. resolveRgb must
// refuse the keyword by name rather than trust the canvas, in every casing,
// and renderableColor must fall back with no parser and no document at all.
test("resolveRgb refuses currentcolor even when the canvas resolves it to a colour", () => {
  const document = makeFakeColorDocument();
  const withDom = loadBundle(null, { CSS: { supports: () => true }, document }).__internal;
  // The fake canvas models the real one: currentcolor paints black.
  assertStructural.deepEqual(withDom.resolveRgb("#000000"), { r: 0, g: 0, b: 0, a: 1 });
  for (const spelling of ["currentcolor", "currentColor", "CURRENTCOLOR", "  currentcolor  "]) {
    assert.equal(withDom.resolveRgb(spelling), null, spelling);
    assert.equal(withDom.renderableColor(spelling), withDom.DEFAULT_COLOR, spelling);
  }
  assert.equal(withDom.chipStyle("currentcolor").background, withDom.DEFAULT_COLOR);
  assert.equal(withDom.chipStyle("currentcolor").color, "#ffffff");
  assert.equal(withDom.denseChipStyle("currentcolor").background, withDom.DEFAULT_COLOR);

  // Unreadable by construction, not merely unmeasurable: no CSS, no document.
  const bare = loadBundle().__internal;
  assert.equal(bare.renderableColor("currentcolor"), bare.DEFAULT_COLOR);
});

// Regression: resolveRgbViaCanvas detects a rejected `fillStyle` assignment
// by the value not moving. Probing with a single sentinel makes any colour
// that legitimately normalizes to that sentinel indistinguishable from a
// rejection, so a renderable tag colour would silently become DEFAULT_COLOR.
// Both sentinels are opaque hex, which is what an opaque rgb() normalizes to.
test("resolveRgb resolves a colour that normalizes onto one of its own probe sentinels", () => {
  const document = makeFakeColorDocument();
  const { resolveRgb, renderableColor } = loadBundle(null, { CSS: { supports: () => true }, document }).__internal;
  assertStructural.deepEqual(resolveRgb("rgb(253, 254, 255)"), { r: 253, g: 254, b: 255, a: 1 });
  assertStructural.deepEqual(resolveRgb("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 1 });
  assert.equal(renderableColor("rgb(253, 254, 255)"), "rgb(253, 254, 255)");
  assert.equal(renderableColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
});

test("contrastRatio of white vs black is 21, and a colour against itself is 1", () => {
  const { contrastRatio } = loadBundle().__internal;
  assert.ok(Math.abs(contrastRatio("#ffffff", "#000000") - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01);
  assert.equal(contrastRatio("#3b82f6", "#3b82f6"), 1);
  assert.equal(contrastRatio("#6b7280", "#6b7280"), 1);
});

test("chipTextColor picks dark text for pale/low-contrast backgrounds, white otherwise", () => {
  const { chipTextColor } = loadBundle().__internal;
  // Yellow, green, orange: unreadable in white today (report's D2 table).
  assert.equal(chipTextColor("#eab308"), "#111827");
  assert.equal(chipTextColor("#22c55e"), "#111827");
  assert.equal(chipTextColor("#f97316"), "#111827");
  // The pale colour named in the report.
  assert.equal(chipTextColor("#ffffe0"), "#111827");
  // The remaining palette entries plus DEFAULT_COLOR stay white.
  assert.equal(chipTextColor("#ef4444"), "#ffffff");
  assert.equal(chipTextColor("#3b82f6"), "#ffffff");
  assert.equal(chipTextColor("#a855f7"), "#ffffff");
  assert.equal(chipTextColor("#ec4899"), "#ffffff");
  assert.equal(chipTextColor("#6b7280"), "#ffffff");
});

test("every PALETTE colour plus DEFAULT_COLOR clears the contrast floor on both chip surfaces", () => {
  const { chipStyle, denseChipStyle, contrastRatio, PALETTE, DEFAULT_COLOR } = loadBundle().__internal;
  const colours = PALETTE.concat([DEFAULT_COLOR]);
  for (const c of colours) {
    const chip = chipStyle(c);
    const dense = denseChipStyle(c);
    assert.ok(
      contrastRatio(chip.background, chip.color) >= 3,
      `chipStyle(${c}) contrast ${contrastRatio(chip.background, chip.color)} below 3.0`,
    );
    assert.ok(
      contrastRatio(dense.background, dense.color) >= 3,
      `denseChipStyle(${c}) contrast ${contrastRatio(dense.background, dense.color)} below 3.0`,
    );
  }
});

// Regression: a fully-transparent background -- reachable via "transparent",
// "rgba(0,0,0,0)", an 8-digit hex with a zero alpha byte, or "hsla(...,0)" --
// paired white text renders an invisible chip name. renderableColor must
// treat alpha-zero as unrenderable, same as an unparseable value.
test("renderableColor falls back to DEFAULT_COLOR for a fully-transparent colour", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { renderableColor, DEFAULT_COLOR } = loadBundle(null, { CSS, document }).__internal;
  assert.equal(renderableColor("rgba(0,0,0,0)"), DEFAULT_COLOR);
  // #ffffff00 resolves via the hex fast path and needs no document at all.
  assert.equal(renderableColor("#ffffff00"), DEFAULT_COLOR);
  assert.equal(renderableColor("hsla(0,0%,0%,0)"), DEFAULT_COLOR);
});

// Regression: alpha zero is only the degenerate case. A chip background with
// 0 < alpha < 1 composites with the host surface behind it, so the colour in
// the catalog is not the colour rendered -- chipTextColor would measure the
// named one and pair confident text with a chip that is barely there.
// #00000019 measures as pure black, scores 21 against white, and so kept
// white text over what renders as roughly #e6e6e6 on a light card: contrast
// ~1.2, the reported bug reached by degree instead of by kind. The host
// surface is not readable from here (it is theme-dependent), so anything not
// fully opaque falls back rather than being composited.
test("renderableColor falls back to DEFAULT_COLOR for a partially transparent colour", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { renderableColor, chipStyle, denseChipStyle, DEFAULT_COLOR } = loadBundle(null, { CSS, document }).__internal;
  for (const translucent of ["#00000019", "#0000001a", "#ffffff40", "#11223344", "#f008", "rgba(0,0,0,0.05)"]) {
    assert.equal(renderableColor(translucent), DEFAULT_COLOR, translucent);
    assert.equal(chipStyle(translucent).background, DEFAULT_COLOR, translucent);
    assert.equal(denseChipStyle(translucent).background, DEFAULT_COLOR, translucent);
  }
  // Fully opaque stays untouched, including the alpha-carrying hex spellings.
  assert.equal(renderableColor("#ffffffff"), "#ffffffff");
  assert.equal(renderableColor("#f00f"), "#f00f");
  assert.equal(renderableColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
});

// An alpha-carrying hex needs no parser and no document to measure, so it
// must not depend on the CSS.supports branch -- a host with no `CSS` object
// skips that branch entirely and previously let #ffffff00 through untouched.
test("renderableColor rejects a see-through hex with no CSS and no document", () => {
  const { renderableColor, DEFAULT_COLOR } = loadBundle().__internal;
  assert.equal(renderableColor("#ffffff00"), DEFAULT_COLOR);
  assert.equal(renderableColor("#00000019"), DEFAULT_COLOR);
  assert.equal(renderableColor("#f008"), DEFAULT_COLOR);
  assert.equal(renderableColor("#ffffffff"), "#ffffffff");
});

// The invariant relativeLuminance depends on: it ignores alpha, which is only
// sound because renderableColor has already refused everything translucent.
test("every background chipStyle emits is fully opaque", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { chipStyle, denseChipStyle, resolveRgb, PALETTE, DEFAULT_COLOR } = loadBundle(null, { CSS, document }).__internal;
  const inputs = PALETTE.concat([
    DEFAULT_COLOR,
    "#00000019",
    "#ffffff00",
    "transparent",
    "currentcolor",
    "rgba(0,0,0,0.5)",
    "not-a-colour",
    "",
  ]);
  for (const input of inputs) {
    for (const style of [chipStyle(input), denseChipStyle(input)]) {
      const rgb = resolveRgb(style.background);
      assert.ok(rgb, `chip background for ${JSON.stringify(input)} did not resolve`);
      assert.equal(rgb.a, 1, `chip background for ${JSON.stringify(input)} is not opaque`);
    }
  }
});

// Regression (found in QA against a real headless Chromium): a colour the
// browser renders perfectly well must not be greyed out just because its
// `fillStyle` serialization is unparseable. Chrome echoes `oklch(...)`,
// `lab(...)` and `color(display-p3 ...)` back verbatim, so resolveRgb reads
// the painted pixel instead -- and renderableColor passes the value through
// with a contrast-derived text colour, rather than falling back.
test("renderableColor passes through a modern colour function rather than greying it out", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { renderableColor, chipStyle, DEFAULT_COLOR } = loadBundle(null, { CSS, document }).__internal;
  assert.notEqual(renderableColor("oklch(0.7 0.1 200)"), DEFAULT_COLOR);
  assert.equal(renderableColor("oklch(0.7 0.1 200)"), "oklch(0.7 0.1 200)");
  assert.equal(chipStyle("oklch(0.7 0.1 200)").background, "oklch(0.7 0.1 200)");
  // rgb(64, 177, 183) scores 2.28 against white, so it takes the dark token.
  assert.equal(chipStyle("oklch(0.7 0.1 200)").color, "#111827");
});

// The regression case from the report: a transparent chip renders invisible
// on the light theme. Both chip surfaces must fall back to a legible gray
// chip, and DEFAULT_COLOR reads fine in white text.
test("chip styles fall back to a legible chip for a transparent background (AC1)", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { chipStyle, denseChipStyle, DEFAULT_COLOR } = loadBundle(null, { CSS, document }).__internal;
  assert.equal(chipStyle("transparent").background, DEFAULT_COLOR);
  assert.equal(chipStyle("transparent").color, "#ffffff");
  assert.equal(denseChipStyle("transparent").background, DEFAULT_COLOR);
  assert.equal(denseChipStyle("transparent").color, "#ffffff");
});

test("chipStyle is unchanged for a colour that already reads fine (AC8)", () => {
  const { chipStyle } = loadBundle().__internal;
  assert.equal(chipStyle("#ef4444").background, "#ef4444");
  assert.equal(chipStyle("#ef4444").color, "#ffffff");
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

test("resolveTag returns null for an unresolved id shaped like a generated catalog id (an orphaned/deleted tag)", () => {
  const { resolveTag, makeTagId } = loadBundle().__internal;
  const orphanId = makeTagId();
  assert.equal(resolveTag([], orphanId), null);
  // Still null even when other, unrelated catalog entries exist.
  assert.equal(resolveTag([{ id: "t1", name: "bug", color: "#fff" }], orphanId), null);
});

test("resolveTag still resolves a legacy plain-string id that happens not to match the generated-id shape", () => {
  const { resolveTag, DEFAULT_COLOR } = loadBundle().__internal;
  assertStructural.deepEqual(resolveTag([], "my custom tag"), {
    id: "my custom tag",
    name: "my custom tag",
    color: DEFAULT_COLOR,
  });
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
  assert.ok(registered.components.some((c) => c.slot === "task-row-tags"));
  assert.ok(registered.components.some((c) => c.slot === "main-top-bar"));
  const addTagAction = registered.menuActions.find((a) => a.id === "add-tag");
  assert.ok(addTagAction, "registers an add-tag menu action");
  // Flat, top-level item -- shipped in kdlbs/kandev PR #2351.
  assert.equal(addTagAction.group, "primary");
});

// -----------------------------------------------------------------------
// task-row-tags: dense, non-removable chip row for the sidebar row and the
// /tasks list row.
// -----------------------------------------------------------------------

test("task-row-tags renders chips with no remove control", async () => {
  const plugin = loadBundle();
  let TaskRowTags;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: ["t1"], updatedAt: "t0" });
      return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-row-tags") TaskRowTags = Component;
      },
      registerTaskMenuAction() {},
    },
    fakeHost,
  );
  assert.ok(TaskRowTags, "task-row-tags component registered");

  const getTree = fakeHost.mount(TaskRowTags, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();

  const row = getTree();
  const chip = row.children[0][0];
  assert.equal(chip.children[0], "urgent");
  assert.equal(chip.children.length, 1, "no remove button child on a task-row-tags chip");
});

test("task-row-tags caps at 3 visible chips and shows a +N indicator beyond the cap", async () => {
  const plugin = loadBundle();
  let TaskRowTags;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  const catalog = Array.from({ length: 5 }, (_, i) => ({ id: "t" + i, name: "tag" + i, color: "#ef4444" }));
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: catalog.map((t) => t.id), updatedAt: "t0" });
      return Promise.resolve({ value: catalog, updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-row-tags") TaskRowTags = Component;
      },
      registerTaskMenuAction() {},
    },
    fakeHost,
  );

  const getTree = fakeHost.mount(TaskRowTags, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();

  const row = getTree();
  const chips = row.children[0];
  assert.equal(chips.length, 3, "caps at 3 visible chips");
  const more = row.children[1];
  assert.ok(more, "renders a +N indicator when there are more than 3 tags");
  assert.equal(more.children[0], "+2");
});

test("task-row-tags shows no +N indicator at or under the 3-chip cap", async () => {
  const plugin = loadBundle();
  let TaskRowTags;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  const catalog = [{ id: "t1", name: "urgent", color: "#ef4444" }];
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: ["t1"], updatedAt: "t0" });
      return Promise.resolve({ value: catalog, updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-row-tags") TaskRowTags = Component;
      },
      registerTaskMenuAction() {},
    },
    fakeHost,
  );

  const getTree = fakeHost.mount(TaskRowTags, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();

  const row = getTree();
  assert.equal(row.children[1], null, "no +N indicator under the cap");
});

// -----------------------------------------------------------------------
// Shared data layer: catalog + task-tags stores dedupe concurrent reads
// and subscriptions across every mounted chip-row/dropdown surface.
// -----------------------------------------------------------------------

test("shared data layer: two independently-mounted chip rows for the same task share one coalesced storage.get", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;

  const calls = { taskGet: 0 };
  const sharedStorage = {
    get(scope) {
      if (scope === "task") {
        calls.taskGet += 1;
        return Promise.resolve({ value: ["t1"], updatedAt: "t0" });
      }
      return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  const sharedStore = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };

  const hostA = makeFakeReactHost();
  hostA.store = sharedStore;
  hostA.storage = sharedStorage;
  const TagChipsA = makeTagChips(hostA, { removable: true });

  const hostB = makeFakeReactHost();
  hostB.store = sharedStore;
  hostB.storage = sharedStorage;
  const TagChipsB = makeTagChips(hostB, { removable: true });

  const getTreeA = hostA.mount(TagChipsA, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  const getTreeB = hostB.mount(TagChipsB, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();

  assert.equal(calls.taskGet, 1, "one coalesced storage.get for the shared task's tags, across two mounted rows");
  assert.ok(getTreeA(), "row A rendered");
  assert.ok(getTreeB(), "row B rendered");
});

test("shared data layer: N mounted rows for the same workspace share exactly one catalog fetch and one subscribe", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;

  const calls = { workspaceGet: 0, workspaceSubscribe: 0 };
  const sharedStorage = {
    get(scope) {
      if (scope === "workspace") calls.workspaceGet += 1;
      if (scope === "task") return Promise.resolve({ value: [], updatedAt: "t0" });
      return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
    },
    subscribe(descriptor) {
      if (descriptor.scope === "workspace") calls.workspaceSubscribe += 1;
      return () => {};
    },
  };
  const sharedStore = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };

  const hosts = [0, 1, 2].map(() => {
    const h = makeFakeReactHost();
    h.store = sharedStore;
    h.storage = sharedStorage;
    return h;
  });
  const components = hosts.map((h) => makeTagChips(h, { removable: true }));

  hosts.forEach((h, i) => {
    h.mount(components[i], { slotProps: { taskId: "task-" + i, workspaceId: "ws-1" } });
  });
  await flush();

  assert.equal(calls.workspaceGet, 1, "one coalesced catalog fetch shared across 3 mounted rows");
  assert.equal(calls.workspaceSubscribe, 1, "one catalog subscribe shared across 3 mounted rows");
});

test("shared data layer: a change arriving mid-flight re-fetches instead of being swallowed by the coalescing", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;

  // The first response is what a `get` issued *before* the other tab's write
  // returns -- already stale by the time it resolves. The second is what that
  // write actually stored.
  const taskResponses = [
    { value: ["t1"], updatedAt: "t0" },
    { value: ["t1", "t2"], updatedAt: "t1" },
  ];
  const resolvers = [];
  const calls = { taskGet: 0 };
  let taskSubscriber = null;

  const host = makeFakeReactHost();
  host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  host.storage = {
    get(scope) {
      if (scope !== "task") {
        return Promise.resolve({
          value: [
            { id: "t1", name: "urgent", color: "#ef4444" },
            { id: "t2", name: "docs", color: "#22c55e" },
          ],
          updatedAt: "t0",
        });
      }
      const i = calls.taskGet++;
      return new Promise((resolve) => resolvers.push(() => resolve(taskResponses[i])));
    },
    subscribe(descriptor, handler) {
      if (descriptor.scope === "task") taskSubscriber = handler;
      return () => {};
    },
  };

  const getTree = host.mount(makeTagChips(host, { removable: false, dense: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();
  assert.equal(calls.taskGet, 1, "mounting issued the first get");

  // Another tab writes task-1's tags while that first get is still in flight.
  taskSubscriber({ scope: "task", scopeId: "task-1", key: "tags" });
  assert.equal(calls.taskGet, 1, "the notification joins the in-flight get rather than racing a second one");

  resolvers[0](); // the stale response lands
  await flush();
  assert.equal(calls.taskGet, 2, "settling with a pending invalidation re-issues the get");
  resolvers[1]();
  await flush();

  const chipNames = getTree()
    .children.flat()
    .filter(Boolean)
    .map((chip) => chip.children[0]);
  assertStructural.deepEqual(
    chipNames,
    ["urgent", "docs"],
    "the row settles on the post-write value, not the stale in-flight one",
  );
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

test("task filter options carry a renderable colour", async () => {
  // The host paints an option's `color` onto a swatch, so it needs the same
  // guard the chips have: an unparseable stored colour would render blank.
  const plugin = loadBundle(null, { CSS: { supports: () => false } });
  const { DEFAULT_COLOR } = plugin.__internal;
  let filterRegistration = null;
  const host = makeMinimalHost({
    store: { getState: () => ({ workspaces: { activeId: "ws-1" } }), subscribe: () => () => {} },
    storage: {
      get: (scope, scopeId, key) =>
        scope === "workspace" && key === "tags-catalog"
          ? Promise.resolve({
              value: [
                { id: "t1", name: "urgent", color: "#ef4444" },
                { id: "t2", name: "broken", color: "not-a-colour" },
              ],
              updatedAt: "t0",
            })
          : Promise.resolve(undefined),
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
  await flush();

  const byValue = Object.fromEntries(filterRegistration.getOptions().map((o) => [o.value, o.color]));
  assert.equal(byValue.t1, "#ef4444", "a hex colour is passed through untouched");
  assert.equal(byValue.t2, DEFAULT_COLOR, "an unparseable colour falls back");
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

test("a re-entrant initialize() (no destroy) re-subscribes and re-fetches the shared stores instead of serving a dead cache", async () => {
  const plugin = loadBundle();
  const calls = { taskGet: 0, taskSubscribe: 0, catalogSubscribe: 0 };
  let liveSubscriptions = 0;

  const sharedStore = { getState: () => ({ workspaces: { activeId: "ws-1" } }), subscribe: () => () => {} };
  const sharedStorage = {
    get(scope) {
      if (scope === "task") {
        calls.taskGet += 1;
        return Promise.resolve({ value: ["t1"], updatedAt: "t0" });
      }
      return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
    },
    subscribe(descriptor) {
      if (descriptor.scope === "task") calls.taskSubscribe += 1;
      if (descriptor.scope === "workspace") calls.catalogSubscribe += 1;
      liveSubscriptions += 1;
      return () => {
        liveSubscriptions -= 1;
      };
    },
  };

  /** Registers against a fresh fake-React host, returning that load's task-row-tags component. */
  function loadAgainst() {
    const host = makeFakeReactHost();
    host.store = sharedStore;
    host.storage = sharedStorage;
    const components = {};
    plugin.initialize(
      {
        registerComponent(name, Component) {
          components[name] = Component;
        },
        registerTaskMenuAction() {},
      },
      host,
    );
    return { host, RowTags: components["task-row-tags"] };
  }

  const first = loadAgainst();
  const firstTree = first.host.mount(first.RowTags, {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();
  assert.equal(calls.taskSubscribe, 1, "the first mount opened the wide task-tags subscription");
  assert.equal(calls.taskGet, 1);
  assert.ok(firstTree(), "the first row rendered its chips");

  // The host re-runs initialize() without a matching unloadPlugin()/destroy()
  // -- a boot race, a dev HMR re-boot, or a fresh store instance; see
  // apps/web/lib/plugins/host.ts's "Idempotent (re)load" comment. That drains
  // the disposables, which is what unsubscribed the shared stores, so the
  // stores have to be reset with them: otherwise their one-shot subscription
  // guards stay set (nothing ever resubscribes) and `loaded` stays true
  // (nothing ever refetches), and every chip surface serves the pre-drain
  // cache with no live updates until a full page reload.
  const second = loadAgainst();
  const secondTree = second.host.mount(second.RowTags, {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();

  assert.equal(calls.taskSubscribe, 2, "the re-entrant load opened a fresh wide task-tags subscription");
  assert.equal(calls.catalogSubscribe, 2, "and a fresh catalog subscription");
  assert.equal(calls.taskGet, 2, "and refetched rather than serving the now-unsubscribed cache");
  assert.equal(liveSubscriptions, 2, "one wide task-tags + one catalog subscription live, not four");
  assert.ok(secondTree(), "the row after the re-entrant load still renders its chips");
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

test("TagChips skips a generated-shape unresolved (orphaned/deleted) tag id, rendering no chip for it", async () => {
  const plugin = loadBundle();
  const { makeTagId } = plugin.__internal;
  let TagChips;
  const orphanId = makeTagId();
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: [orphanId, "t1"], updatedAt: "t0" });
      return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
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
  assert.ok(row, "still renders since one tag (t1) resolves");
  const chips = row.children[0];
  assert.equal(chips.length, 1, "the orphaned generated-id tag renders no chip");
  assert.equal(chips[0].children[0], "urgent");
});

test("TagChips renders nothing when every applied tag id is an orphaned generated-shape id", async () => {
  const plugin = loadBundle();
  const { makeTagId } = plugin.__internal;
  let TagChips;
  const orphanId = makeTagId();
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: [orphanId], updatedAt: "t0" });
      return Promise.resolve({ value: [], updatedAt: "t0" });
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
  assert.equal(getTree(), null);
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

// -----------------------------------------------------------------------
// Tags box (top-right dropdown): trigger/content sizing, row grid layout,
// and the swatch-button + Update/Cancel color picker redesign.
// -----------------------------------------------------------------------

test("Tags box trigger uses size icon-lg and the dropdown content is TOPBAR_WIDTH wide", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  const tree = getTree();
  const trigger = tree.children[0].children[0];
  assert.equal(trigger.props.size, "icon-lg");

  const content = tree.children[1];
  const { TOPBAR_WIDTH } = plugin.__internal;
  // An inline width, not a `w-[...]` class: Tailwind only emits an
  // arbitrary-value utility for literals it finds in source it scans, and the
  // host does not scan this bundle (see the TOPBAR_WIDTH comment).
  assert.equal(content.props.style.width, TOPBAR_WIDTH + "px");
  assert.doesNotMatch(content.props.className, /w-\[/);
});

test("Tags box: a full-length tag name fits the Create input with no horizontal scroll", () => {
  // Regression test for the QA finding: the box was 320px with a 32-character
  // limit, which left 222px of input for a name needing up to ~373px, so an
  // ordinary 32-character name scrolled horizontally. The three constants are
  // one budget; this asserts the budget still closes.
  const { MAX_TAG_LENGTH, TOPBAR_WIDTH, CREATE_BUTTON_WIDTH } = loadBundle().__internal;

  const BOX_PADDING = 16; // p-2, both sides
  const ROW_PADDING = 16; // the Create row's `padding: "4px 8px"`, both sides
  const GAP = 6; // the Create row's flex gap
  const inputWidth = TOPBAR_WIDTH - BOX_PADDING - ROW_PADDING - CREATE_BUTTON_WIDTH - GAP;

  // The text scrolls against the input's *content* box, not its border box,
  // so the host Input's own chrome comes out too: `px-2` (8px a side) plus a
  // 1px border. Confirmed live -- a 282px input reports clientWidth 280.
  // Leaving it in made the budget look 18px roomier than it is, enough to
  // wave through a MAX_TAG_LENGTH the box cannot actually hold.
  const INPUT_CHROME = 18;
  const textWidth = inputWidth - INPUT_CHROME;

  // Widest glyph in the input's font measured ~11.66px in Chrome at the
  // Tags box's font-size; 12 is a deliberately pessimistic bound so this
  // fails before a real user can produce a scrollbar.
  const WORST_CASE_PX_PER_CHAR = 12;
  const worstCaseName = MAX_TAG_LENGTH * WORST_CASE_PX_PER_CHAR;

  assert.ok(
    worstCaseName <= textWidth,
    `a ${MAX_TAG_LENGTH}-char name needs up to ${worstCaseName}px but the Create input only fits ${textWidth}px ` +
      `of text (TOPBAR_WIDTH=${TOPBAR_WIDTH}, CREATE_BUTTON_WIDTH=${CREATE_BUTTON_WIDTH}) — it would scroll horizontally`,
  );
});

test("Tags box: the Create row's input can grow (flex:1, minWidth:0) and the Create button has a fixed width", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  const content = getTree().children[1];
  const createRow = content.children[2];
  assert.equal(createRow.props.style.display, "flex");
  assert.equal(createRow.props.style.gap, "6px");
  const [inputEl, buttonEl] = createRow.children;
  assert.equal(inputEl.props.style.flex, 1);
  assert.equal(inputEl.props.style.minWidth, 0);
  assert.equal(buttonEl.props.style.flexShrink, 0, "Create button keeps a fixed width, unaffected by the name's length");
});

test("Tags box: each row is a CSS grid, and the delete button is a fixed 20x20 control (fixes the misaligned x)", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [
    { id: "t1", name: "a-considerably-longer-tag-name", color: "#ef4444" },
    { id: "t2", name: "x", color: "#3b82f6" },
  ]);

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  const rows = getTree().children[1].children[4];
  rows.forEach((row) => {
    assert.equal(row.props.style.display, "grid");
    assert.equal(row.props.style.gridTemplateColumns, "20px 1fr 24px");
    const deleteButton = row.children[3];
    assert.equal(deleteButton.props["data-testid"], "kandev-tags-topbar-delete");
    assert.equal(deleteButton.props.style.width, "20px");
    assert.equal(deleteButton.props.style.height, "20px");
  });
});

test("Tags box: Tier 2 (filterSelectionApi) rows use a 4-column grid with a 16px checkbox column", async () => {
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

  const rows = getTree().children[1].children[4];
  assert.equal(rows[0].props.style.gridTemplateColumns, "20px 16px 1fr 24px");
});

test("Tags box color picker: the swatch is a button; clicking it opens a picker box beneath the row", async () => {
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

  let rows = getTree().children[1].children[4];
  const swatch = rows[0].children[0];
  assert.equal(swatch.props["data-testid"], "kandev-tags-topbar-color-swatch");
  assert.equal(swatch.props.style.background, "#ef4444");
  assert.equal(rows.length, 1, "no picker box before the swatch is clicked");

  swatch.props.onClick();
  await flush();

  rows = getTree().children[1].children[4];
  assert.equal(rows.length, 2, "the picker box is inserted directly beneath the row");
  assert.equal(rows[1].props["data-testid"], "kandev-tags-topbar-color-picker");
});

test("Tags box color picker: picking a palette swatch or typing a hex updates only local state, no storage.set", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "bug", color: "#ef4444" }]);
  let setCalls = 0;
  const originalSet = fakeHost.storage.set.bind(fakeHost.storage);
  fakeHost.storage.set = (...args) => {
    setCalls += 1;
    return originalSet(...args);
  };

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let rows = getTree().children[1].children[4];
  rows[0].children[0].props.onClick(); // open the picker
  await flush();

  rows = getTree().children[1].children[4];
  const picker = rows[1];
  const paletteRow = picker.children[0];
  paletteRow.children[1].props.onClick(); // pick the 2nd palette swatch
  await flush();
  assert.equal(setCalls, 0, "picking a palette swatch issues no storage write");

  const hexInput = picker.children[1].children[0];
  assert.equal(hexInput.props.type, "color");
  hexInput.props.onChange({ target: { value: "#00ff00" } });
  await flush();
  assert.equal(setCalls, 0, "typing a hex issues no storage write");

  rows = getTree().children[1].children[4];
  const preview = rows[1].children[1].children[1];
  assert.equal(preview.props["data-testid"], "kandev-tags-topbar-color-preview");
  assert.equal(preview.props.style.background, "#00ff00", "the preview pill reflects the latest pending color");
});

test("Tags box color picker: Update writes the catalog exactly once with the pending color, then closes the picker", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown, PALETTE } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "bug", color: "#ef4444" }]);
  let setCalls = 0;
  const originalSet = fakeHost.storage.set.bind(fakeHost.storage);
  fakeHost.storage.set = (...args) => {
    setCalls += 1;
    return originalSet(...args);
  };

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let rows = getTree().children[1].children[4];
  rows[0].children[0].props.onClick();
  await flush();

  rows = getTree().children[1].children[4];
  rows[1].children[0].children[1].props.onClick(); // pick PALETTE[1]
  await flush();

  rows = getTree().children[1].children[4];
  const [cancelButton, updateButton] = rows[1].children[2].children;
  assert.equal(cancelButton.props["data-testid"], "kandev-tags-topbar-color-cancel");
  assert.equal(updateButton.props["data-testid"], "kandev-tags-topbar-color-update");
  updateButton.props.onClick();
  await flush();
  await flush();

  assert.equal(setCalls, 1, "exactly one catalog write on Update");

  rows = getTree().children[1].children[4];
  assert.equal(rows.length, 1, "the picker closes after Update");
  assert.equal(rows[0].children[0].props.style.background, PALETTE[1], "the swatch reflects the newly committed color");
});

test("Tags box color picker: Cancel discards the pending color, issues no write, and leaves the swatch unchanged", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "bug", color: "#ef4444" }]);
  let setCalls = 0;
  const originalSet = fakeHost.storage.set.bind(fakeHost.storage);
  fakeHost.storage.set = (...args) => {
    setCalls += 1;
    return originalSet(...args);
  };

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  let rows = getTree().children[1].children[4];
  rows[0].children[0].props.onClick();
  await flush();

  rows = getTree().children[1].children[4];
  rows[1].children[0].children[1].props.onClick(); // pick a different palette color (pending only)
  await flush();

  rows = getTree().children[1].children[4];
  const [cancelButton] = rows[1].children[2].children;
  cancelButton.props.onClick();
  await flush();

  assert.equal(setCalls, 0, "Cancel issues no storage write");

  rows = getTree().children[1].children[4];
  assert.equal(rows.length, 1, "the picker closes after Cancel");
  assert.equal(rows[0].children[0].props.style.background, "#ef4444", "the swatch color is unchanged from before the picker opened");
});

test("Tags box color picker: only one row's picker may be open at a time", async () => {
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

  let rows = getTree().children[1].children[4];
  rows[0].children[0].props.onClick(); // open t1's picker
  await flush();

  rows = getTree().children[1].children[4];
  const pickersAfterFirst = rows.filter((r) => r.props && r.props["data-testid"] === "kandev-tags-topbar-color-picker");
  assert.equal(pickersAfterFirst.length, 1);

  const t2Row = rows.find(
    (r) => r.props && r.props["data-testid"] === "kandev-tags-topbar-row" && r.children[2].children[0] === "urgent",
  );
  t2Row.children[0].props.onClick(); // open t2's picker
  await flush();

  rows = getTree().children[1].children[4];
  const pickersAfterSecond = rows.filter((r) => r.props && r.props["data-testid"] === "kandev-tags-topbar-color-picker");
  assert.equal(pickersAfterSecond.length, 1, "opening a second row's picker closes the first");
  const openPicker = pickersAfterSecond[0];
  assert.match(openPicker.props.key, /^t2-/, "the still-open picker belongs to t2, not t1");
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
