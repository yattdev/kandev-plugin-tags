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
  const mergedGlobals = Object.assign({}, extraGlobals);
  const defaultWindow = {
    registerKandevPlugin(id, definition) {
      assert.equal(id, "kandev-plugin-tags");
      plugin = definition;
    },
  };
  mergedGlobals.window = Object.assign(defaultWindow, (extraGlobals && extraGlobals.window) || {});
  const context = Object.assign(
    {
      console: consoleOverride || console,
      setTimeout,
      clearTimeout,
    },
    mergedGlobals,
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

/** Matches the structured status/body fields exposed by the host's ApiError. */
function apiError(status, message, body) {
  const err = new Error(message || "request failed with status " + status);
  err.name = "ApiError";
  err.status = status;
  err.body = body === undefined ? { error: err.message } : body;
  return err;
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
    // CSS system colours, measured in Chromium: a detached canvas has no
    // `color-scheme`, so it resolves every one of them in the light scheme
    // and reports that as confidently as any other colour. The chip resolves
    // the same keyword against its own inherited scheme -- which is why
    // renderableColor hands back what it measured instead of the keyword.
    if (v === "canvas" || v === "field") return [255, 255, 255, 255];
    if (v === "canvastext") return [0, 0, 0, 255];
    // Nested `currentcolor`, measured in Chromium: a canvas *accepts* the
    // keyword inside a colour function and resolves it against its own
    // (elementless) context -- black -- so these come back as confident,
    // opaque colours rather than as rejections, exactly like the bare
    // keyword above. Only refusing the keyword by name catches them.
    if (v === "color-mix(in srgb, currentcolor 50%, white)") return [128, 128, 128, 255];
    if (v === "color-mix(in srgb, currentcolor, #ffffff)") return [128, 128, 128, 255];
    if (v === "rgb(from currentcolor r g b)") return [0, 0, 0, 255];
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

// Regression (measured in Chromium): the keyword guard was anchored to the
// whole value, so `currentcolor` nested inside a colour function slipped
// past it. The canvas resolves the nesting confidently -- against its own
// elementless context, i.e. black -- so nothing downstream had reason to
// doubt it, while the DOM resolves it against the chip's own `color`, which
// chipStyle sets. Measured before this guard, on both the light and the dark
// host theme: `color-mix(in srgb, currentcolor 50%, white)` rendered
// `background: color(srgb 1 1 1)` under `color: #ffffff`, and
// `rgb(from currentcolor r g b)` did the same -- white text on a white chip,
// contrast 1.00. That is the reported bug, reached by nesting.
test("renderableColor refuses currentcolor nested inside a colour function", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { renderableColor, resolveRgb, chipStyle, denseChipStyle, DEFAULT_COLOR } = loadBundle(null, {
    CSS,
    document,
  }).__internal;
  for (const nested of [
    "color-mix(in srgb, currentcolor 50%, white)",
    "color-mix(in srgb, currentColor, #ffffff)",
    "rgb(from currentcolor r g b)",
  ]) {
    // The fake models the measured canvas: these resolve, they are not rejected.
    assert.equal(resolveRgb(nested), null, nested);
    assert.equal(renderableColor(nested), DEFAULT_COLOR, nested);
    assert.equal(chipStyle(nested).background, DEFAULT_COLOR, nested);
    assert.equal(denseChipStyle(nested).background, DEFAULT_COLOR, nested);
  }
  // Token-bounded, so a colour that merely renders fine is not swept up.
  assert.notEqual(renderableColor("oklch(0.7 0.1 200)"), DEFAULT_COLOR);
  assert.equal(renderableColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
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

test("chipTextColor selects readable text for nuanced palette and pale custom colors", () => {
  const { chipTextColor, PALETTE, DEFAULT_COLOR } = loadBundle().__internal;
  assert.ok(PALETTE.length >= 12, "the generated palette should offer nuanced hue choices");
  for (const color of PALETTE) {
    assert.equal(chipTextColor(color), "#ffffff", `${color} should use white text`);
  }
  assert.equal(chipTextColor(DEFAULT_COLOR), "#ffffff");
  assert.equal(chipTextColor("#ffffe0"), "#111827");
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

// Where the opacity cutoff actually lands. Alpha is quantised to a byte
// everywhere it is measured -- both the hex path here and `getImageData` in a
// browser -- so `0xfe` is the last value distinguishable from opaque and
// `0xff` is opaque. Confirmed against a real headless Chromium, where
// `rgba(0,0,0,0.998)` reads back alpha 0.996 (rejected) and
// `rgba(0,0,0,0.999)` reads back exactly 1 (passes). Locked here because the
// DOM-less harness is the only place CI can assert it.
test("the opacity cutoff sits on the alpha byte, not on a fractional threshold", () => {
  const { renderableColor, DEFAULT_COLOR } = loadBundle().__internal;
  assert.equal(renderableColor("#000000ff"), "#000000ff");
  assert.equal(renderableColor("#000000fe"), DEFAULT_COLOR);
  assert.equal(renderableColor("#00000001"), DEFAULT_COLOR);
  assert.equal(renderableColor("#00000000"), DEFAULT_COLOR);
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
// the painted pixel instead -- and renderableColor keeps the colour, with a
// contrast-derived text colour, rather than falling back.
//
// It keeps the *colour*, not the authored string: the value comes back as the
// measured `rgb(...)`, so what the chip paints is what chipTextColor measured
// (see the system-colour regression below). rgb(64, 177, 183) is the same
// colour oklch(0.7 0.1 200) renders as on an sRGB display.
test("renderableColor keeps a modern colour function rather than greying it out", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { renderableColor, chipStyle, DEFAULT_COLOR } = loadBundle(null, { CSS, document }).__internal;
  assert.notEqual(renderableColor("oklch(0.7 0.1 200)"), DEFAULT_COLOR);
  assert.equal(renderableColor("oklch(0.7 0.1 200)"), "rgb(64, 177, 183)");
  assert.equal(chipStyle("oklch(0.7 0.1 200)").background, "rgb(64, 177, 183)");
  // rgb(64, 177, 183) scores 2.28 against white, so it takes the dark token.
  assert.equal(chipStyle("oklch(0.7 0.1 200)").color, "#111827");
});

// Regression (measured in Chromium): the probe canvas is detached, so it has
// no `color-scheme` and resolves every CSS system colour in the light scheme.
// The chip resolves the same keyword against its own inherited scheme, so
// with the authored value passed through, the contrast pass measured one
// colour and the browser painted another. Measured under `color-scheme: dark`
// with pass-through, versus the hard-coded white this branch replaced:
//
//   Canvas      18.73 -> 1.06   (#111827 text on rgb(18,18,18))
//   Field       11.20 -> 1.58
//   CanvasText   1.00 -> 1.00   (already broken)
//
// Handing back the measured rgb() binds the painted colour to the measured
// one, so the chip is legible on both themes -- and it needs no list of
// system-colour keywords, which differ per browser.
test("renderableColor normalizes a context-dependent colour to what it measured", () => {
  const CSS = { supports: () => true };
  const document = makeFakeColorDocument();
  const { renderableColor, chipStyle, contrastRatio } = loadBundle(null, { CSS, document }).__internal;
  // The fake models the measured canvas: system colours resolve light-scheme.
  assert.equal(renderableColor("Canvas"), "rgb(255, 255, 255)");
  assert.equal(renderableColor("CanvasText"), "rgb(0, 0, 0)");
  for (const systemColour of ["Canvas", "CanvasText", "Field"]) {
    const chip = chipStyle(systemColour);
    // No longer a keyword, so it cannot re-resolve against the chip's theme.
    assert.ok(/^rgb\(\d+, \d+, \d+\)$/.test(chip.background), `${systemColour} -> ${chip.background}`);
    assert.ok(
      contrastRatio(chip.background, chip.color) >= 3,
      `${systemColour} contrast ${contrastRatio(chip.background, chip.color)} below 3.0`,
    );
  }
  // Normalising is idempotent on a colour already in that form.
  assert.equal(renderableColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
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

// The color of a name is a cross-language contract, not an implementation
// detail: a tag created in the Tags box and the same name created by an agent
// through create_tag have to come out identical. This file and
// server/agent_tags_test.go assert the *same* pairs from
// testdata/tag-colors.json, so changing one hash alone fails one suite or the
// other. The names cover 1-, 2-, 3- and 4-byte UTF-8 sequences, the
// 22-character cap, a pair that deliberately collides, and the empty string;
// lone surrogates are not among them, because a JSON fixture cannot carry one
// honestly -- they are pinned by the dedicated cases below (colorFromName's
// U+FFFD convention, normalizeName's fold, and the Go wire test).
const tagColorFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "testdata", "tag-colors.json"), "utf8"),
);

test("colorFromName matches the shared fixture both backends derive colors from", () => {
  const { colorFromName } = loadBundle().__internal;
  // A count floor, because a pair silently dropped from the fixture leaves the
  // loop below green: this list is the only thing pinning the JS hash (the Go
  // suite has its own require.NotEmpty, and this is a little tighter).
  assert.ok(tagColorFixture.names.length >= 11, "the fixture must keep the whole name/color table");
  tagColorFixture.names.forEach(({ name, color }) => {
    assert.equal(colorFromName(name), color, `colorFromName(${JSON.stringify(name)})`);
  });
});

test("sanitizeCatalog drops a definition whose id nothing could reference", () => {
  // sanitizeTagIdList -- the rule every reader applies to a card's ids -- keeps
  // only non-empty strings, and every write path refuses "", so a catalog entry
  // with an empty id is a row that can never be applied.
  const { sanitizeCatalog, sanitizeTagIdList } = loadBundle().__internal;
  const catalog = sanitizeCatalog([
    { id: "", name: "ghost", color: "#ffffff" },
    { id: "t1", name: "bug", color: "#ef4444" },
    { id: 42, name: "numeric", color: "#ffffff" },
    { id: "t2", name: "no-color" },
  ]);
  assertStructural.deepEqual(catalog.map((t) => t.id), ["t1"]);
  assertStructural.deepEqual(sanitizeTagIdList(["", "t1", 42, null]), ["t1"], "the same rule, on ids");
});

test("the palette and the neutral default match the shared fixture", () => {
  // Every expected color above is a palette entry at a hash-chosen index, so a
  // reorder here (or in the Go palette) silently shifts all of them; the
  // neutral default is the other duplicated value, deciding what an
  // auto_color-off tag -- and any tag on a host predating plugin actions --
  // renders as. Both are pinned to the fixture rather than left to drift.
  const { PALETTE, DEFAULT_COLOR } = loadBundle().__internal;
  assertStructural.deepEqual(tagColorFixture.palette, PALETTE);
  assert.equal(tagColorFixture.neutral, DEFAULT_COLOR);
});

test("colorFromName is derived from the name alone, not from catalog position", () => {
  const { colorFromName, addCatalogTag } = loadBundle().__internal;
  // The bug this replaces: colors came from `PALETTE[catalog.length %
  // PALETTE.length]`, so creating or deleting any *other* tag recolored an
  // existing one. The same name must now resolve identically in any catalog.
  assert.equal(colorFromName("urgent"), colorFromName("urgent"));
  assert.notEqual(colorFromName("bug"), colorFromName("Bug"), "the hash is case-sensitive, as the name is stored");
  const first = addCatalogTag([], "urgent", null).tag.color;
  const afterOthers = addCatalogTag(
    [
      { id: "t1", name: "bug", color: "#ef4444" },
      { id: "t2", name: "docs", color: "#22c55e" },
    ],
    "urgent",
    null,
  ).tag.color;
  assert.equal(afterOthers, first, "another tag's presence does not change the derived color");
});

test("colorFromName encodes a lone surrogate as U+FFFD, the way Go's JSON decoder already stored it", () => {
  const { colorFromName } = loadBundle().__internal;
  // Go's json.Unmarshal replaces an unpaired surrogate escape with U+FFFD
  // before the server hashes the name; the UI has to encode the same bytes or
  // the two would disagree for such a name.
  assert.equal(colorFromName("\ud800"), colorFromName("\ufffd"));
  assert.equal(colorFromName("a\ud800b"), colorFromName("a\ufffdb"));
  assert.notEqual(colorFromName("\ud83d\ude80"), colorFromName("\ufffd\ufffd"), "a paired surrogate is a real 4-byte emoji");
});

test("normalizeName and normalizeColor strip exactly the fixture's shared trim set", () => {
  // The two sides decide what a stored name is, and the create-and-apply flow
  // looks the created tag up by the *client's* normalization -- so a character
  // only one side strips turns into "tag not found after create", with the tag
  // already in the catalog. Neither side delegates to its language's trim: both
  // enumerate the set explicitly (Go's unicode.IsSpace differs by U+0085, and a
  // future Unicode revision could widen JS's Zs), so the fixture list IS the
  // contract. The sweep below compares the set this side actually strips against
  // it in BOTH directions, and against the engine's own trim() as a reminder of
  // what the list was frozen from.
  const { normalizeName, normalizeColor } = loadBundle().__internal;
  const want = new Set(tagColorFixture.trim);
  assert.equal(want.size, tagColorFixture.trim.length, "the fixture lists no duplicate code point");
  assert.equal(want.size, 25);

  // Every fixture entry is stripped -- from both ends, and this side of the
  // comparison covers any plane, so an astral entry added later is still
  // checked too. Both ends matter: EDGE_TRIM_RE is two alternatives, and a
  // single-character probe satisfies either one, so dropping a code point from
  // the leading half alone used to leave this suite green.
  tagColorFixture.trim.forEach((hex) => {
    const ch = String.fromCodePoint(parseInt(hex, 16));
    assert.equal(normalizeName(ch + "bug"), "bug", "u+" + hex + " must be stripped from the front");
    assert.equal(normalizeName("bug" + ch), "bug", "u+" + hex + " must be stripped from the back");
    assert.equal(normalizeName(ch + ch + "bug" + ch + ch), "bug", "u+" + hex + " must be stripped from both ends");
    assert.equal(normalizeName(ch), null, "u+" + hex + " alone is not a name");
  });

  // Nothing else is: sweep the BMP, which is where every code point in the
  // fixture lives, since none of them is astral (the explicit list has no
  // astral range at all, and the probes below guard the obvious way to add one).
  const mismatches = [];
  let stripped = 0;
  for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates: no glyph, never whitespace
    const ch = String.fromCodePoint(cp);
    const hex = cp.toString(16).padStart(4, "0");
    const ours = normalizeName(ch) === null; // our explicit set stripped it to nothing
    if (ours !== want.has(hex)) mismatches.push(hex);
    if (ours !== (ch.trim() === "")) mismatches.push(hex + " (native trim)");
    if (ours) stripped += 1;
  }
  // A mismatch tagged "(native trim)" means the ENGINE's own set moved away from
  // the frozen list (this arm is the reminder of what the list was copied from);
  // an untagged one means this implementation disagrees with the fixture. The
  // first is a signal to revisit the fixture deliberately, not a claim that the
  // implementation is wrong.
  assertStructural.deepEqual(mismatches, []);
  assert.equal(stripped, want.size, "every code point in the fixture is actually stripped");
  [0x10000, 0x1d400, 0x1f300, 0x20000, 0x10ffff].forEach((cp) => {
    assert.notEqual(normalizeName(String.fromCodePoint(cp)), null, "u+" + cp.toString(16) + " is not whitespace");
  });

  // The two characters the backend's old strings.TrimSpace disagreed on.
  assert.equal(normalizeName("\ufeffbug"), "bug", "U+FEFF (a BOM pasted from a spreadsheet) is trimmed");
  assert.equal(normalizeName("bug\ufeff"), "bug");
  assert.equal(normalizeName("bug\u0085"), "bug\u0085", "U+0085 is NOT whitespace in JavaScript");
  assert.equal(normalizeName("\u00a0bug\u3000"), "bug", "NBSP and ideographic space are trimmed by both sides");

  // An unpaired surrogate folds to U+FFFD, which is what the backend stores for
  // it (Go's JSON decoder substitutes before normalizeTagName runs), so the
  // create-and-apply lookup compares against the name the server actually wrote
  // instead of a string it can never equal.
  assert.equal(normalizeName("\ud800"), "\ufffd");
  assert.equal(normalizeName("a\ud800b"), "a\ufffdb");
  assert.equal(normalizeName("a\udc00b"), "a\ufffdb", "a lone low surrogate folds the same way");
  assert.equal(normalizeName("\ud83d\ude80"), "\ud83d\ude80", "a paired surrogate is a real astral character");

  // Colors use the same set, so a stray BOM behaves identically on both sides:
  // accepted in front of a hex value, and "no color supplied" when it is all
  // there is (the backend derives then, exactly as addCatalogTag falls back).
  assert.equal(normalizeColor("\ufeff#AbCdEf"), "#abcdef");
  assert.equal(normalizeColor("\ufeff"), null);
  assert.equal(normalizeColor("  "), null);
});

test("findTagByName approximates the backend's case folding, and the pairs where it cannot", () => {
  const { findTagByName, addCatalogTag } = loadBundle().__internal;
  // The backend compares names with Go's strings.EqualFold (Unicode simple case
  // folding); this side lowers. For the characters whose folding is not their
  // lowercase form the two disagree, and the local check therefore allows a name
  // the server refuses as a duplicate -- which is why the create/rename failure
  // path reports the server's "already exists" instead of asking for a retry.
  // The Go side pins its half of this in TestHasTagNameUsesSimpleCaseFolding.
  const catalog = [{ id: "t1", name: "\u03a3", color: "#ef4444" }]; // Σ
  assert.equal(findTagByName(catalog, "\u03c3"), catalog[0], "Σ/σ: both rules agree");
  assert.equal(findTagByName(catalog, "\u03c2"), null, "Σ/ς: JS lowering does not fold final sigma");
  assert.equal(findTagByName(catalog, "\u017f"), null, "long s does not fold to 's' here");
  assert.equal(findTagByName(catalog, "k"), null);
  // U+212A KELVIN SIGN lowercases to "k" here and folds to it in Go: an
  // agreeing pair, which is why only some characters diverge.
  const kelvin = [{ id: "t2", name: "\u212a", color: "#ef4444" }];
  assert.equal(findTagByName(kelvin, "k"), kelvin[0]);
  // The consequence, stated once: the local check can admit a name that goes on
  // to be refused remotely, and nothing is stored locally either way.
  assert.ok(addCatalogTag(catalog, "\u03c2", null), "the local check is satisfied");
});

test("sanitizeSharedTags drops a task entry that is not an array", () => {
  // Five call sites iterate a task's entries, and the delete count runs inside
  // the confirmation's effect -- the one place that cannot catch its way out --
  // so a malformed entry has to be normalized away at the boundary, not guarded
  // five times.
  const { sanitizeSharedTags, countSharedTasksWithTag } = loadBundle().__internal;
  const payload = sanitizeSharedTags({
    tags: [{ id: "t1", name: "bug", color: "#ef4444" }],
    tasks: {
      "task-1": [{ id: "t1" }],
      "task-2": "not-an-array",
      "task-3": null,
      "task-4": { id: "t1" },
      "task-5": [null],
      "task-6": [1, "x"],
      "task-7": [null, { id: "t1" }], // one usable entry survives, the null does not
      "task-8": [{ name: "no-id" }], // the chips would render a phantom chip for this...
      "task-9": [{ id: 42, name: "numeric-id" }],
      "task-10": [{ id: "t1" }, { name: "no-id" }], // ...while the facet dropped the task
      "task-11": [{ id: "" }], // an empty id is unusable, and sanitizeTagIdList drops it too
    },
  });
  assertStructural.deepEqual(
    Object.keys(payload.tasks),
    ["task-1", "task-7", "task-10"],
    "only well-formed entries survive",
  );
  assertStructural.deepEqual(payload.tasks["task-7"], [{ id: "t1" }], "and only their well-formed elements");
  assertStructural.deepEqual(payload.tasks["task-10"], [{ id: "t1" }], "an entry without a string id is dropped");
  assert.equal(sanitizeSharedTags(null).tasks && Object.keys(sanitizeSharedTags(null).tasks).length, 0);
  assert.equal(countSharedTasksWithTag(payload, "t1"), 3, "and the count degrades instead of throwing");

});

test("a task id that collides with an Object prototype key survives sanitization", () => {
  // Task ids are opaque and agent-supplied -- the backend accepts arbitrary ids,
  // including one that names an Object prototype member -- so on an ordinary
  // object `tasks["__proto__"] = entries` would set the map's *prototype* instead
  // of storing the task, and the UI would show that card as untagged.
  const { sanitizeSharedTags, countSharedTasksWithTag } = loadBundle().__internal;
  const payload = JSON.parse(
    '{"tags":[{"id":"t1","name":"bug","color":"#ef4444"}],' +
      '"tasks":{"__proto__":[{"id":"t1"}],"normal":[{"id":"t1"}],"constructor":[{"id":"t1"}]}}',
  );
  const sanitized = sanitizeSharedTags(payload);
  assertStructural.deepEqual(Object.keys(sanitized.tasks).sort(), ["__proto__", "constructor", "normal"]);
  assert.equal(Object.getPrototypeOf(sanitized.tasks), null, "the map absorbs prototype-named keys as data");
  assert.equal(sanitized.tasks["__proto__"].length, 1, "and that task's entries are readable");
  assert.equal(countSharedTasksWithTag(sanitized, "t1"), 3, "all three cards count");
});

test("isDuplicateNameError recognises the backend's refusal and nothing else", () => {
  const { isDuplicateNameError } = loadBundle().__internal;
  assert.equal(isDuplicateNameError(apiError(400, 'a tag named "\u03c2" already exists')), true);
  assert.equal(isDuplicateNameError(apiError(400, "bad request", { error: 'a tag named "x" already exists' })), true);
  assert.equal(isDuplicateNameError(apiError(400, "color must be a 3- or 6-digit hex value")), false);
  assert.equal(isDuplicateNameError(apiError(503, "plugin is not active")), false);
  assert.equal(isDuplicateNameError(new Error("network down")), false);
  assert.equal(isDuplicateNameError(null), false);
});

test("the duplicate checks normalize the existing name too, not just the candidate", () => {
  // sanitizeCatalog checks a tag's shape, not its spelling, so private or
  // imported storage can hold a padded name. It still has to block its own
  // normalized duplicate, or the board grows two tags whose names collide the
  // moment the backend normalizes them.
  const { findTagByName, addCatalogTag, updateCatalogTag } = loadBundle().__internal;
  const catalog = [{ id: "t1", name: " urgent ", color: "#fff" }];
  assert.equal(findTagByName(catalog, "urgent"), catalog[0]);
  assert.equal(findTagByName(catalog, "  urgent  "), catalog[0]);
  assert.equal(addCatalogTag(catalog, "urgent", null), null, "no second tag for the same normalized name");

  const two = [{ id: "t1", name: " urgent ", color: "#fff" }, { id: "t2", name: "bug", color: "#000" }];
  assert.equal(updateCatalogTag(two, "t2", { name: "URGENT" }), two, "a normalized duplicate rename stays a no-op");
  assert.equal(updateCatalogTag(two, "t1", { name: "  urgent  " })[0].name, "urgent", "and a tag may still rename to its own name");
  assert.equal(findTagByName(catalog, "   "), null, "a name that normalizes to nothing matches nothing");
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

test("addCatalogTag creates a new tag with the color derived from its name", () => {
  const { addCatalogTag, colorFromName } = loadBundle().__internal;
  const result = addCatalogTag([], "urgent", null);
  assert.ok(result);
  assert.equal(result.catalog.length, 1);
  assert.equal(result.tag.name, "urgent");
  assert.equal(result.tag.color, colorFromName("urgent"));
  assert.ok(result.tag.id);
});

test("addCatalogTag falls back to the derived color for a missing or invalid one", () => {
  const { addCatalogTag, colorFromName } = loadBundle().__internal;
  assert.equal(addCatalogTag([], "urgent", undefined).tag.color, colorFromName("urgent"));
  assert.equal(addCatalogTag([], "urgent", "").tag.color, colorFromName("urgent"));
  assert.equal(addCatalogTag([], "urgent", "not-a-color").tag.color, colorFromName("urgent"));

  // Callers hand in the raw draft (the picker modal and the Tags box both do),
  // so the fallback has to hash what will be stored -- the normalized name -- or
  // one visible name would get a different color from the board than from the
  // backend, which hashes its own normalized name. This layer derives even when
  // the operator set auto_color off: it only runs on hosts without plugin
  // actions, where no channel exposes the setting (see addCatalogTag's note).
  const padded = addCatalogTag([], "  urgent  ", null);
  assert.equal(padded.tag.name, "urgent");
  assert.equal(padded.tag.color, colorFromName("urgent"));
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

test("resolveTag rejects an orphaned server-generated tag id without hiding similar legacy names", () => {
  const { resolveTag, DEFAULT_COLOR } = loadBundle().__internal;
  const currentServerId = "tag-6a1aeb09170bfffcfa5e";

  assert.equal(resolveTag([], currentServerId), null);
  assertStructural.deepEqual(resolveTag([], "tag-deadbeef"), {
    id: "tag-deadbeef",
    name: "tag-deadbeef",
    color: DEFAULT_COLOR,
  });
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

test("a prototype-named id never reaches the bundle realm's Object.prototype", async () => {
  // loadBundle evaluates the bundle with vm.runInNewContext, so it owns its own
  // Object.prototype: a literal written in this file can never observe pollution
  // there, and an assertion on it would be inert. The probe therefore has to be an
  // object the bundle itself built (resolveTag returns one).
  const plugin = loadBundle();
  const { resolveTag } = plugin.__internal;
  const probe = () => resolveTag([], "probe");
  // Self-check that the probe can fail for the reason this test names: write a
  // marker through its own prototype chain, observe it, remove it. (A literal from
  // this file could never see the bundle realm's prototype, which is how the
  // earlier version of this test managed to be inert.)
  const realmProto = Object.getPrototypeOf(probe());
  assert.notEqual(realmProto, null, "the probe inherits from the bundle realm's Object.prototype");
  realmProto.__loopProbe = 1;
  assert.equal(probe().__loopProbe, 1, "and it observes that prototype");
  delete realmProto.__loopProbe;
  assert.equal(probe().__loopProbe, undefined, "cleaned up");
  assert.equal(probe().value, undefined, "and starts clean");

  const payload = JSON.parse(
    '{"tags":[{"id":"t1","name":"bug","color":"#ef4444"}],' +
      '"tasks":{"__proto__":[{"id":"t1"}],"normal":[{"id":"t1"}]}}',
  );
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }), subscribe: () => () => {} };
  fakeHost.storage = {
    get: () => Promise.resolve({ value: [], updatedAt: "t0" }),
    subscribe: () => () => {},
    listByKey: () => Promise.resolve({ entries: [], truncated: false }),
  };
  fakeHost.api = { invokeAction: () => Promise.resolve(payload) };
  let TaskCardTags = null;
  const registry = {
    registerComponent(slot, Component) {
      if (slot === "task-card-tags") TaskCardTags = Component;
    },
    registerTaskMenuAction() {},
    registerTaskFilter() {},
  };

  // (a) initialize adopts the payload, which clears the task-tag map and then
  // primes it with the payload's ids -- including "__proto__".
  plugin.initialize(registry, fakeHost);
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(probe().value, undefined, "the task-tag prime did not land on the realm prototype");
  assert.equal(probe().loaded, undefined);
  assert.equal(probe().error, undefined);

  // (b) destroy (which resets those maps) and re-enable with a workspace id of
  // "__proto__": that exercises getSharedTagStore/catalogStores through the reset
  // sites, which is where the invariant was lost the first time.
  plugin.destroy();
  await flush();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "__proto__" } }), subscribe: () => () => {} };
  plugin.initialize(registry, fakeHost);
  for (let i = 0; i < 8; i++) await flush();
  // Mounting a chip row is what creates the workspace-keyed catalog store, so it
  // is the step that exercises catalogStores through the reset.
  assert.ok(TaskCardTags, "the chip component registered");
  fakeHost.mount(TaskCardTags, { slotProps: { taskId: "task-1", workspaceId: "__proto__" } });
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(probe().value, undefined, "a prototype-named workspace id did not pollute either");
  assert.equal(probe().tags, undefined);
  assert.equal(probe().loaded, undefined);

  // And the empty store value the fetch paths fall back to is keyed by task id too.
  assert.equal(Object.getPrototypeOf(plugin.__internal.newIdMap()), null, "every id map is prototype-free");
  assert.equal(Object.getPrototypeOf(plugin.__internal.emptySharedValue().tasks), null, "including the empty shared value");
});

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
  assert.ok(registered.components.some((c) => c.slot === "task-row-metadata"));
  assert.ok(registered.components.some((c) => c.slot === "main-top-bar"));
  const addTagAction = registered.menuActions.find((a) => a.id === "add-tag");
  assert.ok(addTagAction, "registers an add-tag menu action");
  // Flat, top-level item -- shipped in kdlbs/kandev PR #2351.
  assert.equal(addTagAction.group, "primary");
});

// -----------------------------------------------------------------------
// task-row-metadata: dense, non-removable chip row for the sidebar row and the
// /tasks list row.
// -----------------------------------------------------------------------

test("task-row-metadata renders chips with no remove control", async () => {
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
        if (slot === "task-row-metadata") TaskRowTags = Component;
      },
      registerTaskMenuAction() {},
    },
    fakeHost,
  );
  assert.ok(TaskRowTags, "task-row-metadata component registered");

  const getTree = fakeHost.mount(TaskRowTags, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();

  const row = getTree();
  const chip = row.children[0][0];
  assert.equal(chip.children[0], "urgent");
  assert.equal(chip.children.length, 1, "no remove button child on a task-row-metadata chip");
});

test("task-row-metadata caps at 3 visible chips and shows a +N indicator beyond the cap", async () => {
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
        if (slot === "task-row-metadata") TaskRowTags = Component;
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

test("task-row-metadata shows no +N indicator at or under the 3-chip cap", async () => {
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
        if (slot === "task-row-metadata") TaskRowTags = Component;
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

test("agent status tags render before user tags on card chips from direct invokeAction JSON", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: ["t1"], updatedAt: "t0" });
      return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  fakeHost.api = {
    invokeAction(key, input) {
      assert.equal(key, "shared-tags");
      assertStructural.deepEqual(input, { workspaceId: "ws-1" });
      return Promise.resolve({
        tags: [],
        tasks: {
          "task-1": [
            {
              id: "blocked",
              name: "Blocked",
              color: "#dc2626",
              agent: true,
              agentApplied: true,
              note: "waiting on API keys",
              updatedAt: "2026-08-19T00:00:00Z",
            },
          ],
        },
      });
    },
  };

  const getTree = fakeHost.mount(makeTagChips(fakeHost, { removable: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();

  const chips = getTree().children[0];
  assert.equal(chips[0].children[1], "Blocked", "agent chip is rendered before user chips");
  assert.equal(chips[0].children[0].props["data-testid"], "kandev-tags-agent-icon");
  assert.equal(chips[0].props["data-agent"], "true");
  assert.equal(chips[0].props.style.border, "1px dashed currentColor");
  assert.equal(chips[0].props.title, "Blocked — waiting on API keys");
  assert.equal(chips[0].props["aria-label"], "Blocked — waiting on API keys");
  assert.equal(chips[1].children[0], "urgent");
});

test("shared Human application replaces an overlapping private representation by stable id", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  const tagId = "tag-6a1aeb09170bfffcfa5e";
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: [tagId], updatedAt: "legacy-task" });
      return Promise.resolve({
        value: [{ id: tagId, name: "stale private name", color: "#6b7280" }],
        updatedAt: "legacy-catalog",
      });
    },
    subscribe: () => () => {},
  };
  const calls = [];
  let removed = false;
  fakeHost.api = {
    invokeAction(key, input) {
      calls.push({ key, input });
      if (key === "task-tag-remove") {
        removed = true;
        return Promise.resolve({ tags: [] });
      }
      return Promise.resolve({
        tags: [{ id: tagId, name: "Human priority", color: "#ef4444" }],
        tasks: removed
          ? {}
          : {
              "task-1": [
                { id: tagId, name: "Human priority", color: "#ef4444", agent: false, agentApplied: false, note: "" },
              ],
            },
      });
    },
  };

  const getTree = fakeHost.mount(makeTagChips(fakeHost, { removable: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();

  const chips = getTree().children[0];
  assert.equal(chips.length, 1, "one logical Human application renders one chip");
  assert.equal(chips[0].children[0], "Human priority", "the canonical shared definition wins");
  assert.equal(chips[0].props.style.background, "#ef4444");
  assert.equal(chips[0].props["data-agent"], undefined);
  assert.equal(chips[0].children[1].props["aria-label"], "Remove tag Human priority");

  chips[0].children[1].props.onClick({ stopPropagation() {} });
  await flush();
  assertStructural.deepEqual(calls[1], {
    key: "task-tag-remove",
    input: { taskId: "task-1", body: { tagId } },
  });
  assert.equal(calls[2].key, "shared-tags", "successful removal refreshes canonical applications");
  assert.equal(getTree(), null, "the stale private overlap does not reappear after shared removal");
});

test("shared agent application suppresses a stale raw id on cards and dense rows", async () => {
  for (const options of [
    { removable: true, dense: false },
    { removable: false, dense: true },
  ]) {
    const plugin = loadBundle();
    const { makeTagChips } = plugin.__internal;
    const fakeHost = makeFakeReactHost();
    const tagId = "tag-0123456789abcdefabcd";
    fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
    fakeHost.storage = {
      get(scope) {
        if (scope === "task") return Promise.resolve({ value: [tagId], updatedAt: "legacy-task" });
        return Promise.resolve({ value: [], updatedAt: "legacy-catalog" });
      },
      subscribe: () => () => {},
    };
    fakeHost.api = {
      invokeAction() {
        return Promise.resolve({
          tags: [{ id: tagId, name: "Needs review", color: "#a855f7", agent: true }],
          tasks: {
            "task-1": [
              {
                id: tagId,
                name: "Needs review",
                color: "#a855f7",
                agent: true,
                agentApplied: true,
                note: "PR is ready",
              },
            ],
          },
        });
      },
    };

    const getTree = fakeHost.mount(makeTagChips(fakeHost, options), {
      slotProps: { taskId: "task-1", workspaceId: "ws-1" },
    });
    await flush();

    const row = getTree();
    const chips = row.children[0];
    assert.equal(chips.length, 1, options.dense ? "dense row has one chip" : "card has one chip");
    assert.equal(chips[0].children[1], "Needs review");
    assert.equal(chips[0].props["data-agent"], "true");
    assert.equal(chips[0].props.title, "Needs review — PR is ready");
    assert.equal(chips[0].props["aria-label"], "Needs review — PR is ready");
    assert.equal(row.children[1], options.dense ? null : undefined, "no duplicate is counted in dense overflow");
  }
});

test("filter-primed shared ids do not render as private raw chips after task storage returns 404", async () => {
  const { console: fakeConsole, calls: consoleCalls } = makeFakeConsole();
  const plugin = loadBundle(fakeConsole);
  const fakeHost = makeFakeReactHost();
  let TagChips = null;
  let taskStorageGets = 0;
  const sharedTags = [
    { id: "tag-agent-123", name: "Agent ready", color: "#a855f7", agent: true },
    { id: "tag-review-456", name: "Needs review", color: "#f59e0b", agent: true },
    { id: "tag-whitespace", name: "Whitespace", color: "#22c55e", agent: false },
    { id: "tag-human", name: "Human", color: "#ef4444", agent: false },
  ];
  const payload = {
    tags: sharedTags,
    tasks: {
      "task-1": sharedTags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        agent: tag.agent,
        agentApplied: tag.agent,
        note: tag.agent ? "from coordinator" : "",
      })),
    },
  };
  fakeHost.store = {
    getState: () => ({ workspaces: { activeId: "ws-1" } }),
    subscribe: () => () => {},
  };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") {
        taskStorageGets += 1;
        return Promise.reject(new Error("GET user-state/task/task-1/tags: 404"));
      }
      return Promise.resolve(undefined);
    },
    subscribe: () => () => {},
  };
  fakeHost.api = { invokeAction: () => Promise.resolve(payload) };

  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-card-tags") TagChips = Component;
      },
      registerTaskMenuAction() {},
      registerTaskFilter() {},
    },
    fakeHost,
  );
  const getTree = fakeHost.mount(TagChips, {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();

  assert.equal(taskStorageGets, 1, "the fixture exercises the absent private task storage path");
  assert.ok(
    consoleCalls.error.some((args) => String(args[1]).includes("404")),
    "the private-state 404 is observed rather than replaced with seeded private data",
  );
  const chips = getTree().children[0].filter((node) => node.props["data-testid"] === "kandev-tags-chip");
  assert.equal(chips.length, 4, "one chip renders for each of the four canonical shared applications");
  assert.ok(findTestNode(getTree(), "kandev-tags-chip-load-error"), "an unavailable private compatibility read remains visible");
  assertStructural.deepEqual(
    chips.map((chip) => (chip.props["data-agent"] ? chip.children[1] : chip.children[0])),
    ["Agent ready", "Needs review", "Whitespace", "Human"],
  );
  assert.equal(
    chips.some((chip) => chip.children.includes("tag-whitespace") || chip.children.includes("tag-human")),
    false,
    "filter-cached stable ids never render as gray raw labels",
  );
});

test("card agent chip labels use application notes and empty/whitespace fallbacks without provenance copy", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: [], updatedAt: "t0" });
      return Promise.resolve({ value: [], updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  fakeHost.api = {
    invokeAction() {
      return Promise.resolve({
        tags: [],
        tasks: {
          "task-1": [
            { id: "agent-applied", name: "Blocked", color: "#dc2626", agent: true, agentApplied: true, note: "  waiting on API keys  ", updatedAt: "t1" },
            { id: "agent-created", name: "Needs review", color: "#f59e0b", agent: true, agentApplied: false, human: true, note: "", updatedAt: "t2" },
            { id: "human-created", name: "Customer", color: "#22c55e", agent: false, agentApplied: false, human: true, note: "", updatedAt: "t3" },
            { id: "empty-note", name: "Queued", color: "#3b82f6", agent: true, agentApplied: true, note: "", updatedAt: "t4" },
            { id: "whitespace-note", name: "Waiting", color: "#8b5cf6", agent: true, agentApplied: true, note: " \t ", updatedAt: "t5" },
          ],
        },
      });
    },
  };
  const getTree = fakeHost.mount(makeTagChips(fakeHost, { removable: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();
  const chips = getTree().children[0];
  assert.equal(chips[0].props.title, "Blocked — waiting on API keys");
  assert.equal(chips[0].props["aria-label"], "Blocked — waiting on API keys");
  assert.equal(chips[1].props.title, "Needs review");
  assert.equal(chips[1].props["aria-label"], "Needs review");
  assert.equal(chips[2].props.title, undefined);
  assert.equal(chips[2].props["aria-label"], undefined);
  assert.equal(chips[3].props.title, "Queued");
  assert.equal(chips[3].props["aria-label"], "Queued");
  assert.equal(chips[4].props.title, "Waiting");
  assert.equal(chips[4].props["aria-label"], "Waiting");
  assert.equal(chips[0].children[0].props["data-testid"], "kandev-tags-agent-icon");
  assert.equal(chips[1].children[0].props["data-testid"], "kandev-tags-agent-icon");
  assert.equal(chips[2].children[0], "Customer");
  assert.equal(chips[3].children[0].props["data-testid"], "kandev-tags-agent-icon");
  assert.equal(chips[4].children[0].props["data-testid"], "kandev-tags-agent-icon");
});

test("agent status tags render on dense task rows without a remove control and count toward +N", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: ["t1", "t2"], updatedAt: "t0" });
      return Promise.resolve({
        value: [
          { id: "t1", name: "urgent", color: "#ef4444" },
          { id: "t2", name: "docs", color: "#22c55e" },
        ],
        updatedAt: "t0",
      });
    },
    subscribe: () => () => {},
  };
  fakeHost.api = {
    invokeAction() {
      return Promise.resolve({
        tags: [],
        tasks: {
          "task-1": [
            { id: "blocked", name: "Blocked", color: "#dc2626", agent: true, agentApplied: true, note: " \t ", updatedAt: "t1" },
            { id: "needs-input", name: "Needs input", color: "#f59e0b", agent: true, agentApplied: true, note: "", updatedAt: "t2" },
          ],
        },
      });
    },
  };

  const getTree = fakeHost.mount(makeTagChips(fakeHost, { removable: false, dense: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();

  const row = getTree();
  const chips = row.children[0];
  assert.equal(chips.length, 3, "dense rows still cap at three total chips");
  assertStructural.deepEqual(chips.map((chip) => (chip.props["data-agent"] ? chip.children[1] : chip.children[0])), ["Blocked", "Needs input", "urgent"]);
  assert.equal(chips[0].children.length, 2, "dense agent chip has a bot marker but no remove button");
  assert.equal(chips[0].props.title, "Blocked", "dense agent chip uses the same whitespace-only fallback");
  assert.equal(chips[0].props["aria-label"], "Blocked");
  assert.equal(row.children[1].children[0], "+1", "hidden user tag is counted in +N");
});

test("agent status chip removal invokes the task action and refreshes the shared store", async () => {
  const plugin = loadBundle();
  const { makeTagChips } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: [], updatedAt: "t0" });
      return Promise.resolve({ value: [], updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  const calls = [];
  let removed = false;
  fakeHost.api = {
    invokeAction(key, input) {
      calls.push({ key, input });
      if (key === "task-tag-remove") {
        removed = true;
        return Promise.resolve({ tags: [] });
      }
      return Promise.resolve({
        tags: [],
        tasks: removed
          ? {}
          : { "task-1": [{ id: "blocked", name: "Blocked", color: "#dc2626", agent: true, agentApplied: true, note: "", updatedAt: "t1" }] },
      });
    },
  };

  const getTree = fakeHost.mount(makeTagChips(fakeHost, { removable: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();
  getTree().children[0][0].children[2].props.onClick({ stopPropagation() {} });
  await flush();

  assert.equal(calls[0].key, "shared-tags", "initial load reads the shared workspace catalog");
  assertStructural.deepEqual(calls[1], {
    key: "task-tag-remove",
    input: { taskId: "task-1", body: { tagId: "blocked" } },
  });
  assert.equal(calls[2].key, "shared-tags", "successful removal refreshes the shared workspace store");
  assert.equal(getTree(), null, "the chip row disappears after the refreshed store no longer has tags");
});

test("agent tag action absence or a definitive 404 degrades to user tags without throwing", async () => {
  const missingActionPlugin = loadBundle();
  const { makeTagChips: makeMissingActionChips } = missingActionPlugin.__internal;
  const missingActionHost = makeFakeReactHost();
  missingActionHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  missingActionHost.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: ["t1"], updatedAt: "t0" });
      return Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }], updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  const missingTree = missingActionHost.mount(makeMissingActionChips(missingActionHost, { removable: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();
  assert.equal(missingTree().children[0][0].children[0], "urgent");

  const { console: fakeConsole, calls } = makeFakeConsole();
  const rejectingPlugin = loadBundle(fakeConsole);
  const { makeTagChips: makeRejectingChips } = rejectingPlugin.__internal;
  const rejectingHost = makeFakeReactHost();
  rejectingHost.store = missingActionHost.store;
  rejectingHost.storage = missingActionHost.storage;
  rejectingHost.api = { invokeAction: () => Promise.reject(apiError(404, "plugin action not found")) };
  const rejectingTree = rejectingHost.mount(makeRejectingChips(rejectingHost, { removable: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();

  assert.equal(rejectingTree().children[0][0].children[0], "urgent");
  assert.equal(calls.error.length, 1, "a rejecting action is logged once");
  assert.match(String(calls.error[0][0]), /load shared tags/);
});

test("shared action errors classify only the host's undeclared-action 404 as unsupported", () => {
  const {
    actionErrorStatus,
    sharedActionUnsupported,
    sharedActionRetryable,
  } = loadBundle().__internal;

  assert.equal(actionErrorStatus(apiError(404)), 404);
  assert.equal(sharedActionUnsupported(apiError(404, "plugin action not found")), true);
  assert.equal(sharedActionUnsupported(apiError(404, "workspace not found")), false);
  assert.equal(sharedActionUnsupported(apiError(404, "plugin action not found", null)), false);
  assert.equal(sharedActionUnsupported(new Error("404 plugin action not found")), false);

  for (const status of [502, 503, 504]) {
    assert.equal(sharedActionRetryable(apiError(status)), true, String(status));
  }
  assert.equal(sharedActionRetryable(new TypeError("fetch failed")), true, "network failures retry");
  for (const status of [400, 401, 403, 404, 500]) {
    assert.equal(sharedActionRetryable(apiError(status)), false, String(status));
  }
});

test("a transient update failure retains the last shared catalog and recovers on one bounded retry", async () => {
  let nextTimer = 1;
  const timers = new Map();
  const { console: fakeConsole, calls: consoleCalls } = makeFakeConsole();
  const plugin = loadBundle(fakeConsole, {
    setTimeout(fn, delay) {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const { fetchSharedTags, getSharedTagStore, sharedTagsEnabled } = plugin.__internal;
  const stable = {
    tags: [{ id: "tag-1", name: "Release", color: "#3b82f6" }],
    tasks: { "task-1": [{ id: "tag-1", name: "Release", color: "#3b82f6" }] },
  };
  let response = stable;
  let actionCalls = 0;
  const storageCalls = { set: 0, delete: 0 };
  const host = {
    api: {
      invokeAction() {
        actionCalls += 1;
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      },
    },
    storage: {
      set() {
        storageCalls.set += 1;
        return Promise.resolve();
      },
      delete() {
        storageCalls.delete += 1;
        return Promise.resolve();
      },
    },
  };

  await fetchSharedTags(host, "ws-1");
  const store = getSharedTagStore("ws-1");
  assert.equal(store.hasValue, true);
  assertStructural.deepEqual(store.value, stable);

  response = apiError(503, "plugin is not active");
  await fetchSharedTags(host, "ws-1");

  assert.equal(sharedTagsEnabled(host, "ws-1"), true, "503 never authorizes legacy fallback");
  assert.equal(store.hasValue, true);
  assertStructural.deepEqual(store.value, stable, "the last confirmed shared value remains visible");
  assert.equal(store.error.status, 503);
  assert.equal(timers.size, 1, "one retry is scheduled");
  assert.equal([...timers.values()][0].delay, 250, "the first retry is prompt");
  assert.deepEqual(storageCalls, { set: 0, delete: 0 }, "recovery never writes private storage");

  response = stable;
  const retry = [...timers.entries()][0];
  timers.delete(retry[0]);
  retry[1].fn();
  await flush();

  assert.equal(actionCalls, 3);
  assert.equal(store.error, null);
  assert.equal(store.retryAttempt, 0);
  assert.equal(timers.size, 0);
  assertStructural.deepEqual(store.value, stable);
  assert.equal(consoleCalls.error.length, 1, "one outage is logged once");
});

test("transient shared-tag reads stop after the complete bounded retry budget", async () => {
  let nextTimer = 1;
  const timers = new Map();
  let actionCalls = 0;
  const plugin = loadBundle(makeFakeConsole().console, {
    setTimeout(fn, delay) {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const host = {
    api: {
      invokeAction() {
        actionCalls += 1;
        return Promise.reject(apiError(503, "plugin is not active"));
      },
    },
  };

  await plugin.__internal.fetchSharedTags(host, "ws-1");
  for (const expectedDelay of [250, 1000, 3000]) {
    assert.equal(timers.size, 1, "exactly one retry remains scheduled");
    const [id, timer] = [...timers.entries()][0];
    assert.equal(timer.delay, expectedDelay);
    timers.delete(id);
    timer.fn();
    await flush();
  }

  assert.equal(actionCalls, 4, "one initial read plus three retries");
  assert.equal(timers.size, 0, "the retry budget is exhausted");
  assert.equal(plugin.__internal.getSharedTagStore("ws-1").retryAttempt, 3);
  plugin.destroy();
});

test("first-load 503 stays on the shared error path and destroy cancels its retry", async () => {
  let nextTimer = 1;
  const timers = new Map();
  const plugin = loadBundle(null, {
    setTimeout(fn, delay) {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const { fetchSharedTags, getSharedTagStore, sharedTagsEnabled } = plugin.__internal;
  const host = {
    api: { invokeAction: () => Promise.reject(apiError(503, "plugin is not active")) },
  };

  await fetchSharedTags(host, "ws-1");
  const store = getSharedTagStore("ws-1");
  assert.equal(store.hasValue, false);
  assert.equal(store.error.status, 503);
  assert.equal(store.unavailable, false);
  assert.equal(sharedTagsEnabled(host, "ws-1"), true, "private storage is not made authoritative");
  assert.equal(timers.size, 1);

  plugin.destroy();
  assert.equal(timers.size, 0, "destroy cancels an update retry");
});

test("a late 503 after destroy cannot revive an obsolete shared-tag retry", async () => {
  let nextTimer = 1;
  const timers = new Map();
  let rejectAction;
  const plugin = loadBundle(null, {
    setTimeout(fn, delay) {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const host = {
    api: {
      invokeAction() {
        return new Promise((resolve, reject) => {
          rejectAction = reject;
        });
      },
    },
  };

  const pendingRead = plugin.__internal.fetchSharedTags(host, "ws-1");
  plugin.destroy();
  rejectAction(apiError(503, "plugin is not active"));
  await pendingRead;

  assert.equal(timers.size, 0, "a settled read from the destroyed generation cannot schedule a retry");
});

test("a late 503 from before re-entrant initialize cannot schedule alongside the new generation", async () => {
  let nextTimer = 1;
  const timers = new Map();
  const requests = [];
  const plugin = loadBundle(null, {
    setTimeout(fn, delay) {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const host = {
    React: null,
    jsx() { return {}; },
    store: {
      getState: () => ({}),
      subscribe: () => () => {},
    },
    api: {
      invokeAction() {
        return new Promise((resolve, reject) => requests.push({ resolve, reject }));
      },
    },
  };

  const obsoleteRead = plugin.__internal.fetchSharedTags(host, "ws-1");
  plugin.initialize(makeFullRegistry(), host);
  const liveRead = plugin.__internal.fetchSharedTags(host, "ws-1");
  assert.equal(requests.length, 2);

  requests[0].reject(apiError(503, "plugin is not active"));
  await obsoleteRead;
  assert.equal(timers.size, 0, "the old generation cannot add a retry after re-initialization");

  requests[1].reject(apiError(503, "plugin is not active"));
  await liveRead;
  assert.equal(timers.size, 1, "only the live generation owns the bounded retry");
  plugin.destroy();
  assert.equal(timers.size, 0);
});

test("non-404 client errors remain shared load errors without immediate retry", async () => {
  const plugin = loadBundle();
  const { fetchSharedTags, getSharedTagStore, sharedTagsEnabled } = plugin.__internal;
  for (const status of [400, 401, 403]) {
    const host = { api: { invokeAction: () => Promise.reject(apiError(status)) } };
    await fetchSharedTags(host, "ws-" + status);
    const store = getSharedTagStore("ws-" + status);
    assert.equal(store.unavailable, false, String(status));
    assert.equal(store.error.status, status, String(status));
    assert.equal(sharedTagsEnabled(host, "ws-" + status), true, String(status));
  }
  plugin.destroy();
});

test("a workspace 404 remains a shared load error and never exposes legacy state", async () => {
  const plugin = loadBundle();
  const { fetchSharedTags, getSharedTagStore, sharedTagsEnabled } = plugin.__internal;
  const host = {
    api: { invokeAction: () => Promise.reject(apiError(404, "workspace not found")) },
  };

  await fetchSharedTags(host, "missing-workspace");
  const store = getSharedTagStore("missing-workspace");
  assert.equal(store.unavailable, false);
  assert.equal(store.error.status, 404);
  assert.equal(sharedTagsEnabled(host, "missing-workspace"), true);
  plugin.destroy();
});

test("agent tag refresh interval is cleared on re-entrant initialize and destroy", async () => {
  let plugin;
  let nextTimer = 1;
  const activeTimers = new Set();
  const addedListeners = [];
  const removedListeners = [];
  const fakeWindow = {
    setInterval() {
      const id = nextTimer++;
      activeTimers.add(id);
      return id;
    },
    clearInterval(id) {
      activeTimers.delete(id);
    },
    addEventListener(type, listener) {
      addedListeners.push({ type, listener });
    },
    removeEventListener(type, listener) {
      removedListeners.push({ type, listener });
    },
  };
  plugin = loadBundle(null, { window: fakeWindow });

  function mountRegisteredRow() {
    let TaskRowTags;
    const host = makeFakeReactHost();
    host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
    host.storage = {
      get(scope) {
        if (scope === "task") return Promise.resolve({ value: [], updatedAt: "t0" });
        return Promise.resolve({ value: [], updatedAt: "t0" });
      },
      subscribe: () => () => {},
    };
    host.api = { invokeAction: () => Promise.resolve({ tasks: {} }) };
    plugin.initialize(
      {
        registerComponent(slot, Component) {
          if (slot === "task-row-metadata") TaskRowTags = Component;
        },
        registerTaskMenuAction() {},
      },
      host,
    );
    host.mount(TaskRowTags, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
    return host;
  }

  mountRegisteredRow();
  await flush();
  assert.equal(activeTimers.size, 1, "first mount starts one refresh interval");

  mountRegisteredRow();
  await flush();
  assert.equal(activeTimers.size, 1, "re-entrant initialize clears the old interval before starting a new one");
  assertStructural.deepEqual(removedListeners.map((item) => item.type), ["focus", "online"],
    "re-entrant initialize removes both foreground listeners");

  plugin.destroy();
  assert.equal(activeTimers.size, 0, "destroy clears the active refresh interval");
  assertStructural.deepEqual(addedListeners.map((item) => item.type), ["focus", "online", "focus", "online"]);
  assertStructural.deepEqual(removedListeners.map((item) => item.type), ["focus", "online", "focus", "online"],
    "destroy removes the active foreground listeners");
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

test("registered task filter keeps shared assignments separate from private chip assignments", async () => {
  const plugin = loadBundle();
  const host = makeFakeReactHost();
  host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }), subscribe: () => () => {} };
  host.storage = {
    get(scope) {
      if (scope === "task") return Promise.resolve({ value: ["private-id"], updatedAt: "t0" });
      return Promise.resolve({ value: [{ id: "private-id", name: "Legacy saved", color: "#ef4444" }], updatedAt: "t0" });
    },
    subscribe: () => () => {},
  };
  host.api = {
    invokeAction(name) {
      assert.equal(name, "shared-tags");
      return Promise.resolve({
        tags: [{ id: "shared-id", name: "Shared saved", color: "#22c55e" }],
        tasks: { "task-1": [{ id: "shared-id", name: "Shared saved", color: "#22c55e" }] },
      });
    },
  };

  let CardTags;
  let RowTags;
  let filter;
  plugin.initialize(
    {
      registerComponent(slot, Component) {
        if (slot === "task-card-tags") CardTags = Component;
        if (slot === "task-row-metadata") RowTags = Component;
      },
      registerTaskMenuAction() {},
      registerTaskFilter(registration) { filter = registration; },
    },
    host,
  );
  await flush();

  assert.ok(filter.matches({ taskId: "task-1" }, ["shared-id"]), "board filter reads the shared assignment index");
  assert.ok(!filter.matches({ taskId: "task-1" }, ["private-id"]), "private compatibility IDs do not leak into shared filtering");

  const getTree = host.mount(CardTags, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();
  const rendered = JSON.stringify(getTree());
  assert.match(rendered, /Shared saved/);
  assert.match(rendered, /Legacy saved/, "registered chip surfaces retain the private compatibility assignment");

  const getRowTree = host.mount(RowTags, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();
  const rowRendered = JSON.stringify(getRowTree());
  assert.match(rowRendered, /Shared saved/);
  assert.match(rowRendered, /Legacy saved/, "the registered dense task row retains the private compatibility assignment");
  plugin.destroy();
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

test("Tier 0/1 host (no registerTaskListFacet, no host.taskFilters/listByKey) stays manage-only and registers no facet", async () => {
  // This is the tier every currently shipped host runs: registerTaskFilter is
  // present, but the task-list facet contract and the filter-selection API are
  // not. The plugin must degrade to management + the built-in filter section
  // without registering a facet or leaving a subscription behind.
  const plugin = loadBundle();
  const registered = { components: [], filters: [], facets: 0 };
  let unsubscribed = 0;
  const host = makeMinimalHost({
    storage: {
      get: () => Promise.resolve({ value: [{ id: "t1", name: "urgent", color: "#ef4444" }] }),
      subscribe: () => () => { unsubscribed += 1; },
      // deliberately no listByKey -- capabilities.scanStorage is false here
    },
  });
  assert.doesNotThrow(() => {
    plugin.initialize(
      {
        registerComponent(slot) { registered.components.push(slot); },
        registerTaskMenuAction() {},
        registerTaskFilter(registration) { registered.filters.push(registration); },
        // no registerTaskListFacet -- the host contract does not exist yet
      },
      host,
    );
  });
  await flush();

  assert.ok(registered.components.includes("main-top-bar"), "the Tags box still registers");
  assert.equal(registered.filters.length, 1, "the built-in filter fallback still registers");
  assert.equal(registered.filters[0].hidden, false, "its section stays visible without the selection API");
  assert.equal(registered.facets, 0, "no task-list facet is advertised on a host that cannot consume one");

  const capabilities = plugin.__internal.detectHostCapabilities(
    { registerTaskFilter() {} },
    host,
  );
  assert.equal(capabilities.filterSelectionApi, false, "the Select is not rendered on this tier");
  assert.equal(capabilities.scanStorage, false);

  assert.doesNotThrow(() => plugin.destroy());
});

test("task-list facet is feature-detected and resolves catalog, legacy, and orphaned task tags", async () => {
  const plugin = loadBundle();
  let facet = null;
  const host = makeMinimalHost({
    storage: {
      get(scope, scopeId) {
        if (scope === "workspace") {
          return Promise.resolve({ value: [{ id: "t1", name: "Urgent", color: "#ef4444" }] });
        }
        return Promise.resolve(undefined);
      },
      subscribe: () => () => {},
      listByKey: () =>
        Promise.resolve({
          entries: [
            { scopeId: "task-1", value: ["t1", "legacy"] },
            { scopeId: "task-2", value: ["tag-deleted-123"] },
          ],
          truncated: false,
        }),
    },
  });
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction() {},
      registerTaskListFacet(registration) {
        facet = registration;
      },
    },
    host,
  );
  await flush();

  assert.ok(facet, "registers only when the newer host contract is present");
  assert.equal(facet.id, "tags");
  assert.equal(facet.label, "Tag");
  assertStructural.deepEqual(facet.getValues({ workspaceId: "ws-1", taskId: "task-1" }), [
    { value: "t1", label: "Urgent", color: "#ef4444" },
    { value: "legacy", label: "legacy", color: "#6b7280" },
  ]);
  assertStructural.deepEqual(
    facet.getValues({ workspaceId: "ws-1", taskId: "task-2" }),
    [],
    "generated orphan IDs never become task-list values",
  );
  assertStructural.deepEqual(
    facet.getValues({ workspaceId: "ws-other", taskId: "task-1" }),
    [],
    "a prior workspace catalog never leaks into another workspace",
  );
});

test("task-list facet resolves the shared workspace catalog (not the legacy private one) when the host supports actions", async () => {
  const plugin = loadBundle();
  let facet = null;
  const host = makeMinimalHost({
    storage: {
      // The legacy per-user catalog is deliberately stale/wrong here: a
      // host with the shared-tags action must never fall back to it while
      // that action succeeds.
      get: () => Promise.resolve({ value: [{ id: "stale", name: "Stale", color: "#000000" }] }),
      subscribe: () => () => {},
      listByKey: () => Promise.resolve({ entries: [], truncated: false }),
    },
    api: {
      invokeAction(key, input) {
        assert.equal(key, "shared-tags");
        assertStructural.deepEqual(input, { workspaceId: "ws-1" });
        return Promise.resolve({
          tags: [{ id: "t1", name: "Urgent", color: "#ef4444" }],
          tasks: { "task-1": [{ id: "t1", name: "Urgent", color: "#ef4444" }] },
        });
      },
    },
  });
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction() {},
      registerTaskListFacet(registration) {
        facet = registration;
      },
    },
    host,
  );
  await flush();

  assertStructural.deepEqual(facet.getValues({ workspaceId: "ws-1", taskId: "task-1" }), [
    { value: "t1", label: "Urgent", color: "#ef4444" },
  ]);
});

test("task-list facet falls back to the legacy private catalog when the shared-tags action fails", async () => {
  const plugin = loadBundle();
  let facet = null;
  const host = makeMinimalHost({
    storage: {
      get: (scope) => {
        if (scope === "workspace") {
          return Promise.resolve({ value: [{ id: "t1", name: "Urgent", color: "#ef4444" }] });
        }
        return Promise.resolve(undefined);
      },
      subscribe: () => () => {},
      listByKey: () =>
        Promise.resolve({ entries: [{ scopeId: "task-1", value: ["t1"] }], truncated: false }),
    },
    api: {
      invokeAction: () => Promise.reject(apiError(404, "plugin action not found")),
    },
  });
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction() {},
      registerTaskListFacet(registration) {
        facet = registration;
      },
    },
    host,
  );
  await flush();

  assertStructural.deepEqual(facet.getValues({ workspaceId: "ws-1", taskId: "task-1" }), [
    { value: "t1", label: "Urgent", color: "#ef4444" },
  ]);
});

test("task-list facet re-projects live when a shared tag is renamed or a task-tag action lands", async () => {
  const plugin = loadBundle();
  let facet = null;
  let notified = 0;
  // Shared-tags hosts never write CATALOG_SCOPE/TASK_SCOPE storage -- every
  // mutation is an action followed by refreshSharedTags() -- so the facet
  // must react to the shared store, not to its own storage subscriptions.
  let payload = {
    tags: [{ id: "t1", name: "Urgent", color: "#ef4444" }],
    tasks: { "task-1": [{ id: "t1", name: "Urgent", color: "#ef4444" }] },
  };
  const host = makeMinimalHost({
    storage: {
      get: () => Promise.resolve(undefined),
      subscribe: () => () => {},
      listByKey: () => Promise.resolve({ entries: [], truncated: false }),
    },
    api: { invokeAction: () => Promise.resolve(payload) },
  });
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction() {},
      registerTaskListFacet(registration) {
        facet = registration;
      },
    },
    host,
  );
  await flush();
  facet.subscribe(() => {
    notified += 1;
  });

  assertStructural.deepEqual(facet.getValues({ workspaceId: "ws-1", taskId: "task-1" }), [
    { value: "t1", label: "Urgent", color: "#ef4444" },
  ]);

  // A rename plus a task-tag-add, as the Tags box would apply them.
  payload = {
    tags: [{ id: "t1", name: "Defect", color: "#22c55e" }],
    tasks: {
      "task-1": [{ id: "t1", name: "Defect", color: "#22c55e" }],
      "task-2": [{ id: "t1", name: "Defect", color: "#22c55e" }],
    },
  };
  plugin.__internal.fetchSharedTags(host, "ws-1");
  await flush();

  assert.ok(notified > 0, "the facet notifies the task list instead of going stale");
  assertStructural.deepEqual(facet.getValues({ workspaceId: "ws-1", taskId: "task-1" }), [
    { value: "t1", label: "Defect", color: "#22c55e" },
  ]);
  assertStructural.deepEqual(
    facet.getValues({ workspaceId: "ws-1", taskId: "task-2" }),
    [{ value: "t1", label: "Defect", color: "#22c55e" }],
    "a newly tagged task leaves the Untagged section without a reload",
  );
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

test("registerTaskFilter keeps shared state authoritative through update failure and lifecycle changes", async () => {
  let nextTimer = 1;
  const timers = new Map();
  const storeListeners = new Set();
  let activeWorkspaceId = "ws-1";
  let privateReads = 0;
  let response = apiError(503, "plugin is not active");
  let filterRegistration = null;
  const plugin = loadBundle(makeFakeConsole().console, {
    setTimeout(fn, delay) {
      const id = nextTimer++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const host = makeMinimalHost({
    api: {
      invokeAction() {
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      },
    },
    store: {
      getState: () => ({ workspaces: { activeId: activeWorkspaceId } }),
      subscribe(listener) {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
    storage: {
      get() {
        privateReads += 1;
        return Promise.resolve({
          value: [{ id: "legacy", name: "Legacy", color: "#ef4444" }],
          updatedAt: "t0",
        });
      },
      subscribe: () => () => {},
    },
  });
  const registry = {
    registerComponent() {},
    registerTaskMenuAction() {},
    registerTaskFilter(registration) {
      filterRegistration = registration;
    },
  };

  plugin.initialize(registry, host);
  await flush();

  assert.equal(privateReads, 0, "a 503 does not read the private fallback");
  assertStructural.deepEqual(filterRegistration.getOptions().map((option) => option.value), ["__untagged__"]);
  assert.equal(timers.size, 1);
  const firstRetryId = [...timers.keys()][0];

  activeWorkspaceId = "ws-2";
  [...storeListeners].forEach((listener) => listener());
  await flush();

  assert.equal(timers.has(firstRetryId), false, "workspace change cancels the old retry");
  assert.equal(timers.size, 1, "the new workspace owns one bounded retry");
  const secondRetryId = [...timers.keys()][0];

  plugin.initialize(registry, host);
  await flush();

  assert.equal(timers.has(secondRetryId), false, "re-initialize cancels the prior generation's retry");
  assert.equal(timers.size, 1);

  response = {
    tags: [{ id: "shared", name: "Shared", color: "#22c55e" }],
    tasks: { "task-1": [{ id: "shared", name: "Shared", color: "#22c55e" }] },
  };
  const recovery = [...timers.entries()][0];
  timers.delete(recovery[0]);
  recovery[1].fn();
  await flush();

  const values = filterRegistration.getOptions().map((option) => option.value);
  assert.ok(values.includes("shared"), "the mounted filter adopts the recovered shared catalog");
  assert.equal(values.includes("legacy"), false);
  assert.equal(filterRegistration.matches({ taskId: "task-1" }, ["shared"]), true);
  assert.equal(privateReads, 0, "recovery never consults private storage");
  plugin.destroy();
  assert.equal(timers.size, 0);
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

  /** Registers against a fresh fake-React host, returning that load's task-row-metadata component. */
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
    return { host, RowTags: components["task-row-metadata"] };
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
 * array (effects use React-like dependency comparison; state setters
 * re-invoke the component), and jsx() records the element tree as plain
 * objects so tests can walk it.
 */
function makeFakeReactHost() {
  let hookIndex;
  const hookStates = [];
  let renderComponent = null;
  let tree;
  let rendering = false;
  let rerenderQueued = false;

  function rerender() {
    if (rendering) {
      rerenderQueued = true;
      return;
    }
    do {
      rerenderQueued = false;
      hookIndex = 0;
      rendering = true;
      tree = renderComponent();
      rendering = false;
    } while (rerenderQueued);
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
      const previous = hookStates[i];
      const changed =
        !previous ||
        !Array.isArray(deps) ||
        !Array.isArray(previous.deps) ||
        deps.length !== previous.deps.length ||
        deps.some((dependency, index) => !Object.is(dependency, previous.deps[index]));
      if (!changed) return;
      if (previous && typeof previous.cleanup === "function") previous.cleanup();
      const effect = { deps, cleanup: undefined };
      hookStates[i] = effect;
      effect.cleanup = fn();
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
    Select: "ui-Select",
    SelectTrigger: "ui-SelectTrigger",
    SelectValue: "ui-SelectValue",
    SelectContent: "ui-SelectContent",
    SelectItem: "ui-SelectItem",
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

function findTestNode(node, testId) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTestNode(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (node.props && node.props["data-testid"] === testId) return node;
  for (const child of node.children || []) {
    const found = findTestNode(child, testId);
    if (found) return found;
  }
  return null;
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

test("a cold private catalog 503 never looks empty and recovers on focus without a write", async () => {
  let focusListener;
  let interval;
  let available = false;
  let reads = 0;
  let writes = 0;
  const saved = [{ id: "t1", name: "urgent", color: "#ef4444" }];
  const plugin = loadBundle(makeFakeConsole().console, {
    window: {
      setInterval(fn) { interval = fn; return 1; },
      clearInterval: () => {},
      addEventListener(type, listener) { if (type === "focus") focusListener = listener; },
      removeEventListener: () => {},
    },
  });
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get() {
      reads += 1;
      return available
        ? Promise.resolve({ value: saved, updatedAt: "t0" })
        : Promise.reject(apiError(503, "plugin storage: get failed with status 503"));
    },
    set() { writes += 1; return Promise.resolve(); },
    subscribe: () => () => {},
  };
  const Dropdown = plugin.__internal.makeTagsTopBarDropdown(fakeHost, {
    taskFilter: false, filterSelectionApi: false, scanStorage: false,
  });
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  assert.equal(reads, 1);
  assert.ok(focusListener, "foreground recovery is registered");
  assert.match(JSON.stringify(getTree()), /Could not load tags/);
  assert.doesNotMatch(JSON.stringify(getTree()), /No tags yet/);

  available = true;
  interval();
  await flush();
  assert.equal(reads, 1, "the shared poll does not restart an exhausted private read");
  focusListener();
  await flush();
  assert.equal(reads, 2);
  assert.match(JSON.stringify(getTree()), /urgent/);
  assert.doesNotMatch(JSON.stringify(getTree()), /Could not load tags/);
  assert.equal(writes, 0, "recovery never replaces persisted tags");
  plugin.destroy();
});

test("private catalog retries stop at three attempts and explicit Retry recovers it", async () => {
  const timers = new Map();
  let nextTimer = 0;
  let interval;
  let available = false;
  let reads = 0;
  let writes = 0;
  const saved = [{ id: "t1", name: "urgent", color: "#ef4444" }];
  const plugin = loadBundle(makeFakeConsole().console, {
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: {
      setInterval(fn) { interval = fn; return 1; },
      clearInterval() {},
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const host = makeFakeReactHost();
  host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  host.storage = {
    get() {
      reads += 1;
      return available
        ? Promise.resolve({ value: saved, updatedAt: "t0" })
        : Promise.reject(apiError(503, "plugin storage: get failed with status 503"));
    },
    set() { writes += 1; return Promise.resolve(); },
    subscribe: () => () => {},
  };
  const Dropdown = plugin.__internal.makeTagsTopBarDropdown(host, {
    taskFilter: false, filterSelectionApi: false, scanStorage: false,
  });
  const getTree = host.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  // The board may mount several tag surfaces while the same failed store is
  // still observed. Those mounts must join its existing retry window.
  const otherHosts = [];
  for (let i = 0; i < 3; i += 1) {
    const otherHost = makeFakeReactHost();
    otherHost.store = host.store;
    otherHost.storage = host.storage;
    const OtherDropdown = plugin.__internal.makeTagsTopBarDropdown(otherHost, {
      taskFilter: false, filterSelectionApi: false, scanStorage: false,
    });
    otherHost.mount(OtherDropdown, { slotProps: { workspaceId: "ws-1" } });
    otherHosts.push(otherHost);
  }
  await flush();
  assert.equal(reads, 1, "additional mounted surfaces do not restart the failed read");

  for (const delay of [250, 1000, 3000]) {
    assert.equal(timers.size, 1, "one automatic retry is pending");
    const [id, timer] = [...timers.entries()][0];
    assert.equal(timer.delay, delay);
    timers.delete(id);
    timer.fn();
    await flush();
  }
  assert.equal(reads, 4, "the initial read plus three retries exhaust the budget");
  assert.equal(timers.size, 0);
  interval();
  await flush();
  assert.equal(reads, 4, "the shared poll cannot create an endless private retry loop");
  assert.match(JSON.stringify(getTree()), /Could not load tags/);
  assert.doesNotMatch(JSON.stringify(getTree()), /No tags yet/);

  available = true;
  const retry = findTestNode(getTree(), "kandev-tags-topbar-retry");
  assert.ok(retry);
  retry.props.onClick();
  await flush();
  assert.equal(reads, 5);
  assert.match(JSON.stringify(getTree()), /urgent/);
  assert.doesNotMatch(JSON.stringify(getTree()), /Could not load tags/);
  assert.equal(writes, 0);
  plugin.destroy();
});

test("a cold private task-tag 503 shows chip recovery state and Retry restores saved chips", async () => {
  const timers = new Map();
  const listeners = {};
  let nextTimer = 0;
  let available = false;
  let taskReads = 0;
  let writes = 0;
  const saved = [{ id: "t1", name: "urgent", color: "#ef4444" }];
  const plugin = loadBundle(makeFakeConsole().console, {
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: {
      setInterval: () => 1,
      clearInterval() {},
      addEventListener(type, listener) { listeners[type] = listener; },
      removeEventListener(type) { delete listeners[type]; },
    },
  });
  const host = makeFakeReactHost();
  host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  host.storage = {
    get(scope) {
      if (scope === "workspace") return Promise.resolve({ value: saved, updatedAt: "t0" });
      taskReads += 1;
      return available
        ? Promise.resolve({ value: ["t1"], updatedAt: "t0" })
        : Promise.reject(apiError(503, "plugin storage: get failed with status 503"));
    },
    set() { writes += 1; return Promise.resolve(); },
    subscribe: () => () => {},
  };
  const Chips = plugin.__internal.makeTagChips(host, { removable: false });
  const getTree = host.mount(Chips, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
  await flush();
  const error = findTestNode(getTree(), "kandev-tags-chip-load-error");
  assert.ok(error, "a cold task-tag failure must not look like a confirmed tagless task");
  assert.match(JSON.stringify(error), /Could not load tags/);
  assert.ok(findTestNode(getTree(), "kandev-tags-chip-retry"), "chip surfaces offer direct recovery");

  for (const delay of [250, 1000, 3000]) {
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers.entries()][0];
    assert.equal(timer.delay, delay);
    timers.delete(id);
    timer.fn();
    await flush();
  }
  assert.equal(taskReads, 4);
  assert.equal(timers.size, 0);
  available = true;
  const retry = findTestNode(getTree(), "kandev-tags-chip-retry");
  retry.props.onClick({ stopPropagation() {} });
  await flush();
  assert.equal(taskReads, 5);
  assert.match(JSON.stringify(getTree()), /urgent/);
  assert.equal(writes, 0, "recovery reads persisted tags without overwriting them");
  plugin.destroy();
  assert.equal(timers.size, 0, "unload leaves no private retry behind");
});

test("confirmed shared chips stay visible beside a cold private read error on cards and dense rows", async () => {
  for (const options of [
    { removable: true },
    { removable: false, dense: true },
  ]) {
    for (const failedScope of ["task", "workspace"]) {
      let available = false;
      let writes = 0;
      const plugin = loadBundle(makeFakeConsole().console);
      const host = makeFakeReactHost();
      host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
      host.storage = {
        get(scope) {
          if (scope === failedScope && !available) {
            return Promise.reject(apiError(503, "plugin storage: get failed with status 503"));
          }
          return Promise.resolve({
            value: scope === "task" ? ["private"] : [{ id: "private", name: "Private saved", color: "#ef4444" }],
            updatedAt: "t0",
          });
        },
        set() { writes += 1; return Promise.resolve(); },
        subscribe: () => () => {},
      };
      host.api = {
        invokeAction(key) {
          assert.equal(key, "shared-tags");
          return Promise.resolve({
            tags: [{ id: "shared", name: "Shared saved", color: "#22c55e" }],
            tasks: { "task-1": [{ id: "shared", name: "Shared saved", color: "#22c55e" }] },
          });
        },
      };
      const getTree = host.mount(plugin.__internal.makeTagChips(host, options), {
        slotProps: { taskId: "task-1", workspaceId: "ws-1" },
      });
      await flush();

      assert.equal(getTree().props["data-testid"], "kandev-tags-chip-row");
      assert.ok(findTestNode(getTree(), "kandev-tags-chip"), "confirmed shared chip remains visible");
      assert.match(JSON.stringify(getTree()), /Shared saved/);
      assert.ok(findTestNode(getTree(), "kandev-tags-chip-load-error"), "the unknown private layer stays visible");
      if (options.dense) {
        assert.equal(getTree().props.style.flexWrap, "wrap", "dense rows leave room for the warning beside shared chips");
        assert.equal(getTree().props.style.overflow, "visible");
      }
      const retry = findTestNode(getTree(), "kandev-tags-chip-retry");
      assert.ok(retry);

      available = true;
      retry.props.onClick({ stopPropagation() {} });
      await flush();
      assert.match(JSON.stringify(getTree()), /Shared saved/);
      assert.match(JSON.stringify(getTree()), /Private saved/);
      assert.equal(findTestNode(getTree(), "kandev-tags-chip-load-error"), null);
      assert.equal(writes, 0);
      plugin.destroy();
    }
  }
});

test("simultaneous shared and private 503s show chip recovery instead of an empty slot", async () => {
  let available = false;
  let writes = 0;
  const plugin = loadBundle(makeFakeConsole().console);
  const host = makeFakeReactHost();
  host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  host.storage = {
    get(scope) {
      return available
        ? Promise.resolve({ value: scope === "task" ? ["private"] : [{ id: "private", name: "Private saved", color: "#ef4444" }], updatedAt: "t0" })
        : Promise.reject(apiError(503, "plugin storage: get failed with status 503"));
    },
    set() { writes += 1; return Promise.resolve(); },
    subscribe: () => () => {},
  };
  host.api = {
    invokeAction() {
      return available
        ? Promise.resolve({ tags: [], tasks: { "task-1": [{ id: "shared", name: "Shared saved", color: "#22c55e" }] } })
        : Promise.reject(apiError(503, "required persistence is unavailable"));
    },
  };
  const getTree = host.mount(plugin.__internal.makeTagChips(host, { removable: false, dense: true }), {
    slotProps: { taskId: "task-1", workspaceId: "ws-1" },
  });
  await flush();
  assert.ok(findTestNode(getTree(), "kandev-tags-chip-load-error"));
  const retry = findTestNode(getTree(), "kandev-tags-chip-retry");
  assert.ok(retry);

  available = true;
  retry.props.onClick({ stopPropagation() {} });
  await flush();
  assert.match(JSON.stringify(getTree()), /Shared saved/);
  assert.match(JSON.stringify(getTree()), /Private saved/);
  assert.equal(findTestNode(getTree(), "kandev-tags-chip-load-error"), null);
  assert.equal(writes, 0);
  plugin.destroy();
});

test("destroy ignores a late failed private read without scheduling a retry", async () => {
  const timers = new Map();
  let nextTimer = 0;
  let rejectRead;
  const plugin = loadBundle(makeFakeConsole().console, {
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    window: {
      setInterval: () => 1,
      clearInterval() {},
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const host = makeFakeReactHost();
  host.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  host.storage = {
    get() { return new Promise((_, reject) => { rejectRead = reject; }); },
    subscribe: () => () => {},
  };
  const Dropdown = plugin.__internal.makeTagsTopBarDropdown(host, {
    taskFilter: false, filterSelectionApi: false, scanStorage: false,
  });
  host.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  plugin.destroy();
  rejectRead(apiError(503, "plugin storage: get failed with status 503"));
  await flush();
  assert.equal(timers.size, 0, "the old store cannot schedule a retry after unload");
});

test("a hard reload during a private task-tag 503 restores card and dense row chips after recovery", async () => {
  const saved = [{ id: "t1", name: "urgent", color: "#ef4444" }];
  for (const options of [{ removable: true }, { removable: false, dense: true }]) {
    let available = false;
    let focusListener;
    const plugin = loadBundle(makeFakeConsole().console, {
      window: {
        setInterval: () => 1,
        clearInterval: () => {},
        addEventListener(type, listener) { if (type === "focus") focusListener = listener; },
        removeEventListener: () => {},
      },
    });
    const fakeHost = makeFakeReactHost();
    fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
    fakeHost.storage = {
      get(scope) {
        if (!available) return Promise.reject(apiError(503, "plugin storage: get failed with status 503"));
        return Promise.resolve({ value: scope === "task" ? ["t1"] : saved, updatedAt: "t0" });
      },
      subscribe: () => () => {},
    };
    const Chips = plugin.__internal.makeTagChips(fakeHost, options);
    const getTree = fakeHost.mount(Chips, { slotProps: { taskId: "task-1", workspaceId: "ws-1" } });
    await flush();
    const error = findTestNode(getTree(), "kandev-tags-chip-load-error");
    assert.ok(error, "an unconfirmed task read renders recovery state instead of looking tagless");
    assert.match(JSON.stringify(error), /Could not load tags/);

    available = true;
    focusListener();
    await flush();
    assert.match(JSON.stringify(getTree()), /urgent/);
    assert.equal(getTree().props["data-testid"], "kandev-tags-chip-row");
    plugin.destroy();
  }
});

test("private catalog keeps its last confirmed rows across 503 and refreshes on reconnect", async () => {
  const listeners = {};
  let notifyStorage;
  let available = true;
  let reads = 0;
  const saved = [{ id: "t1", name: "urgent", color: "#ef4444" }];
  const plugin = loadBundle(makeFakeConsole().console, {
    window: {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener(type, listener) { listeners[type] = listener; },
      removeEventListener(type) { delete listeners[type]; },
    },
  });
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get() {
      reads += 1;
      return available
        ? Promise.resolve({ value: saved, updatedAt: "t0" })
        : Promise.reject(apiError(503, "plugin storage: get failed with status 503"));
    },
    subscribe(filter, listener) { notifyStorage = listener; return () => {}; },
  };
  const Dropdown = plugin.__internal.makeTagsTopBarDropdown(fakeHost, {
    taskFilter: false, filterSelectionApi: false, scanStorage: false,
  });
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();
  assert.match(JSON.stringify(getTree()), /urgent/);

  available = false;
  notifyStorage();
  await flush();
  assert.match(JSON.stringify(getTree()), /urgent/, "a failed refresh retains confirmed rows");
  assert.match(JSON.stringify(getTree()), /Could not load tags/);

  available = true;
  listeners.online();
  await flush();
  assert.equal(reads, 3);
  assert.match(JSON.stringify(getTree()), /urgent/);
  assert.doesNotMatch(JSON.stringify(getTree()), /Could not load tags/);
  plugin.destroy();
  assert.equal(listeners.online, undefined, "reconnect listener is removed on unload");
});

test("nontransient private storage errors remain visible without periodic retry", async () => {
  let interval;
  let focus;
  let reads = 0;
  const plugin = loadBundle(makeFakeConsole().console, {
    window: {
      setInterval(fn) { interval = fn; return 1; },
      clearInterval: () => {},
      addEventListener(type, listener) { if (type === "focus") focus = listener; },
      removeEventListener: () => {},
    },
  });
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get() { reads += 1; return Promise.reject(apiError(403, "plugin storage: get failed with status 403")); },
    subscribe: () => () => {},
  };
  const Dropdown = plugin.__internal.makeTagsTopBarDropdown(fakeHost, {
    taskFilter: false, filterSelectionApi: false, scanStorage: false,
  });
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();
  interval();
  focus();
  await flush();
  assert.equal(reads, 1);
  assert.match(JSON.stringify(getTree()), /Could not load tags/);
  assert.doesNotMatch(JSON.stringify(getTree()), /No tags yet/);
  plugin.destroy();
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

test("makeFakeReactHost re-runs changed dependency effects and cleans up", () => {
  const fakeHost = makeFakeReactHost();
  const events = [];
  function Component() {
    const state = fakeHost.React.useState("one");
    const value = state[0];
    const setValue = state[1];
    fakeHost.React.useEffect(() => {
      events.push("run:" + value);
      return () => events.push("cleanup:" + value);
    }, [value]);
    return fakeHost.jsx("button", { onClick: () => setValue("two") });
  }

  const getTree = fakeHost.mount(Component, {});
  getTree().props.onClick();
  getTree().props.onClick();
  assertStructural.deepEqual(events, ["run:one", "cleanup:one", "run:two"]);
});

test("shared-tags: a definitive failure cancels the retry an earlier outage armed", async () => {
  // A 503 arms the retry timer. A later *definitive* failure (a refusal, not a
  // transport blip and not "this host has no such action") has to drop it: the
  // armed timer would otherwise fire the action the host just rejected for good,
  // and the spent retry budget would be missing for the next real outage.
  let focusListener;
  const timers = new Map();
  const cleared = [];
  let nextTimerId = 1;
  const { console: fakeConsole, calls: logCalls } = makeFakeConsole();
  const plugin = loadBundle(fakeConsole, {
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
    window: {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener(type, listener) {
        if (type === "focus") focusListener = listener;
      },
      removeEventListener: () => {},
    },
  });
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = { get: () => Promise.resolve({ value: [], updatedAt: "t0" }), subscribe: () => () => {} };
  const invoked = [];
  let answer = apiError(503, "plugin is not active");
  fakeHost.api = {
    invokeAction(key) {
      invoked.push(key);
      return Promise.reject(answer);
    },
  };

  const Dropdown = makeTagsTopBarDropdown(fakeHost, { taskFilter: false, filterSelectionApi: false, scanStorage: false });
  fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();
  assert.equal(invoked.length, 1, "the box reads the shared catalog once on mount");
  assert.equal(timers.size, 1, "and the 503 arms one retry");
  assert.ok(logCalls.error.length > 0, "the transient failure is logged");

  answer = apiError(409, "workspace is locked");
  focusListener();
  await flush();
  assert.equal(invoked.length, 2, "focus re-reads it");
  assert.equal(timers.size, 0, "the armed retry is cancelled");
  assert.equal(cleared.length, 1, "by clearing the timer it set");

  Array.from(timers.values()).forEach((timer) => timer.callback());
  await flush();
  assert.equal(invoked.length, 2, "and a refusal is never retried");

  // The budget matters as much as the timer: the retry that just fired would
  // otherwise leave the schedule part-spent, so the next genuine outage would
  // wait through the later delays (or get no retry at all). A fresh 503 must arm
  // the FIRST delay again.
  answer = apiError(503, "plugin is not active");
  focusListener();
  await flush();
  assert.equal(invoked.length, 3, "the new outage is read once more");
  const armed = Array.from(timers.values());
  assert.equal(armed.length, 1, "and arms one retry");
  assert.equal(armed[0].delay, 250, "from the start of the schedule");
});

test("TagsTopBarDropdown reconciles a shared catalog deletion without clearing valid pending selections", async () => {
  let remoteTags = [{ id: "t1", name: "urgent", color: "#ef4444" }];
  let focusListener;
  const plugin = loadBundle(null, {
    window: {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener(type, listener) { if (type === "focus") focusListener = listener; },
      removeEventListener: () => {},
    },
  });
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = {
    get: () => Promise.resolve({ value: [], updatedAt: "t0" }),
    subscribe: () => () => {},
  };
  fakeHost.taskFilters = makeFakeTaskFilters(["t1"]);
  fakeHost.api = {
    invokeAction(key, input) {
      assert.equal(key, "shared-tags");
      assertStructural.deepEqual(input, { workspaceId: "ws-1" });
      return Promise.resolve({ tags: remoteTags, tasks: {} });
    },
  };

  const Dropdown = makeTagsTopBarDropdown(fakeHost, { taskFilter: true, filterSelectionApi: true, scanStorage: false });
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  assertStructural.deepEqual(fakeHost.taskFilters.getSelection(), ["t1"], "temporary unloaded catalog does not clear selection");
  await flush();
  assertStructural.deepEqual(fakeHost.taskFilters.getSelection(), ["t1"], "loaded catalog retains an existing tag");
  assert.equal(getTree().children[1].children[1].children[1].props.value, "t1");

  remoteTags = [];
  focusListener();
  await flush();
  assertStructural.deepEqual(fakeHost.taskFilters.getSelection(), [], "removed shared tag clears the host filter");
  assert.equal(getTree().children[1].children[1].children[1].props.value, plugin.__internal.ALL_TAGS_FILTER_VALUE);

  fakeHost.taskFilters.setSelection("tags", [plugin.__internal.UNTAGGED_FILTER_VALUE]);
  assertStructural.deepEqual(fakeHost.taskFilters.getSelection(), [plugin.__internal.UNTAGGED_FILTER_VALUE], "Untagged remains valid without a catalog entry");
});

test("TagsTopBarDropdown (Tier 2): renders a controlled Select and writes one filter value", async () => {
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
  const filterControl = content.children[1];
  const select = filterControl.children[1];
  assert.equal(select.type, fakeHost.ui.Select);
  assert.equal(select.props.value, plugin.__internal.ALL_TAGS_FILTER_VALUE);
  const rawOptions = select.children[1].children;
  const options = [rawOptions[0]].concat(rawOptions[1], [rawOptions[2]]);
  assert.equal(options[0].children[0], "All tags");
  assert.equal(options[1].props.value, "t1");
  assert.equal(options[1].children[0].children[1], "urgent");
  assert.equal(options[2].props.value, plugin.__internal.UNTAGGED_FILTER_VALUE);

  select.props.onValueChange("t1");
  await flush();
  assertStructural.deepEqual(fakeHost.taskFilters.getSelection(), ["t1"], "a tag selection writes exactly one value");

  tree = getTree();
  assert.equal(tree.children[1].children[1].children[1].props.value, "t1", "the Select reflects external/shared state");
  select.props.onValueChange(plugin.__internal.UNTAGGED_FILTER_VALUE);
  assertStructural.deepEqual(fakeHost.taskFilters.getSelection(), [plugin.__internal.UNTAGGED_FILTER_VALUE]);
  select.props.onValueChange(plugin.__internal.ALL_TAGS_FILTER_VALUE);
  assertStructural.deepEqual(fakeHost.taskFilters.getSelection(), []);
});

test("TagsTopBarDropdown (Tier 0/1): renders no Select -- manage-only", async () => {
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
  assert.equal(tree.children[1].children[1], null, "no filter control without host.taskFilters");
  const rows = tree.children[1].children[5];
  const row = rows[0];
  assert.equal(row.children.length, 3, "management rows do not double as filter controls");
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
  let rows = tree.children[1].children[5];
  let bugRow = rows.find((r) => r.children[1].props && r.children[1].props["data-testid"] === "kandev-tags-topbar-pill" && r.children[1].children[0] === "bug");
  bugRow.children[1].props.onClick();
  await flush();

  tree = getTree();
  rows = tree.children[1].children[5];
  bugRow = rows.find((r) => r.children[1].props && r.children[1].props["data-testid"] === "kandev-tags-topbar-rename-input");
  assert.ok(bugRow, "clicking the pill swaps it for a rename input");

  bugRow.children[1].props.onBlur({ target: { value: "urgent" } });
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
  const { TOPBAR_WIDTH, TOPBAR_DROPDOWN_Z_INDEX } = plugin.__internal;
  // An inline width, not a `w-[...]` class: Tailwind only emits an
  // arbitrary-value utility for literals it finds in source it scans, and the
  // host does not scan this bundle (see the TOPBAR_WIDTH comment).
  assert.equal(content.props.style.width, TOPBAR_WIDTH + "px");
  assert.equal(content.props.style.zIndex, TOPBAR_DROPDOWN_Z_INDEX);
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

  // Calibration, measured in Chrome at the input's computed 12px font:
  //   app font (self-hosted Figtree)      widest ASCII glyph 'm' = 11.22px
  //   fallback stack (Segoe UI / Arial)   widest ASCII glyph '@' = 12.18px
  // The plugin does not control which of those renders -- Figtree is
  // self-hosted, so the fallback only shows during the font-load window, but
  // the name must not scroll then either. 12 sits just under the fallback's
  // worst glyph and well above the app font's, which is the bound worth
  // holding: it keeps MAX_TAG_LENGTH at a value that survives both. Raising
  // the cap to 23 fits the app font (258px) but not the fallback (280px),
  // and this test is meant to fail in that case rather than ship a name
  // length that scrolls for some users.
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
  const createRow = content.children[3];
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

  const rows = getTree().children[1].children[5];
  rows.forEach((row) => {
    assert.equal(row.props.style.display, "grid");
    assert.equal(row.props.style.gridTemplateColumns, "20px 1fr 24px");
    const deleteButton = row.children[2];
    assert.equal(deleteButton.props["data-testid"], "kandev-tags-topbar-delete");
    assert.equal(deleteButton.props.style.width, "20px");
    assert.equal(deleteButton.props.style.height, "20px");
  });
});

test("Tags box: Tier 2 management rows retain the same three-column grid", async () => {
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

  const rows = getTree().children[1].children[5];
  assert.equal(rows[0].props.style.gridTemplateColumns, "20px 1fr 24px");
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

  let rows = getTree().children[1].children[5];
  const swatch = rows[0].children[0];
  assert.equal(swatch.props["data-testid"], "kandev-tags-topbar-color-swatch");
  assert.equal(swatch.props.style.background, "#ef4444");
  assert.equal(rows.length, 1, "no picker box before the swatch is clicked");

  swatch.props.onClick();
  await flush();

  rows = getTree().children[1].children[5];
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

  let rows = getTree().children[1].children[5];
  rows[0].children[0].props.onClick(); // open the picker
  await flush();

  rows = getTree().children[1].children[5];
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

  rows = getTree().children[1].children[5];
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

  let rows = getTree().children[1].children[5];
  rows[0].children[0].props.onClick();
  await flush();

  rows = getTree().children[1].children[5];
  rows[1].children[0].children[1].props.onClick(); // pick PALETTE[1]
  await flush();

  rows = getTree().children[1].children[5];
  const [cancelButton, updateButton] = rows[1].children[2].children;
  assert.equal(cancelButton.props["data-testid"], "kandev-tags-topbar-color-cancel");
  assert.equal(updateButton.props["data-testid"], "kandev-tags-topbar-color-update");
  updateButton.props.onClick();
  await flush();
  await flush();

  assert.equal(setCalls, 1, "exactly one catalog write on Update");

  rows = getTree().children[1].children[5];
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

  let rows = getTree().children[1].children[5];
  rows[0].children[0].props.onClick();
  await flush();

  rows = getTree().children[1].children[5];
  rows[1].children[0].children[1].props.onClick(); // pick a different palette color (pending only)
  await flush();

  rows = getTree().children[1].children[5];
  const [cancelButton] = rows[1].children[2].children;
  cancelButton.props.onClick();
  await flush();

  assert.equal(setCalls, 0, "Cancel issues no storage write");

  rows = getTree().children[1].children[5];
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

  let rows = getTree().children[1].children[5];
  rows[0].children[0].props.onClick(); // open t1's picker
  await flush();

  rows = getTree().children[1].children[5];
  const pickersAfterFirst = rows.filter((r) => r.props && r.props["data-testid"] === "kandev-tags-topbar-color-picker");
  assert.equal(pickersAfterFirst.length, 1);

  const t2Row = rows.find(
    (r) => r.props && r.props["data-testid"] === "kandev-tags-topbar-row" && r.children[1].children[0] === "urgent",
  );
  t2Row.children[0].props.onClick(); // open t2's picker
  await flush();

  rows = getTree().children[1].children[5];
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
  const [inputEl, createButtonEl] = content.children[3].children;
  assert.equal(inputEl.props["data-testid"], "kandev-tags-topbar-create-input");
  assert.equal(createButtonEl.props.disabled, true, "Create starts disabled with an empty draft");

  inputEl.props.onChange({ target: { value: "urgent" } });
  await flush();
  content = getTree().children[1];
  const [, createButtonAfterTyping] = content.children[3].children;
  assert.equal(createButtonAfterTyping.props.disabled, false, "Create enables once a valid name is typed");

  createButtonAfterTyping.props.onClick();
  await flush();
  await flush();

  tree = getTree();
  const rows = tree.children[1].children[5];
  assert.ok(Array.isArray(rows), "catalog list rendered (not the loading/empty placeholder)");
  const created = rows.find((r) => r.children[1].children[0] === "urgent");
  assert.ok(created, "the tag created via the top-bar dropdown's own Create input appears in its list");
});

test("Tags box: a duplicate refusal from the server is reported as a duplicate, not as a retry", async () => {
  // The local duplicate check lowers names while the backend folds them, so for a
  // few Unicode pairs (see findTagByName) it cannot predict the refusal. When that
  // happens the person must be told the name exists -- "please try again" would be
  // advice that can never work.
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = { get: () => Promise.resolve({ value: [], updatedAt: "t0" }), subscribe: () => () => {} };
  fakeHost.api = {
    invokeAction(key) {
      if (key === "tag-create") return Promise.reject(apiError(400, 'a tag named "\u03c2" already exists'));
      return Promise.resolve({ tags: [], tasks: {} });
    },
  };

  const capabilities = { taskFilter: false, filterSelectionApi: false, scanStorage: false };
  const Dropdown = makeTagsTopBarDropdown(fakeHost, capabilities);
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  const createRow = () => getTree().children[1].children[3];
  createRow().children[0].props.onChange({ target: { value: "\u03c2" } });
  await flush();
  createRow().children[1].props.onClick();
  await flush();
  await flush();

  const errorEl = getTree().children[1].children.find(
    (c) => c && c.props && c.props["data-testid"] === "kandev-tags-topbar-error",
  );
  assert.ok(errorEl, "the refusal is surfaced");
  assert.equal(errorEl.children[0], 'A tag named "\u03c2" already exists.');
});

test("Add-tag modal: a duplicate refusal from the server is reported as a duplicate too", async () => {
  // The same honest message has to hold on every surface that can hit the
  // refusal, not just the Tags box's own Create input.
  const plugin = loadBundle();
  const { makeTagPickerModal } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = { get: () => Promise.resolve({ value: [], updatedAt: "t0" }), subscribe: () => () => {} };
  fakeHost.api = {
    invokeAction(key) {
      if (key === "tag-create") return Promise.reject(apiError(409, 'a tag named "ς" already exists'));
      return Promise.resolve({ tags: [], tasks: {} });
    },
  };

  const TagPickerModal = makeTagPickerModal(fakeHost, "task-1", "ws-1");
  const getTree = fakeHost.mount(TagPickerModal, {});
  await flush();

  getTree().children[0].children[0].props.onChange({ target: { value: "ς" } });
  await flush();
  getTree().children[0].children[1].props.onClick();
  await flush();
  await flush();

  const errorNode = getTree().children.find((c) => c && c.props && c.props["data-testid"] === "kandev-tags-picker-error");
  assert.ok(errorNode, "the refusal is surfaced");
  assert.equal(errorNode.children[0], 'A tag named "ς" already exists.');
});

test("Tags box: deleting a shared tag asks first, and only then invokes tag-delete", async () => {
  // The README promises a confirmation stating how many cards carry the tag.
  // The action-capable tier used to delete on the first click; the cascade being
  // atomic on the backend is no reason to drop the confirmation.
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown, countSharedTasksWithTag } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = { get: () => Promise.resolve({ value: [], updatedAt: "t0" }), subscribe: () => () => {} };
  const invoked = [];
  const sharedPayload = {
    tags: [{ id: "t1", name: "bug", color: "#ef4444" }],
    tasks: { "task-1": [{ id: "t1" }], "task-2": [{ id: "t1" }] },
  };
  fakeHost.api = {
    invokeAction(key, input) {
      invoked.push({ key, input });
      if (key === "tag-delete") return Promise.resolve({ tags: [], tasks: {} });
      return Promise.resolve(sharedPayload);
    },
  };
  let opened = null;
  fakeHost.openModal = function (options) {
    opened = options;
    return { close() {} };
  };

  const Dropdown = makeTagsTopBarDropdown(fakeHost, { taskFilter: false, filterSelectionApi: false, scanStorage: false });
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  assert.equal(countSharedTasksWithTag(sharedPayload, "t1"), 2, "the payload is what the count comes from");

  getTree().children[1].children[5][0].children[2].props.onClick(); // the row's delete button
  await flush();
  assert.ok(opened, "a confirmation modal is opened");
  assert.equal(opened.title, "Delete tag");
  assertStructural.deepEqual(
    invoked.filter((call) => call.key === "tag-delete"),
    [],
    "nothing is deleted before the person confirms",
  );

  // The modal's own component renders the promise, then commits on confirm.
  const Confirm = opened.content;
  const confirmTree = fakeHost.mount(Confirm, {});
  await flush();
  const description = confirmTree().children[0];
  assert.match(description.children[0], /Remove .*bug.* from 2 cards\?/);

  const sharedReads = () => invoked.filter((call) => call.key === "shared-tags").length;
  const readsBefore = sharedReads();
  confirmTree().children[2].children[0].props.onClick(); // Delete
  for (let i = 0; i < 12; i++) await flush();

  const deletes = invoked.filter((call) => call.key === "tag-delete");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].input.body.id, "t1");
  // The refresh is what makes the box drop the deleted tag immediately: nothing
  // else writes the catalog storage on a shared host, so without it the row (and
  // the filter's option) survives until the 30s/on-focus poll.
  assert.ok(sharedReads() > readsBefore, "deleting re-reads the shared catalog");
});

test("delete confirmation: a failed count reads as unknown instead of stranding the modal", async () => {
  // Delete stays disabled while the count loads and the modal carries no cancel of
  // its own, so an unhandled rejection would leave the person on "Checking how many
  // cards use ..." with no way forward. Unknown is the honest answer.
  const { console: fakeConsole, calls } = makeFakeConsole();
  const plugin = loadBundle(fakeConsole);
  const { makeDeleteTagConfirm } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  const Confirm = makeDeleteTagConfirm({
    host: fakeHost,
    tag: { id: "t1", name: "bug", color: "#ef4444" },
    countTasks: () => Promise.reject(new Error("storage scan failed")),
    remove: () => Promise.resolve({ succeeded: 0, failed: 0, truncated: false }),
    onDeleted: () => {},
  });
  const getTree = fakeHost.mount(Confirm, {});
  await flush();
  await flush();

  assert.match(
    getTree().children[0].children[0],
    /This tag will be removed from every card that uses it/,
    "an unknown count, not a stuck loading line",
  );
  assert.equal(getTree().children[2].children[0].props.disabled, false, "and Delete stays reachable");
  assert.ok(calls.error.length > 0, "the failure is logged for the console");
});

test("delete confirmation: a partial cascade and a capped scan read as one sentence", async () => {
  // Both can happen at once, and the modal has a single error line: reporting them
  // as two setError calls in one tick would leave only the last, re-typed copy on
  // screen.
  const plugin = loadBundle();
  const { makeDeleteTagConfirm, TAG_SCAN_LIMIT } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  const Confirm = makeDeleteTagConfirm({
    host: fakeHost,
    tag: { id: "t1", name: "bug", color: "#ef4444" },
    countTasks: () => Promise.resolve(3),
    remove: () => Promise.resolve({ succeeded: 2, failed: 1, truncated: true }),
    onDeleted: () => {
      throw new Error("a partial, capped cascade must not report success");
    },
  });
  const getTree = fakeHost.mount(Confirm, {});
  await flush();
  getTree().children[2].children[0].props.onClick();
  await flush();

  const errorEl = getTree().children[1];
  assert.equal(errorEl.props["data-testid"], "kandev-tags-delete-error");
  assert.equal(
    errorEl.children[0],
    "Removed from 2 card(s); 1 card(s) failed to update. This host's scan stops at " +
      TAG_SCAN_LIMIT +
      " entries, so cards beyond it may still reference the tag.",
  );
});

test("delete confirmation: a capped scan is reported rather than passed off as a clean sweep", async () => {
  const plugin = loadBundle();
  const { makeDeleteTagConfirm } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  const Confirm = makeDeleteTagConfirm({
    host: fakeHost,
    tag: { id: "t1", name: "bug", color: "#ef4444" },
    countTasks: () => Promise.resolve(null),
    remove: () => Promise.resolve({ succeeded: 1, failed: 0, truncated: true }),
    onDeleted: () => {
      throw new Error("a truncated cascade must not report success");
    },
  });
  const getTree = fakeHost.mount(Confirm, {});
  await flush();

  assert.match(getTree().children[0].children[0], /removed from every card/, "a null count reads as unknown, not zero");
  getTree().children[2].children[0].props.onClick();
  await flush();
  const errorEl = getTree().children[1];
  assert.equal(errorEl.props["data-testid"], "kandev-tags-delete-error");
  assert.match(errorEl.children[0], /scan stops at 1000 entries/);
});

test("Tags box: deleting a private tag confirms first, then strips the card and the catalog", async () => {
  // The private tier is the documented fallback for hosts that predate plugin
  // actions, and its delete runs through the same parameterized confirmation as
  // the shared tier. Both writes are asserted because either one going missing
  // leaves the tag half-deleted: a surviving catalog entry keeps the tag listed
  // with no chips (or, with the write the other way round, chips for a tag that
  // no longer exists). The explicit refreshCatalog() after those writes is NOT
  // asserted: on a real host the plugin's own catalog write is echoed back to its
  // subscription and refreshes the box anyway, and this fake deliberately
  // suppresses echoes, so the call is redundant-but-harmless rather than load
  // bearing.
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = makeEchoSuppressingStorage();
  await fakeHost.storage.set("workspace", "ws-1", "tags-catalog", [{ id: "t1", name: "bug", color: "#ef4444" }]);
  await fakeHost.storage.set("task", "task-1", "tags", ["t1"]);
  fakeHost.storage.listByKey = () =>
    Promise.resolve({ entries: [{ scopeId: "task-1", value: ["t1"], updatedAt: "t0" }], truncated: false });
  let closed = 0;
  let opened = null;
  fakeHost.openModal = function (options) {
    opened = options;
    return {
      close() {
        closed += 1;
      },
    };
  };

  const Dropdown = makeTagsTopBarDropdown(fakeHost, { taskFilter: false, filterSelectionApi: false, scanStorage: false });
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  getTree().children[1].children[5][0].children[2].props.onClick(); // the row's delete button
  await flush();
  assert.ok(opened, "the private tier confirms too");
  assert.equal(opened.title, "Delete tag");

  // The harness keeps hook state per host, so mounting the confirmation on the
  // dropdown's host would make the two share (and corrupt) slots. Point the
  // component's React at a second host's methods and let that host own the render
  // loop: its jsx, ui and storage calls still belong to the host the dropdown
  // built it with.
  const confirmHost = makeFakeReactHost();
  Object.assign(fakeHost.React, confirmHost.React);
  const confirmTree = confirmHost.mount(opened.content, {});
  await flush();
  await flush();
  assert.match(confirmTree().children[0].children[0], /Remove .*bug.* from 1 card\?/);

  confirmTree().children[2].children[0].props.onClick(); // Delete
  for (let i = 0; i < 12; i++) await flush(); // cascade + catalog write + notify

  const card = await fakeHost.storage.get("task", "task-1", "tags");
  assertStructural.deepEqual(card.value, [], "the card no longer carries the tag");
  const catalog = await fakeHost.storage.get("workspace", "ws-1", "tags-catalog");
  assertStructural.deepEqual(catalog.value, [], "and the catalog no longer defines it");
  assert.equal(closed, 1, "the confirmation closes exactly once");
});

test("Tags box: a duplicate refusal on rename is reported as a duplicate too", async () => {
  const plugin = loadBundle();
  const { makeTagsTopBarDropdown } = plugin.__internal;
  const fakeHost = makeFakeReactHost();
  fakeHost.store = { getState: () => ({ workspaces: { activeId: "ws-1" } }) };
  fakeHost.storage = { get: () => Promise.resolve({ value: [], updatedAt: "t0" }), subscribe: () => () => {} };
  fakeHost.api = {
    invokeAction(key, input) {
      if (key === "tag-update") {
        assert.equal(input.body.name, "ς");
        return Promise.reject(apiError(409, 'a tag named "ς" already exists'));
      }
      return Promise.resolve({ tags: [{ id: "t1", name: "Σ", color: "#ef4444" }], tasks: {} });
    },
  };

  const Dropdown = makeTagsTopBarDropdown(fakeHost, { taskFilter: false, filterSelectionApi: false, scanStorage: false });
  const getTree = fakeHost.mount(Dropdown, { slotProps: { workspaceId: "ws-1" } });
  await flush();

  // The local clash check only runs on the private-storage path, so a shared
  // rename goes straight to the server -- which is how a fold-divergent clash
  // reaches this branch at all.
  getTree().children[1].children[5][0].children[1].props.onClick();
  await flush();
  const rows = getTree().children[1].children[5];
  const renameRow = rows.find((r) => r.children[1].props && r.children[1].props["data-testid"] === "kandev-tags-topbar-rename-input");
  assert.ok(renameRow, "clicking the pill swaps it for a rename input");
  renameRow.children[1].props.onBlur({ target: { value: "ς" } });
  await flush();
  await flush();

  const errorNode = getTree().children[1].children.find((c) => c && c.props && c.props["data-testid"] === "kandev-tags-topbar-error");
  assert.ok(errorNode, "the refusal is surfaced");
  assert.equal(errorNode.children[0], 'A tag named "ς" already exists.');
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
  let [inputEl] = content.children[3].children;
  inputEl.props.onChange({ target: { value: "  urgent  " } });
  await flush();

  content = getTree().children[1];
  const [, createButtonEl] = content.children[3].children;
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

test("countTasksWithTag refuses to call a capped page a count", async () => {
  // The promise the confirmation makes is "Remove x from N cards?"; a page the
  // host had to truncate cannot support that number, so the copy falls back to
  // the unknown-count wording instead of undercounting.
  const { countTasksWithTag } = loadBundle().__internal;
  const host = (truncated) => ({
    storage: {
      listByKey: () =>
        Promise.resolve({
          entries: [{ scopeId: "task-1", value: ["t1"], updatedAt: "t0" }],
          truncated,
        }),
    },
  });
  assert.equal(await countTasksWithTag(host(false), "t1"), 1);
  assert.equal(await countTasksWithTag(host(true), "t1"), null);
});

test("cascadeRemoveTagFromTasks reports a capped scan instead of claiming a clean sweep", async () => {
  const { cascadeRemoveTagFromTasks } = loadBundle().__internal;
  const written = {};
  const host = {
    storage: {
      listByKey: () =>
        Promise.resolve({ entries: [{ scopeId: "task-1", value: ["t1"], updatedAt: "t0" }], truncated: true }),
      get: () => Promise.resolve({ value: ["t1"], updatedAt: "t0" }),
      set(scope, scopeId, key, value) {
        written[scopeId] = value;
        return Promise.resolve({ updatedAt: "t1" });
      },
    },
  };
  const result = await cascadeRemoveTagFromTasks(host, "t1");
  assert.equal(result.succeeded, 1, "the entries it did see are still cleaned");
  assert.equal(result.truncated, true, "and the caller is told the scan was capped");
  assertStructural.deepEqual(written["task-1"], []);
});

test("countSharedTasksWithTag counts the tasks the shared payload records", () => {
  const { countSharedTasksWithTag } = loadBundle().__internal;
  const payload = {
    tags: [{ id: "t1", name: "bug", color: "#ef4444" }],
    tasks: {
      "task-1": [{ id: "t1" }],
      "task-2": [{ id: "t2" }],
      // Two entries for the same tag on one task: unreachable through any write
      // path (they all dedupe by tag id), but a migrated legacy document can
      // hold it, and the confirmation counts *cards*, so this task counts once.
      "task-3": [{ id: "t1" }, { id: "t1" }],
    },
  };
  assert.equal(countSharedTasksWithTag(payload, "t1"), 2, "two cards, three entries");
  assert.equal(countSharedTasksWithTag(payload, "t2"), 1);
  assert.equal(countSharedTasksWithTag(payload, "missing"), 0);
  assert.equal(countSharedTasksWithTag({ tags: [], tasks: {} }, "t1"), 0);
  assert.equal(countSharedTasksWithTag(null, "t1"), 0, "an unloaded payload counts nothing rather than throwing");
  assert.equal(countSharedTasksWithTag({ tags: [], tasks: { "task-1": [null] } }, "t1"), 0, "a malformed entry is skipped");
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

// ---------------------------------------------------------------------------
// Card-menu quick pick -- the children of the "Add tag..." entry on a host
// that renders plugin submenus (TaskMenuActionRegistration.items).
// ---------------------------------------------------------------------------

/**
 * A fake host whose shared-tags action serves `payload` and records every
 * action call. The quick list reads the shared store and nothing else, so the
 * legacy storage is a no-op stub: what the list offers is data the chip rows
 * have already loaded.
 */
function makeQuickPickHost(payload, overrides) {
  const calls = [];
  const host = makeFakeReactHost();
  host.store = {
    getState: () => ({ workspaces: { activeId: "ws-1" } }),
    subscribe: () => () => {},
  };
  host.storage = {
    get: () => Promise.resolve(undefined),
    subscribe: () => () => {},
  };
  host.api = {
    invokeAction(key, input) {
      calls.push({ key, input });
      return Promise.resolve(key === "shared-tags" ? payload : { tags: [] });
    },
  };
  Object.assign(host, overrides || {});
  return { host, calls };
}

/** Loads the shared store the chip rows keep warm; the quick list never fetches itself. */
async function primeSharedStore(plugin, host) {
  await plugin.__internal.fetchSharedTags(host, "ws-1");
  await flush();
}

/** One catalog tag plus the peer application that gives it a last-used time. */
function appliedTag(id, name, updatedAt) {
  const color = "#3b82f6";
  return {
    tag: { id, name, color },
    application: { id, name, color, updatedAt },
  };
}

test("card menu quick list puts More tags first, newest first, and hides never-applied tags", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const entries = [
    // An exact second: time.RFC3339Nano trims trailing zeros, so this string
    // is shorter than "…:00.5Z" yet earlier, which raw string order gets wrong.
    appliedTag("tag-a", "Blocked", "2026-01-01T00:00:00Z"),
    appliedTag("tag-b", "Needs review", "2026-01-01T00:00:00.5Z"),
    appliedTag("tag-c", "Customer", "2026-01-01T00:00:03Z"),
    appliedTag("tag-d", "Urgent", "2026-01-01T00:00:01Z"),
    // Nanosecond precision, which Date.parse only accepts once truncated.
    appliedTag("tag-f", "Long fraction", "2026-01-01T00:00:04.123456789Z"),
  ];
  const payload = {
    tags: entries.map((entry) => entry.tag),
    tasks: { "task-peer": entries.map((entry) => entry.application) },
  };
  const { host, calls } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  calls.length = 0;

  const items = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });

  assertStructural.deepEqual(
    items.map((item) => [item.id, item.label]),
    [
      ["more", "More tags\u2026"],
      ["tag-f", "Long fraction"],
      ["tag-c", "Customer"],
      ["tag-d", "Urgent"],
      ["tag-b", "Needs review"],
      ["tag-a", "Blocked"],
    ],
  );
  assert.equal(items[1].icon.type, "span");
  assert.equal(items[1].icon.props.style.backgroundColor, "#3b82f6");
  assert.equal(items[1].icon.props.style.borderRadius, "50%");
  assert.equal(items[0].separatorBefore, undefined, "More tags stays above the divider");
  assert.equal(items[1].separatorBefore, true, "the first quick tag starts a separate group");
  assert.equal(items.slice(2).every((item) => item.separatorBefore === false), true);
  assertStructural.deepEqual(calls, [], "the list is derived from cached state, never fetched");
});

test("card menu quick list falls back to the derived color for an invalid catalog color", async () => {
  const plugin = loadBundle();
  const { quickTagItems, colorFromName } = plugin.__internal;
  const entry = appliedTag("tag-invalid-color", "Unsafe color", "2026-01-01T00:00:01Z");
  entry.tag.color = "red; background-image: url(javascript:alert(1))";
  const { host } = makeQuickPickHost({
    tags: [entry.tag],
    tasks: { "task-peer": [entry.application] },
  });
  await primeSharedStore(plugin, host);

  const items = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });

  assert.equal(items[1].icon.props.style.backgroundColor, colorFromName("Unsafe color"));
});

test("card menu quick list never offers a tag nothing has applied", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const newer = appliedTag("tag-new", "Newer", "2026-01-01T00:00:02Z");
  const older = appliedTag("tag-old", "Older", "2026-01-01T00:00:01Z");
  // The never-applied tag sits first in the catalog and the list stays under
  // QUICK_TAG_LIMIT, so catalog order is what a missing last-used check would
  // fall back to here -- the cap cannot hide it.
  const payload = {
    tags: [{ id: "tag-never", name: "Never used", color: "#6b7280" }, newer.tag, older.tag],
    tasks: { "task-peer": [newer.application, older.application] },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);

  const items = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });

  assertStructural.deepEqual(items.map((item) => item.id), ["more", "tag-new", "tag-old"]);
});

test("card menu quick list caps the list and skips tags this card already carries", async () => {
  const plugin = loadBundle();
  const { quickTagItems, QUICK_TAG_LIMIT, setTaskTagCache } = plugin.__internal;
  const entries = [];
  for (let i = 0; i < QUICK_TAG_LIMIT + 3; i += 1) {
    entries.push(appliedTag("tag-" + i, "Tag " + i, "2026-01-01T00:00:0" + i + "Z"));
  }
  const payload = {
    tags: entries.map((entry) => entry.tag),
    tasks: {
      // This card carries tag-1 through the shared layer and tag-6 through the
      // legacy private one; the peer applications carry the recency.
      "task-1": [entries[1].application],
      "task-peer": entries.map((entry) => entry.application),
    },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  setTaskTagCache("task-1", ["tag-6"]);

  const items = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });

  assert.equal(
    items.length,
    1 + QUICK_TAG_LIMIT,
    "the picker entry plus at most QUICK_TAG_LIMIT tags",
  );
  assertStructural.deepEqual(
    items.map((item) => item.id),
    ["more", "tag-7", "tag-5", "tag-4", "tag-3", "tag-2"],
    "newest first, minus the tags this card already shows and capped at the limit",
  );
});

test("card menu quick list offers a catalog entry with a duplicated id once", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const duplicate = appliedTag("tag-dup", "Duplicate", "2026-01-01T00:00:01Z");
  const other = appliedTag("tag-other", "Other", "2026-01-01T00:00:02Z");
  const payload = {
    tags: [duplicate.tag, duplicate.tag, other.tag],
    tasks: { "task-peer": [duplicate.application, other.application] },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);

  const items = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });

  assertStructural.deepEqual(
    items.map((item) => item.id),
    ["more", "tag-other", "tag-dup"],
    "one child per id, so the host never builds two identical keys",
  );
});

test("card menu quick list is derived once per store value and rebuilt when the store changes", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const older = appliedTag("tag-old", "Older", "2026-01-01T00:00:01Z");
  const newer = appliedTag("tag-new", "Newer", "2026-01-01T00:00:02Z");
  const payload = {
    tags: [older.tag, newer.tag],
    tasks: { "task-peer": [older.application, newer.application] },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  const context = { taskId: "task-1", workspaceId: "ws-1" };

  const first = quickTagItems(host, context);
  assertStructural.deepEqual(first.map((item) => item.id), ["more", "tag-new", "tag-old"]);
  assert.equal(
    quickTagItems(host, context),
    first,
    "unchanged stores reuse the derived list instead of rescanning on every render",
  );

  payload.tasks["task-peer"][0].updatedAt = "2026-01-01T00:00:09Z";
  await primeSharedStore(plugin, host);

  const rebuilt = quickTagItems(host, context);
  assert.notEqual(rebuilt, first, "a refreshed store rebuilds the list");
  assertStructural.deepEqual(rebuilt.map((item) => item.id), ["more", "tag-old", "tag-new"]);
});

test("card menu quick list is derived per card, not per workspace", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const carried = appliedTag("tag-carried", "Carried", "2026-01-01T00:00:02Z");
  const free = appliedTag("tag-free", "Free", "2026-01-01T00:00:01Z");
  const payload = {
    tags: [carried.tag, free.tag],
    // task-1 already carries the newest tag; task-2 carries nothing.
    tasks: { "task-1": [carried.application], "task-peer": [carried.application, free.application] },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);

  const first = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });
  const second = quickTagItems(host, { taskId: "task-2", workspaceId: "ws-1" });

  assertStructural.deepEqual(first.map((item) => item.id), ["more", "tag-free"]);
  assertStructural.deepEqual(
    second.map((item) => item.id),
    ["more", "tag-carried", "tag-free"],
    "one card's applied tags do not leak into another card's list",
  );
});

test("card menu quick list drops a tag the card's private layer gains while the payload is unchanged", async () => {
  const plugin = loadBundle();
  const { quickTagItems, setTaskTagCache } = plugin.__internal;
  const carried = appliedTag("tag-carried", "Carried", "2026-01-01T00:00:02Z");
  const free = appliedTag("tag-free", "Free", "2026-01-01T00:00:01Z");
  const payload = {
    tags: [carried.tag, free.tag],
    tasks: { "task-peer": [carried.application, free.application] },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  const context = { taskId: "task-1", workspaceId: "ws-1" };
  assertStructural.deepEqual(
    quickTagItems(host, context).map((item) => item.id),
    ["more", "tag-carried", "tag-free"],
  );

  // The wide task-storage subscription, the filter's own prime, and the facet
  // all replace a task's private value without touching the shared payload, so
  // the memo has to invalidate on that identity too -- otherwise the list keeps
  // offering a tag the card already shows.
  setTaskTagCache("task-1", ["tag-carried"]);

  assertStructural.deepEqual(
    quickTagItems(host, context).map((item) => item.id),
    ["more", "tag-free"],
  );
});

test("card menu quick list ignores a timestamp it cannot parse", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const numeric = appliedTag("tag-numeric", "Numeric", "2026-01-01T00:00:02Z");
  const garbage = appliedTag("tag-garbage", "Garbage", "2026-01-01T00:00:03Z");
  const missing = appliedTag("tag-missing", "Missing", "2026-01-01T00:00:04Z");
  const fresh = appliedTag("tag-fresh", "Fresh", "2026-01-01T00:00:01Z");
  const payload = {
    tags: [numeric.tag, garbage.tag, missing.tag, fresh.tag],
    tasks: {
      "task-peer": [
        // A non-string must not throw out of the host's menu build...
        { ...numeric.application, updatedAt: 42 },
        // ...and a string the engine rejects must not be ranked as epoch,
        // which would put a never-used tag at the top of the list.
        { ...garbage.application, updatedAt: "not a timestamp" },
        { id: missing.tag.id, name: missing.tag.name, color: missing.tag.color },
        fresh.application,
      ],
    },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);

  const items = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });

  assertStructural.deepEqual(
    items.map((item) => item.id),
    ["more", "tag-fresh"],
    "an unreadable last-used time is not a used tag, and never an epoch-ranked one",
  );
});

test("card menu quick list stays in order on an engine that only parses millisecond fractions", async () => {
  const entries = [
    appliedTag("tag-early", "Early", "2026-01-01T00:00:00.000000001Z"),
    appliedTag("tag-late", "Late", "2026-01-01T00:00:01.000000002Z"),
  ];
  const payload = {
    tags: entries.map((entry) => entry.tag),
    tasks: { "task-peer": entries.map((entry) => entry.application) },
  };
  // The spec requires exactly three fractional digits, so V8 accepting nine is
  // a convenience. This host forbids more, which is why lastUsedMillis
  // truncates before parsing: without that, every value here would be
  // unparseable and the list would be empty.
  class StrictDate extends Date {
    static parse(value) {
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(String(value))
        ? Date.parse(value)
        : NaN;
    }
  }
  const { host } = makeQuickPickHost(payload);
  const strictPlugin = loadBundle(undefined, { Date: StrictDate });
  await strictPlugin.__internal.fetchSharedTags(host, "ws-1");
  await flush();

  const items = strictPlugin.__internal.quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });

  assertStructural.deepEqual(
    items.map((item) => item.id),
    ["more", "tag-late", "tag-early"],
    "each nanosecond time still parses once truncated, and the later wins",
  );
});

test("card menu quick list memoizes a card with nothing to offer", async () => {
  const plugin = loadBundle();
  const { quickTagItems, quickTagCacheSize } = plugin.__internal;
  const carried = appliedTag("tag-carried", "Carried", "2026-01-01T00:00:01Z");
  const payload = {
    tags: [carried.tag],
    // This card already carries the only recent tag, so it has nothing to
    // offer -- a stable state that must not rescan the workspace on every
    // build of its menu.
    tasks: { "task-1": [carried.application], "task-peer": [carried.application] },
  };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  const context = { taskId: "task-1", workspaceId: "ws-1" };

  const first = quickTagItems(host, context);

  assertStructural.deepEqual(first, []);
  assert.equal(quickTagCacheSize(), 1, "the empty result is cached like any other");
  assert.equal(quickTagItems(host, context), first, "and reused rather than recomputed");
});

test("a host that rejects the shared-tags action releases the memoized payload", async () => {
  const plugin = loadBundle();
  const { quickTagItems, quickTagCacheSize } = plugin.__internal;
  const entry = appliedTag("tag-a", "Blocked", "2026-01-01T00:00:01Z");
  const payload = { tags: [entry.tag], tasks: { "task-peer": [entry.application] } };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });
  assert.equal(quickTagCacheSize(), 1);

  // The installed plugin is observed as not declaring the action at all; the
  // store then holds an empty payload, which must not keep the previous
  // workspace-wide one reachable through the memo.
  host.api.invokeAction = (key) => {
    if (key === "shared-tags") return Promise.reject(apiError(404, "plugin action not found", { error: "plugin action not found" }));
    return Promise.resolve({ tags: [] });
  };
  await plugin.__internal.fetchSharedTags(host, "ws-1");
  await flush();

  assert.equal(quickTagCacheSize(), 0, "the unsupported-action path prunes too");
});

test("the memoized quick list never pins a superseded shared payload", async () => {
  const plugin = loadBundle();
  const { quickTagItems, quickTagCacheSize } = plugin.__internal;
  const entry = appliedTag("tag-a", "Blocked", "2026-01-01T00:00:01Z");
  const payload = { tags: [entry.tag], tasks: { "task-peer": [entry.application] } };
  const { host } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  const context = { taskId: "task-1", workspaceId: "ws-1" };

  quickTagItems(host, context);
  assert.equal(quickTagCacheSize(), 1, "one entry per card whose menu list was derived");

  // The 30s refresh replaces the payload wholesale; entries built from the old
  // one are dropped rather than kept alive by cards nothing rebuilds for.
  await primeSharedStore(plugin, host);
  assert.equal(quickTagCacheSize(), 0, "a refresh releases entries derived from the old payload");

  quickTagItems(host, context);
  assert.equal(quickTagCacheSize(), 1, "and the next build caches against the new one");

  // clearTaskTagCache() is the workspace-switch / unload signal for exactly the
  // stores these entries were derived from.
  plugin.__internal.clearTaskTagCache();
  assert.equal(quickTagCacheSize(), 0, "dropping the task stores releases the memo");
});

test("card menu quick list never fetches from the menu-build path", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const payload = {
    tags: [appliedTag("tag-a", "Blocked", "2026-01-01T00:00:01Z").tag],
    tasks: {},
  };
  const { host, calls } = makeQuickPickHost(payload);
  const context = { taskId: "task-1", workspaceId: "ws-1" };

  assertStructural.deepEqual(quickTagItems(host, context), []);
  await flush();
  assertStructural.deepEqual(
    quickTagItems(host, context),
    [],
    "a store nothing has loaded yet yields no submenu, and never a fetch",
  );
  assertStructural.deepEqual(calls, [], "the menu-build path issues no action call at all");
});

test("card menu quick pick applies a tag through the shared action and refreshes the store", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const entry = appliedTag("tag-a", "Blocked", "2026-01-01T00:00:01Z");
  const payload = { tags: [entry.tag], tasks: { "task-peer": [entry.application] } };
  const { host, calls } = makeQuickPickHost(payload);
  await primeSharedStore(plugin, host);
  calls.length = 0;

  const items = quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" });
  await items[1].run();
  await flush();

  assertStructural.deepEqual(calls[0], {
    key: "task-tag-add",
    input: { taskId: "task-1", body: { tagId: "tag-a" } },
  });
  assert.equal(calls[1].key, "shared-tags", "a successful add refreshes the store the chips read");
});

test("card menu quick pick reports a failed add through the host toast", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  const toastMessages = [];
  const entry = appliedTag("tag-a", "Blocked", "2026-01-01T00:00:01Z");
  const payload = { tags: [entry.tag], tasks: { "task-peer": [entry.application] } };
  const { host } = makeQuickPickHost(payload, {
    toast: {
      error(message) {
        toastMessages.push(message);
      },
    },
  });
  host.api.invokeAction = (key, input) => {
    if (key === "shared-tags") return Promise.resolve(payload);
    void input;
    return Promise.reject(apiError(500, "add failed"));
  };
  await primeSharedStore(plugin, host);

  await quickTagItems(host, { taskId: "task-1", workspaceId: "ws-1" })[1].run();
  await flush();

  assertStructural.deepEqual(toastMessages, ["Could not add tag. Please try again."]);
});

test("card menu quick list is empty on a host without shared tags, and the flat item still opens the picker", async () => {
  const plugin = loadBundle();
  const { quickTagItems } = plugin.__internal;
  let modalOptions = null;
  let registration = null;
  const host = makeFakeReactHost();
  host.store = {
    getState: () => ({ workspaces: { activeId: "ws-1" } }),
    subscribe: () => () => {},
  };
  host.storage = { get: () => Promise.resolve(undefined), subscribe: () => () => {} };
  host.openModal = (options) => {
    modalOptions = options;
  };
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction(value) {
        registration = value;
      },
      registerTaskFilter() {},
      registerTaskListFacet() {},
    },
    host,
  );
  const context = { taskId: "task-1", workspaceId: "ws-1" };

  assertStructural.deepEqual(
    quickTagItems(host, context),
    [],
    "no shared catalog means no quick children, so the host renders the flat item",
  );

  await registration.run(context);
  assert.equal(modalOptions.size, "md", "the flat item opens the picker modal");
  assert.equal(modalOptions.title, "Tags");
});

test("the registered Add tag action carries the quick list and keeps run as its flat fallback", async () => {
  const plugin = loadBundle();
  const entry = appliedTag("tag-a", "Blocked", "2026-01-01T00:00:01Z");
  const payload = { tags: [entry.tag], tasks: { "task-peer": [entry.application] } };
  let registration = null;
  let modalOptions = null;
  const { host } = makeQuickPickHost(payload, {
    openModal(options) {
      modalOptions = options;
    },
  });
  plugin.initialize(
    {
      registerComponent() {},
      registerTaskMenuAction(value) {
        registration = value;
      },
      registerTaskFilter() {},
      registerTaskListFacet() {},
    },
    host,
  );
  await primeSharedStore(plugin, host);

  assert.equal(registration.group, "primary");
  assert.equal(typeof registration.items, "function", "a submenu-capable host reads items()");
  assertStructural.deepEqual(
    registration.items({ taskId: "task-1", workspaceId: "ws-1" }).map((item) => item.label),
    ["More tags\u2026", "Blocked"],
  );

  await registration.run({ taskId: "task-1", workspaceId: "ws-1" });
  assert.equal(modalOptions.size, "md", "a host that predates items still gets the picker from run()");
});
