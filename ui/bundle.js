/**
 * Native JS UI bundle for kandev-plugin-tags (docs/plans/plugins/PLUGIN-API.md).
 * A self-contained ES module -- no imports, no bundled React -- that calls
 * `window.registerKandevPlugin(id, plugin)` at evaluation time and, on
 * `initialize(registry, host)`, registers:
 *
 *   - a "task-card-tags" slot component (TagChips) rendering the current
 *     user's tags for a card as a colored chip row on the kanban card;
 *   - a "task-row-metadata" slot component (the same TagChips factory, in its
 *     dense/non-removable mode) rendering that same chip row -- smaller,
 *     capped at 3 chips plus a "+N" indicator, no per-chip remove button --
 *     for the sidebar task row and the `/tasks` list row;
 *   - a registerTaskMenuAction under the kanban card's "primary" group
 *     ("Add tag...") that opens a redesigned host.openModal editor
 *     (TagPickerModal) to search/create and multi-select tags for the card;
 *   - a "main-top-bar" slot button ("Tags box") that opens a
 *     filter+manage dropdown (TagsTopBarDropdown) to add/rename/recolor/
 *     remove tags from the user's tag catalog: an icon-lg trigger, a
 *     380px-wide grid-aligned tag list (a stable delete-button column
 *     regardless of tag name length), and a swatch-button color picker
 *     with palette/hex swatches, a live preview, and explicit Update/
 *     Cancel commit buttons (no write until Update);
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
 * plain-string tag, rendering the id itself as the name with DEFAULT_COLOR
 * -- *unless* the id is shaped like a generated catalog id (see makeTagId),
 * in which case it's an orphaned v2 tag (deleted from the catalog but still
 * referenced by a stale card) and resolves to `null`; every chip surface
 * skips a `null` resolution and renders no chip for it. No migration write
 * is performed; legacy and v2 tags can coexist on a card.
 *
 * Shared data layer: the catalog and each task's applied-tag-id list are
 * each cached in one module-level store (keyed by workspaceId / taskId
 * respectively), with one coalesced in-flight `host.storage.get` and one
 * `host.storage.subscribe` per entry -- so N simultaneously-mounted chip
 * rows/dropdowns for the same workspace/task issue exactly one read and one
 * subscription between them, not N. `useCatalog`/`useTaskTagIds` (the hooks
 * every surface renders through) are thin wrappers over these stores. The
 * coalescing never swallows an invalidation: a request arriving while a
 * `get` is already in flight marks the store dirty and is re-issued on
 * settle (see fetchStore), and every teardown of these stores' subscriptions
 * resets the stores with them (see resetSharedStores).
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
  // 22, not 32: the Tags box is a fixed-width dropdown, so the Create input's
  // width is whatever the box has left after its padding and the Create
  // button -- 282px at TOPBAR_WIDTH, of which 264px is text area once the
  // input's own padding and border are taken out. A 32-character name needs
  // ~253px for ordinary lowercase and ~373px in the worst case (all wide
  // glyphs), so "32 characters, no horizontal scroll" was not satisfiable at
  // any sane box width. At 22 the name needs 247px against the 11.22px widest
  // glyph the app font actually renders, and 268px against the fallback
  // stack's 12.18px one. The 264px of text area holds the first outright; the
  // guard bounds the second at 12px/char (264px), so an all-wide-glyph name
  // overshoots by ~4px during the font-load window only -- see the
  // calibration note on the regression test.
  var MAX_TAG_LENGTH = 22;

  // Tags box geometry. These three are one budget, so they live together:
  //   input = TOPBAR_WIDTH - 16 (p-2) - 16 (row padding) - CREATE_BUTTON_WIDTH
  //           - 6 (gap)  =  282px, less the host Input's own 16px padding and
  //           2px border  =  264px of text area
  // which is what a 22-character name needs at its widest. Changing any of
  // them without re-checking MAX_TAG_LENGTH reintroduces the horizontal
  // scroll (see the regression test in ui/bundle.test.js).
  //
  // Applied as an inline width rather than a `w-[320px]` class on purpose:
  // Tailwind only emits an arbitrary-value utility if it appears in source it
  // scans, and the host does not scan this bundle. `w-[320px]` happened to
  // work only because unrelated host components used the same literal, which
  // is not a dependency this plugin should have.
  var TOPBAR_WIDTH = 380;
  var CREATE_BUTTON_WIDTH = 60;
  // Keep the dropdown above mobile fixed actions such as the Tasks page FAB
  // (`z-40`) when Radix constrains the content near the viewport bottom.
  var TOPBAR_DROPDOWN_Z_INDEX = 60;
  var MAX_TAGS_PER_TASK = 12;
  var CONFLICT_RETRY_LIMIT = 1;
  // Radix Select reserves the empty string for clearing its own value, so
  // use a private non-empty sentinel for the "All tags" UI choice.
  var ALL_TAGS_FILTER_VALUE = "__all_tags__";
  var UNTAGGED_FILTER_VALUE = "__untagged__";
  var TAGS_FILTER_ID = "tags";
  var TASK_ROW_CHIP_LIMIT = 3;

  // Shape of a generated catalog tag id (see makeTagId) -- used by
  // resolveTag to distinguish an *orphaned* v2 tag id (deleted from the
  // catalog but still referenced by a stale card) from a legacy v1
  // plain-string tag name, which never looks like this.
  var GENERATED_TAG_ID_RE = /^tag-[0-9a-z]+-[0-9a-z]+$/;

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

  // Chip text tokens (Tailwind white / gray-900) and the WCAG contrast floor
  // a background must clear to keep white text -- see chipTextColor.
  var CHIP_TEXT_LIGHT = "#ffffff";
  var CHIP_TEXT_DARK = "#111827";
  var CHIP_TEXT_MIN_CONTRAST = 3;

  // 3/4/6/8-digit hex, the 4/8-digit forms carrying an alpha channel --
  // wider than HEX_COLOR_RE (which only covers what normalizeColor writes)
  // because resolveRgb also has to measure alpha on values that arrive by
  // other routes (imports, legacy catalogs, host.storage).
  var HEX_RGBA_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  // `currentcolor` names the element's *own* `color`, so as a chip
  // background it resolves to the chip's own label colour: an unreadable
  // chip by construction, whatever text colour is paired with it. It is
  // also the one value the probe canvas answers wrongly rather than
  // rejecting (it has no element to inherit from, so it paints black), so
  // it has to be caught by name before any measurement is attempted.
  //
  // Matched as an ident token *anywhere* in the value rather than as the
  // whole value: nested in `color-mix()` or in relative colour syntax the
  // keyword carries the same self-reference, and the canvas resolves it just
  // as confidently. Measured in Chromium against the whole-value-only form,
  // both `color-mix(in srgb, currentcolor 50%, white)` (canvas: mid gray,
  // DOM: `color(srgb 1 1 1)`) and `rgb(from currentcolor r g b)` (canvas:
  // black, DOM: white) rendered a white chip carrying white text -- contrast
  // 1.00, on both the light and the dark host theme.
  var CURRENT_COLOR_RE = /(^|[^\w-])currentcolor([^\w-]|$)/i;

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
  // Dense variant for the task-row-metadata slot (sidebar row / /tasks list
  // row) -- smaller padding/font than the kanban card's task-card-tags
  // chips, and (see makeTagChips) no per-chip remove control.
  var DENSE_CHIP_ROW_STYLE = { display: "flex", flexWrap: "nowrap", gap: "3px", alignItems: "center", overflow: "hidden" };
  var CHIP_MORE_STYLE = {
    display: "inline-flex",
    alignItems: "center",
    fontSize: "10px",
    color: "#6b7280",
    padding: "0 2px",
    flexShrink: 0,
  };

  var resolveRgbCache = new Map();
  var probeCanvasCtx; // lazily created 2D context, browser hosts only

  function hexChannel(pair) {
    return parseInt(pair.length === 1 ? pair + pair : pair, 16);
  }

  /** Parses a 3/4/6/8-digit `#`-prefixed hex string (already RE-validated) to {r,g,b,a}. */
  function parseHexRgb(hex) {
    var digits = hex.slice(1);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: hexChannel(digits[0]),
        g: hexChannel(digits[1]),
        b: hexChannel(digits[2]),
        a: digits.length === 4 ? hexChannel(digits[3]) / 255 : 1,
      };
    }
    return {
      r: hexChannel(digits.slice(0, 2)),
      g: hexChannel(digits.slice(2, 4)),
      b: hexChannel(digits.slice(4, 6)),
      a: digits.length === 8 ? hexChannel(digits.slice(6, 8)) / 255 : 1,
    };
  }

  /**
   * Serializes opaque channels back to `rgb(r, g, b)` -- the form
   * `getComputedStyle` reports, so an inspected chip reads the same as the
   * value renderableColor handed out. Only ever called with an opaque
   * colour, so no alpha component is emitted.
   */
  function rgbString(rgb) {
    return "rgb(" + rgb.r + ", " + rgb.g + ", " + rgb.b + ")";
  }

  /**
   * Paints `raw` into the 1x1 probe canvas over `sentinel` and reads the
   * pixel back as `[r, g, b, a]` (all 0-255). The canvas silently ignores a
   * value it cannot parse, leaving `sentinel` painted instead -- which is
   * what the two-sentinel comparison in resolveRgbViaCanvas detects.
   */
  function probePixel(sentinel, raw) {
    probeCanvasCtx.fillStyle = sentinel;
    probeCanvasCtx.fillStyle = raw;
    probeCanvasCtx.clearRect(0, 0, 1, 1);
    probeCanvasCtx.fillRect(0, 0, 1, 1);
    var data = probeCanvasCtx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  }

  /**
   * Resolves a non-hex colour to concrete RGB by asking a real browser: a
   * lazily created, module-level 1x1 probe canvas is painted with the value
   * and the pixel read back, reducing *whatever* the browser accepts to
   * concrete channels. Reading `fillStyle` back as a string instead would
   * only cover the forms a browser happens to serialise as `#rrggbb` or
   * `rgba(...)`: Chrome echoes `oklch(0.7 0.1 200)`, `lab(...)` and
   * `color(display-p3 ...)` back verbatim, and no string parser here can
   * turn those into RGB -- so they would resolve to `null` and renderable-
   * Color would grey out a colour that renders perfectly well. The pixel
   * does not care what syntax produced it.
   *
   * `raw` is painted twice, once over each of two distinct sentinels: a
   * value the canvas rejects leaves the sentinel painted instead, so the
   * two pixels disagree (`var(--x)`, `light-dark(...)`, garbage), while an
   * accepted one paints the same pixel both times. Comparing against a
   * single sentinel would instead reject any `raw` that legitimately
   * resolves to that sentinel's own colour.
   *
   * `null` with no `document` (the DOM-less test host) or on any failure --
   * including a host that blocks canvas readback.
   */
  function resolveRgbViaCanvas(raw) {
    if (typeof document === "undefined") return null;
    try {
      if (!probeCanvasCtx) {
        var canvas = document.createElement("canvas");
        if (canvas) {
          canvas.width = 1;
          canvas.height = 1;
        }
        probeCanvasCtx =
          canvas && typeof canvas.getContext === "function"
            ? canvas.getContext("2d", { willReadFrequently: true })
            : null;
      }
      if (!probeCanvasCtx) return null;
      var overA = probePixel("#010203", raw);
      var overB = probePixel("#fdfeff", raw);
      for (var i = 0; i < 4; i++) {
        if (overA[i] !== overB[i]) return null; // rejected: each sentinel stayed painted
      }
      return { r: overA[0], g: overA[1], b: overA[2], a: overA[3] / 255 };
    } catch (e) {
      return null;
    }
  }

  /**
   * Resolves `raw` to concrete `{ r, g, b, a }` channels (0-255, alpha
   * 0-1), or `null` if it can't be resolved. Hex is parsed directly -- the
   * only shape this plugin itself ever writes, so the DOM-less test host
   * measures contrast with no stubbing -- and everything else goes through
   * `resolveRgbViaCanvas`, memoised since chipStyle/denseChipStyle call
   * this once per chip per render.
   *
   * `currentcolor` is refused outright rather than measured, because it is
   * the one value a canvas answers *confidently and wrongly*: with no
   * element to inherit from it paints black, while in the DOM
   * `background: currentcolor` resolves to the chip's own text colour.
   * Trusting the canvas there would measure black, keep white text, and
   * render white on white -- the exact bug this contrast pass exists to
   * close (see CURRENT_COLOR_RE).
   */
  function resolveRgb(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = raw.trim();
    if (CURRENT_COLOR_RE.test(trimmed)) return null;
    if (HEX_RGBA_RE.test(trimmed)) return parseHexRgb(trimmed);
    if (resolveRgbCache.has(trimmed)) return resolveRgbCache.get(trimmed);
    var resolved = resolveRgbViaCanvas(trimmed);
    resolveRgbCache.set(trimmed, resolved);
    return resolved;
  }

  /** WCAG sRGB companding for one 0-255 channel. */
  function srgbChannel(channel) {
    var c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /**
   * WCAG relative luminance of an {r,g,b} object. Alpha is ignored, which is
   * only sound on an opaque colour: a translucent background composites with
   * whatever surface is behind the chip, and this plugin cannot read that
   * surface (it is the host's, and theme-dependent). `renderableColor` is
   * what upholds that -- it rejects anything not fully opaque -- so every
   * background reaching here via chipStyle/denseChipStyle is opaque.
   */
  function relativeLuminance(rgb) {
    return 0.2126 * srgbChannel(rgb.r) + 0.7152 * srgbChannel(rgb.g) + 0.0722 * srgbChannel(rgb.b);
  }

  /**
   * WCAG contrast ratio between two colours (1 to 21). Either side failing
   * to resolve (an unparseable value passed directly rather than through
   * renderableColor) yields 1 -- the safest ("no contrast") answer rather
   * than throwing.
   */
  function contrastRatio(a, b) {
    var rgbA = resolveRgb(a);
    var rgbB = resolveRgb(b);
    if (!rgbA || !rgbB) return 1;
    var lumA = relativeLuminance(rgbA);
    var lumB = relativeLuminance(rgbB);
    var lighter = Math.max(lumA, lumB);
    var darker = Math.min(lumA, lumB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * The chip text colour to pair with `background`: white unless its
   * contrast ratio against white falls below CHIP_TEXT_MIN_CONTRAST (3.0,
   * WCAG AA for graphical objects), in which case the dark token. An
   * unresolvable background gets white, matching the pre-contrast default.
   *
   * Expects an already-renderable background -- i.e. a `renderableColor`
   * return value, which is opaque by construction. Measuring a translucent
   * colour here would read the colour itself rather than the surface it
   * composites into, and pair confident text with a chip that is barely
   * there (see relativeLuminance).
   */
  function chipTextColor(background) {
    if (!resolveRgb(background)) return CHIP_TEXT_LIGHT;
    return contrastRatio(background, CHIP_TEXT_LIGHT) >= CHIP_TEXT_MIN_CONTRAST ? CHIP_TEXT_LIGHT : CHIP_TEXT_DARK;
  }

  /**
   * A background colour safe to render a chip with -- resolvable to
   * concrete, visible RGB, or DEFAULT_COLOR.
   *
   * `sanitizeCatalog` accepts any string as a tag's `color` (it only checks
   * the type), while `normalizeColor` guards the *write* path -- so a value
   * that never went through this plugin's UI can reach the DOM unvalidated.
   * Two ways that goes wrong: the browser drops an unparseable declaration
   * entirely, leaving a transparent background; or the declaration parses
   * fine but resolves to a see-through one (`"transparent"`,
   * `"rgba(0,0,0,0)"`, an 8-digit hex with a zero alpha byte). Either way
   * the chip becomes invisible against whatever text colour pairs with it.
   *
   * Anything not fully opaque is refused, not just alpha zero. A chip
   * background with `0 < alpha < 1` composites with the host surface behind
   * it, so the colour named in the catalog is not the colour rendered --
   * `chipTextColor` would measure the named one and pair confident text with
   * a chip that is barely there (`"#00000019"` measures as pure black,
   * scores 21 against white, keeps white text, and renders as roughly
   * `#e6e6e6` under it on a light card). Compositing it out here is not
   * possible: the surface belongs to the host and changes with its theme.
   * `normalizeColor` only ever writes opaque 3/6-digit hex, so nothing this
   * plugin produces is affected -- only values arriving by the other routes
   * above, for which falling back to a legible gray is already the answer.
   *
   * `currentcolor` is refused by name and needs no parser at all: it is
   * unreadable by construction, not merely unmeasurable (see
   * CURRENT_COLOR_RE).
   *
   * Hex passes immediately (the only shape this plugin writes). Anything
   * else is asked of the browser's own parser: a named or functional
   * colour -- `"red"`, `"rgb(1 2 3)"`, `"oklch(0.7 0.1 200)"` -- is a
   * legitimate value an older catalog or an import may hold. But surviving
   * `CSS.supports` is not enough on its own -- a value the browser
   * *accepts* can still resolve to fully transparent, or (given a parser)
   * to nothing `resolveRgb` can turn into concrete RGB at all
   * (`var(--x)`, whose declaration the DOM drops too) -- either of which
   * now falls back to DEFAULT_COLOR too. Where there is no parser (the
   * DOM-less test host) the value passes through unchecked, matching the
   * previous behaviour instead of silently recolouring tags in a context
   * that renders nothing anyway.
   *
   * A value that *did* resolve is handed back as the measured
   * `rgb(r, g, b)` rather than as the string the catalog held, so the
   * colour the chip renders is by construction the colour chipTextColor
   * measured. The probe canvas is detached: it has no element to inherit
   * from and no `color-scheme`, so a context-dependent value resolves there
   * against a context the chip does not share. A CSS system colour is the
   * live case -- Chrome accepts 42 of them and resolves 33 differently
   * under `color-scheme: dark`, which the canvas never reports. Measured on
   * a dark host theme with the authored value passed through, `Canvas`
   * rendered `rgb(18,18,18)` carrying the `#111827` text picked for the
   * light-scheme white the canvas had reported: contrast 1.06, worse than
   * the hard-coded white this replaced (18.73). Normalising closes that for
   * every context-dependent value at once, with no keyword list to keep in
   * step with browsers.
   *
   * The cost is gamut: a wide-gamut value (`color(display-p3 ...)`, an
   * out-of-sRGB `oklch(...)`) comes back sRGB-clamped, because the probe
   * reads sRGB bytes. That clamp was already in the contrast decision --
   * only the rendered colour is newly bound to it, so measurement and paint
   * now agree on a wide-gamut display instead of quietly diverging.
   */
  function renderableColor(raw) {
    if (typeof raw !== "string") return DEFAULT_COLOR;
    var trimmed = raw.trim();
    if (trimmed === "") return DEFAULT_COLOR;
    if (CURRENT_COLOR_RE.test(trimmed)) return DEFAULT_COLOR;
    if (HEX_COLOR_RE.test(trimmed)) return trimmed;
    // A hex carrying an alpha channel is measurable with no parser and no
    // document at all, so it is settled here rather than inside the
    // CSS.supports branch -- which a host without a `CSS` object skips
    // entirely, and which would otherwise let `#ffffff00` through untouched.
    if (HEX_RGBA_RE.test(trimmed)) return parseHexRgb(trimmed).a < 1 ? DEFAULT_COLOR : trimmed;
    if (typeof CSS !== "undefined" && CSS && typeof CSS.supports === "function") {
      if (!CSS.supports("color", trimmed)) return DEFAULT_COLOR;
      var rgb = resolveRgb(trimmed);
      // A resolved-but-see-through value is unrenderable either way.
      if (rgb !== null && rgb.a < 1) return DEFAULT_COLOR;
      // A `null` resolution is only conclusive when there was a real DOM to
      // resolve against -- with no `document` (the DOM-less test host),
      // resolveRgb has no browser to ask about an ordinary named colour, so
      // this stays permissive and matches the pre-contrast behaviour
      // instead of blanket-rejecting every non-hex value the moment a CSS
      // stub is injected.
      if (rgb === null && typeof document !== "undefined") return DEFAULT_COLOR;
      // Hand back what the probe actually measured, not what the catalog
      // said, so the rendered colour and the measured one cannot disagree.
      return rgb === null ? trimmed : rgbString(rgb);
    }
    return trimmed;
  }

  function chipStyle(color) {
    var background = renderableColor(color);
    return {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "1px 7px",
      borderRadius: "999px",
      background: background,
      color: chipTextColor(background),
      fontSize: "11px",
      fontWeight: 500,
      whiteSpace: "nowrap",
    };
  }

  function denseChipStyle(color) {
    var background = renderableColor(color);
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "0px 5px",
      borderRadius: "999px",
      background: background,
      color: chipTextColor(background),
      fontSize: "10px",
      fontWeight: 500,
      whiteSpace: "nowrap",
      flexShrink: 0,
    };
  }

  // Fixed 20x20 icon-only control -- used by the Tags box's per-row delete
  // button (see makeTagsTopBarDropdown) so its x-offset is identical on
  // every row regardless of the tag name's length (the bare, unstyled
  // `<button>` it replaces sized itself to its "×" glyph, which drifted
  // whenever the name pill's rendered width changed).
  var TOPBAR_DELETE_BUTTON_STYLE = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    padding: 0,
    border: "none",
    background: "transparent",
    lineHeight: 1,
    cursor: "pointer",
    borderRadius: "4px",
    flexShrink: 0,
  };

  var TOPBAR_SWATCH_BUTTON_STYLE_BASE = {
    width: "20px",
    height: "20px",
    padding: 0,
    borderRadius: "4px",
    cursor: "pointer",
    flexShrink: 0,
  };

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
   * Resolves a stored task tag-id to a displayable `{ id, name, color }`,
   * or `null` when `id` is an *orphaned* tag: it looks like a generated
   * catalog id (GENERATED_TAG_ID_RE, matching makeTagId's shape) but isn't
   * in the catalog -- i.e. the tag it once named has since been deleted.
   * Callers must skip a `null` result and render no chip for it.
   *
   * Anything else unresolved is treated as a legacy v1 plain-string tag
   * name (DEFAULT_COLOR) -- see the back-compat note at the top of this
   * file. A legacy name never happens to match GENERATED_TAG_ID_RE in
   * practice (that shape requires two base36 groups joined by a literal
   * "tag-" prefix), so this doesn't regress v1 rendering.
   */
  function resolveTag(catalog, id) {
    var found = findTagById(catalog, id);
    if (found) return found;
    if (typeof id === "string" && GENERATED_TAG_ID_RE.test(id)) return null;
    return { id: id, name: String(id), color: DEFAULT_COLOR };
  }

  function isConflictError(err) {
    return !!err && err.name === "PluginStorageConflictError";
  }

  /**
   * Single choke point for surfacing a storage-boundary failure: logs
   * `[kandev-plugin-tags] <context>` plus the underlying Error to the
   * console so the real HTTP status (embedded in host.storage's rejection
   * message) is visible instead of only the generic UI message.
   */
  function logError(context, err) {
    console.error("[kandev-plugin-tags] " + context, err);
  }

  /**
   * Resolves the workspace id to scope catalog storage under. Rejects
   * blank/whitespace-only/undefined/null and the literal string "null"
   * (the JSON-stringified form of a null slotProps.workspaceId, which
   * would otherwise pass straight through to encodeURIComponent and read/
   * write a bogus "null" scopeId bucket), falling back to the host's own
   * `workspaces.activeId`. Returns null when nothing resolves -- callers
   * treat that as "no active workspace" and skip storage calls entirely.
   */
  function resolveWorkspaceId(host, candidate) {
    var trimmed = typeof candidate === "string" ? candidate.trim() : "";
    if (trimmed && trimmed !== "null") return trimmed;
    var state = host.store.getState();
    var active = state && state.workspaces && state.workspaces.activeId;
    return active || null;
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
  // Shared data layer
  //
  // Every chip-rendering surface (task-card-tags, task-row-metadata, the Tags
  // box, the add-tag picker modal) needs the same two things: the active
  // workspace's tag catalog, and a given task's applied tag-id list.
  // Before this layer existed, each mounted component held its own
  // independent useState/useEffect copy (see the old useStorageValue),
  // so N cards showing chips for the same task -- or just task-card-tags
  // and task-row-metadata both mounted for one card -- issued N redundant
  // `host.storage.get` calls and N redundant `host.storage.subscribe`
  // registrations for the very same (scope, scopeId, key).
  //
  // These two module-level stores fix that: one cache entry per
  // workspaceId (catalog) / per taskId (task tags), a single coalesced
  // in-flight `get` per entry (a second caller arriving before the first
  // resolves joins the same promise instead of issuing its own `get`), and
  // exactly one `host.storage.subscribe` per entry -- for tasks, one *wide*
  // subscribe (no scopeId, mirroring registerTagFilter's own wide
  // `{ scope: TASK_SCOPE, key: TASK_KEY }` filter below) shared across
  // every task, which invalidates just the one taskId that changed.
  // ---------------------------------------------------------------------

  var catalogStores = {}; // workspaceId -> store
  var taskTagStores = {}; // taskId -> store
  var taskTagWideUnsubscribe = null;

  function makeStore() {
    return {
      value: [],
      loaded: false,
      error: null,
      listeners: [],
      inFlight: null,
      // Set when a fetch is requested while one is already in flight -- see
      // fetchStore, which re-issues on settle so a change notification
      // arriving mid-flight is never swallowed by the coalescing.
      dirty: false,
      unsubscribe: null,
    };
  }

  function notifyStoreListeners(store) {
    // Snapshot first -- a listener (a component's setState) can synchronously
    // trigger an effect cleanup that mutates `store.listeners` mid-iteration.
    store.listeners.slice().forEach(function (fn) {
      fn();
    });
  }

  function getCatalogStore(workspaceId) {
    var store = catalogStores[workspaceId];
    if (!store) {
      store = catalogStores[workspaceId] = makeStore();
    }
    return store;
  }

  /** Creates the catalog's one subscribe-per-workspace, idempotently. */
  function ensureCatalogSubscription(host, workspaceId) {
    var store = getCatalogStore(workspaceId);
    if (!store.unsubscribe) {
      store.unsubscribe = host.storage.subscribe(
        { scope: CATALOG_SCOPE, scopeId: workspaceId, key: CATALOG_KEY },
        function () {
          fetchCatalog(host, workspaceId);
        },
      );
      addDisposable(store.unsubscribe);
    }
  }

  /**
   * Coalesced fetch shared by fetchCatalog/fetchTaskTags: a caller arriving
   * while a `get` is already in flight joins that promise instead of issuing
   * another one.
   *
   * Coalescing two concurrent *readers* is all that needs -- but a caller can
   * just as well be an *invalidation* (a host.storage.subscribe notification
   * for a write that landed after the in-flight `get` was issued), whose
   * response is therefore stale by the time it arrives. Plain coalescing
   * would drop that notification and leave the store holding pre-write data
   * until some later unrelated change. So a request that arrives mid-flight
   * marks the store `dirty`, and settling with `dirty` set re-issues the
   * fetch -- last write always wins, the same guarantee the per-component
   * `generation` counter this store layer replaced used to give.
   */
  function fetchStore(store, issueGet, sanitize, label, refetch) {
    if (store.inFlight) {
      store.dirty = true;
      return store.inFlight;
    }
    store.dirty = false;

    function settle(apply) {
      store.inFlight = null;
      apply();
      store.loaded = true;
      notifyStoreListeners(store);
      if (store.dirty) refetch();
    }

    store.inFlight = issueGet().then(
      function (entry) {
        settle(function () {
          store.value = sanitize(entry ? entry.value : undefined);
          store.error = null;
        });
      },
      function (err) {
        settle(function () {
          logError("load " + label, err);
          store.error = err;
        });
      },
    );
    return store.inFlight;
  }

  function fetchCatalog(host, workspaceId) {
    return fetchStore(
      getCatalogStore(workspaceId),
      function () {
        return host.storage.get(CATALOG_SCOPE, workspaceId, CATALOG_KEY);
      },
      sanitizeCatalog,
      CATALOG_SCOPE + "/" + CATALOG_KEY,
      function () {
        fetchCatalog(host, workspaceId);
      },
    );
  }

  function getTaskTagStore(taskId) {
    var store = taskTagStores[taskId];
    if (!store) {
      store = taskTagStores[taskId] = makeStore();
    }
    return store;
  }

  /** Creates the ONE wide (cross-task) task-tags subscribe, idempotently. */
  function ensureTaskTagWideSubscription(host) {
    if (taskTagWideUnsubscribe) return;
    taskTagWideUnsubscribe = host.storage.subscribe({ scope: TASK_SCOPE, key: TASK_KEY }, function (change) {
      var taskId = change && change.scopeId;
      if (!taskId || !taskTagStores[taskId]) return; // nobody has asked for this task yet
      fetchTaskTags(host, taskId);
    });
    addDisposable(taskTagWideUnsubscribe);
  }

  function fetchTaskTags(host, taskId) {
    return fetchStore(
      getTaskTagStore(taskId),
      function () {
        return host.storage.get(TASK_SCOPE, taskId, TASK_KEY);
      },
      sanitizeTagIdList,
      TASK_SCOPE + "/" + TASK_KEY,
      function () {
        fetchTaskTags(host, taskId);
      },
    );
  }

  /**
   * Generic hook over a shared (module-level) store: mounts subscribe to
   * change notifications and trigger the first fetch; unmounts unsubscribe
   * from the store's listener list only (the underlying host.storage
   * subscription and any in-flight/cached data outlive any single
   * component -- see ensureSubscription's own idempotency). Returns
   * `[value, loaded, refresh, error]`, same shape the old per-component
   * useStorageValue returned, so every call site (chip rows, modals) keeps
   * working unchanged.
   */
  function useSharedStore(host, scopeId, getStore, ensureSubscription, fetchFn) {
    var React = host.React;
    var tickState = React.useState(0);
    var setTick = tickState[1];

    React.useEffect(
      function () {
        if (!scopeId) return undefined;
        ensureSubscription(host, scopeId);
        var store = getStore(scopeId);
        function onChange() {
          setTick(function (t) {
            return t + 1;
          });
        }
        store.listeners.push(onChange);
        if (!store.loaded && !store.inFlight) fetchFn(host, scopeId);
        return function () {
          var idx = store.listeners.indexOf(onChange);
          if (idx !== -1) store.listeners.splice(idx, 1);
        };
      },
      [scopeId],
    );

    if (!scopeId) return [[], true, function () {}, null];
    var store = getStore(scopeId);
    return [
      store.value,
      store.loaded,
      function refresh() {
        fetchFn(host, scopeId);
      },
      store.error,
    ];
  }

  function useTaskTagIds(host, taskId, writerId) {
    // writerId is accepted for call-site compatibility (and still used for
    // the *write* path -- see readModifyWriteTaskTags) but no longer
    // filters the shared store's subscribe: there is only one wide
    // subscribe for the whole store (see ensureTaskTagWideSubscription),
    // shared by every writer.
    return useSharedStore(host, taskId || null, getTaskTagStore, ensureTaskTagWideSubscription, fetchTaskTags);
  }

  function useCatalog(host, workspaceId, writerId) {
    return useSharedStore(host, workspaceId || null, getCatalogStore, ensureCatalogSubscription, fetchCatalog);
  }

  /**
   * The board-wide Tags filter's cross-card index -- now simply a read of
   * the shared task-tags store (folded into one source of truth with
   * useTaskTagIds instead of a second, independently-maintained cache).
   * Undefined (not merely unloaded) when nothing has ever asked for this
   * task's tags; callers treat that the same as "no tags" (untagged).
   */
  function getTaskTagCacheEntry(taskId) {
    var store = taskTagStores[taskId];
    return store && store.loaded ? store.value : undefined;
  }

  /** Populates/overwrites one task's cached tag ids directly (primeTaskTagCache's bulk scan; also used by tests). */
  function setTaskTagCache(taskId, tagIds) {
    var store = getTaskTagStore(taskId);
    store.value = tagIds;
    store.loaded = true;
    store.error = null;
    notifyStoreListeners(store);
  }

  /** Evicts every cached task's tag ids (plugin unload, workspace switch -- D13/AC20). */
  function clearTaskTagCache() {
    taskTagStores = {};
  }

  /**
   * Drops every cached store and the two flags guarding their one-shot
   * host.storage subscriptions (`store.unsubscribe` lives on the store
   * objects themselves; `taskTagWideUnsubscribe` is module-level).
   *
   * Must run whenever drainDisposables() runs, because draining is what
   * actually tears those subscriptions down. Leaving the flags set after a
   * drain makes ensureCatalogSubscription/ensureTaskTagWideSubscription
   * short-circuit forever, so nothing ever resubscribes; and leaving
   * `store.loaded` true makes useSharedStore skip its first-mount fetch, so
   * every chip surface would keep serving pre-drain data with no live
   * updates until a full page reload. Both destroy() and a re-entrant
   * initialize() (the host re-runs initialize without a matching destroy --
   * see initialize's own comment) need this.
   */
  function resetSharedStores() {
    catalogStores = {};
    clearTaskTagCache();
    taskTagWideUnsubscribe = null;
  }

  // ---------------------------------------------------------------------
  // Lifecycle: disposal of module-level (non-React) subscriptions.
  //
  // This list holds every subscription whose lifetime is NOT scoped to a
  // single mounted component: registerTagFilter's host.store.subscribe and
  // its workspace-scoped host.storage.subscribe (created directly during
  // initialize(), outside any component), plus the shared catalog/task-tags
  // stores' host.storage.subscribe calls (ensureCatalogSubscription,
  // ensureTaskTagWideSubscription) -- each created at most once, the first
  // time any component asks for that store, and deliberately left running
  // for as long as the store might have listeners again later, rather than
  // torn down when the *last* subscribed component happens to unmount.
  // Only plugin unload (destroy(), which drains this whole list) or a fresh
  // initialize() (which drains it first -- see initialize's own comment)
  // releases them (D12).
  // ---------------------------------------------------------------------

  var disposables = [];

  function addDisposable(dispose) {
    disposables.push(dispose);
  }

  /** Runs and discards every pending disposable, tolerating a throw from any one of them. */
  function drainDisposables() {
    var toRun = disposables;
    disposables = [];
    toRun.forEach(function (dispose) {
      try {
        dispose();
      } catch (err) {
        logError("dispose", err);
      }
    });
  }

  // ---------------------------------------------------------------------
  // task-card-tags: chip row
  // ---------------------------------------------------------------------

  /**
   * Builds a chip-row slot component. `opts.removable` (default `true`)
   * controls whether each chip carries its own remove ("\u00d7") button --
   * `task-card-tags` keeps it (removal from the kanban card chip row
   * itself); `task-row-metadata` (the sidebar row / `/tasks` list row) omits
   * it, since removal there stays confined to the "Add tag..." modal.
   * `opts.dense` (default `false`) switches to smaller chip padding/font
   * and caps visible chips at TASK_ROW_CHIP_LIMIT with a trailing `+N`
   * indicator -- `task-card-tags` renders every applied tag uncapped, to
   * keep its existing behavior/output unchanged.
   */
  function makeTagChips(host, opts) {
    opts = opts || {};
    var removable = opts.removable !== false;
    var dense = !!opts.dense;
    var React = host.React;
    var jsx = host.jsx;

    function chipEl(tag, handleRemove) {
      var spanArgs = [
        "span",
        {
          key: tag.id,
          "data-testid": "kandev-tags-chip",
          className: "kandev-tags-chip",
          style: dense ? denseChipStyle(tag.color) : chipStyle(tag.color),
        },
        tag.name,
      ];
      if (removable) {
        spanArgs.push(
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
                handleRemove(tag.id);
              },
              onPointerDown: function (e) {
                if (e && e.stopPropagation) e.stopPropagation();
              },
            },
            "\u00d7",
          ),
        );
      }
      return jsx.apply(null, spanArgs);
    }

    return function TagChips(props) {
      var slotProps = props.slotProps || {};
      var taskId = slotProps.taskId;
      // TaskCardTagsSlotProps.workspaceId is string | null; resolveWorkspaceId
      // also rejects the literal string "null" (encodeURIComponent(null)),
      // which would otherwise pass the backend's scopeId pattern and read/
      // write a bogus "null" bucket instead of erroring.
      var resolvedWorkspaceId = resolveWorkspaceId(host, slotProps.workspaceId);
      var tagIdsAndLoaded = useTaskTagIds(host, resolvedWorkspaceId ? taskId : null, CHIPS_WRITER_ID);
      var tagIds = tagIdsAndLoaded[0];
      var tagIdsLoaded = tagIdsAndLoaded[1];
      var catalogAndLoaded = useCatalog(host, resolvedWorkspaceId, CHIPS_WRITER_ID);
      var catalog = catalogAndLoaded[0];
      var catalogLoaded = catalogAndLoaded[1];

      if (!resolvedWorkspaceId || !tagIdsLoaded || !catalogLoaded || tagIds.length === 0) return null;

      function handleRemove(id) {
        readModifyWriteTaskTags(host, taskId, CHIPS_WRITER_ID, function (current) {
          return removeTaskTagId(current, id);
        }).catch(function (err) {
          // Surface the failed removal on the next subscribe/refresh cycle
          // rather than throwing inside a React event handler.
          logError("remove tag from card", err);
        });
      }

      // resolveTag returns null for an orphaned tag id (deleted from the
      // catalog but still referenced by a stale card) -- skip it entirely
      // rather than rendering a chip for a tag that no longer exists.
      var resolvedTags = tagIds
        .map(function (id) {
          return resolveTag(catalog, id);
        })
        .filter(function (tag) {
          return tag !== null;
        });
      if (resolvedTags.length === 0) return null;

      var visibleTags = dense ? resolvedTags.slice(0, TASK_ROW_CHIP_LIMIT) : resolvedTags;
      var hiddenCount = resolvedTags.length - visibleTags.length;
      var chipEls = visibleTags.map(function (tag) {
        return chipEl(tag, handleRemove);
      });

      if (!dense) {
        // Unchanged output shape from before this generalization: exactly
        // one children arg (the mapped chip array), uncapped.
        return jsx("div", { "data-testid": "kandev-tags-chip-row", style: CHIP_ROW_STYLE }, chipEls);
      }

      var moreEl =
        hiddenCount > 0
          ? jsx("span", { key: "more", "data-testid": "kandev-tags-chip-more", style: CHIP_MORE_STYLE }, "+" + hiddenCount)
          : null;
      return jsx("div", { "data-testid": "kandev-tags-chip-row", style: DENSE_CHIP_ROW_STYLE }, chipEls, moreEl);
    };
  }

  // ---------------------------------------------------------------------
  // Add/pick-tag modal (opened from the kanban card menu)
  // ---------------------------------------------------------------------

  /** Appends the underlying error's message, when present, in parentheses (AC4). */
  function withDetail(message, err) {
    return err && err.message ? message + " (" + err.message + ")" : message;
  }

  function makeTagPickerModal(host, taskId, workspaceId) {
    var React = host.React;
    var jsx = host.jsx;
    var ui = host.ui;

    return function TagPickerModal() {
      var resolvedWorkspaceId = resolveWorkspaceId(host, workspaceId);
      // No active workspace -- skip every storage call (AC6), including the
      // task-scoped ones, rather than issuing requests the backend will
      // reject with an "invalid scopeId" 400.
      var tagIdsAndLoaded = useTaskTagIds(host, resolvedWorkspaceId ? taskId : null, PICKER_WRITER_ID);
      var tagIds = tagIdsAndLoaded[0];
      var tagIdsLoaded = tagIdsAndLoaded[1];
      var refreshTagIds = tagIdsAndLoaded[2];
      var tagIdsLoadError = tagIdsAndLoaded[3];
      var catalogAndLoaded = useCatalog(host, resolvedWorkspaceId, PICKER_WRITER_ID);
      var catalog = catalogAndLoaded[0];
      var catalogLoaded = catalogAndLoaded[1];
      var refreshCatalog = catalogAndLoaded[2];
      var catalogLoadError = catalogAndLoaded[3];
      var draftState = React.useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var loadError = catalogLoadError || tagIdsLoadError;
      var loaded = tagIdsLoaded && catalogLoaded;
      var name = normalizeName(draft);
      var existingMatch = name ? findTagByName(catalog, name) : null;
      // "Add" creates a brand-new catalog tag -- disabled once the typed name
      // already exists (case-insensitively), whether or not it's applied to
      // this card yet (selecting an existing tag is done via the list below).
      var canCreate = !!resolvedWorkspaceId && loaded && !loadError && name !== null && existingMatch === null;
      var displayError =
        error || (loadError ? withDetail("Could not load tags. Please try again.", loadError) : null);

      if (!resolvedWorkspaceId) {
        return jsx(
          "div",
          { "data-testid": "kandev-tags-picker-modal" },
          "Select a workspace to use tags.",
        );
      }

      function toggleTag(id) {
        setError(null);
        var applying = tagIds.indexOf(id) === -1;
        var changed = false;
        readModifyWriteTaskTags(host, taskId, PICKER_WRITER_ID, function (current) {
          var next = applying ? addTaskTagId(current, id) : removeTaskTagId(current, id);
          changed = next !== current;
          return next;
        })
          .then(function () {
            if (!changed && applying) {
              // The card is already at MAX_TAGS_PER_TASK -- addTaskTagId
              // silently returns the same reference (D10); surface it
              // instead of leaving the checkbox looking like it did nothing.
              setError("This card already has " + MAX_TAGS_PER_TASK + " tags. Remove one before adding another.");
              return;
            }
            refreshTagIds();
          })
          .catch(function (err) {
            logError("toggle tag", err);
            setError(withDetail("Could not update tag. Please try again.", err));
          });
      }

      function handleCreateAndApply() {
        if (!canCreate) return;
        setError(null);
        var createdTag = null;
        readModifyWriteCatalog(host, resolvedWorkspaceId, PICKER_WRITER_ID, function (currentCatalog) {
          var result = addCatalogTag(currentCatalog, draft, null);
          if (result === null) return currentCatalog;
          createdTag = result.tag;
          return result.catalog;
        })
          .then(function () {
            refreshCatalog();
            if (createdTag) return createdTag;
            // Someone else created this exact (normalized) name between our
            // read and write -- re-read and look it up by the *normalized*
            // name, never the raw draft (the root cause of the "Could not
            // create tag" bug: addCatalogTag stores a trimmed name, so a
            // lookup by the untrimmed draft used to miss and this whole
            // chain threw "tag not found after create").
            return host.storage.get(CATALOG_SCOPE, resolvedWorkspaceId, CATALOG_KEY).then(function (entry) {
              var latest = sanitizeCatalog(entry ? entry.value : []);
              return findTagByName(latest, name);
            });
          })
          .then(function (tag) {
            if (!tag) throw new Error("tag not found after create");
            setDraft("");
            return readModifyWriteTaskTags(host, taskId, PICKER_WRITER_ID, function (current) {
              return addTaskTagId(current, tag.id);
            });
          })
          .then(refreshTagIds)
          .catch(function (err) {
            logError("create tag", err);
            setError(withDetail("Could not create tag. Please try again.", err));
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
          jsx(ui.Input, {
            "data-testid": "kandev-tags-picker-input",
            value: draft,
            placeholder: "Select or create a tag\u2026",
            maxLength: MAX_TAG_LENGTH,
            style: { flex: 1, minWidth: 0 },
            onChange: function (e) {
              setDraft(e.target.value);
            },
            onKeyDown: handleKeyDown,
          }),
          jsx(
            ui.Button,
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
          ui.ScrollArea,
          {
            "data-testid": "kandev-tags-picker-list",
            style: { maxHeight: "220px" },
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
                    ui.Button,
                    {
                      key: tag.id,
                      type: "button",
                      variant: "ghost",
                      "data-testid": "kandev-tags-picker-option",
                      "aria-pressed": checked,
                      style: {
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        width: "100%",
                      },
                      onClick: function () {
                        toggleTag(tag.id);
                      },
                    },
                    // The tag's hex background is the only inline style this
                    // modal needs -- everything else is host.ui structure.
                    jsx("span", { style: chipStyle(tag.color) }, tag.name),
                    checked
                      ? jsx("span", { "data-testid": "kandev-tags-picker-option-check", "aria-hidden": "true" }, "\u2713")
                      : null,
                  );
                }),
        ),
        displayError ? jsx("div", { "data-testid": "kandev-tags-picker-error" }, displayError) : null,
      );
    };
  }

  /**
   * The add-tag menu item's icon -- @tabler/icons-react's IconTag geometry,
   * inlined (host.ui exposes no icon set) at the same `mr-2 h-4 w-4`,
   * stroke="currentColor" sizing every neighbouring item in the same menu
   * uses (`Move to`/`Archive`/`Delete`), so it lines up pixel-for-pixel. The
   * renderer emits `entry.icon` bare and applies no sizing of its own, so
   * the plugin must own the className.
   */
  function tagIconElement(host) {
    return host.jsx(
      "svg",
      {
        className: "mr-2 h-4 w-4",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      host.jsx("path", {
        d: "M7.5 3h5.379a2 2 0 0 1 1.414 .586l6.121 6.121a2.121 2.121 0 0 1 0 3l-6.415 6.415a2.122 2.122 0 0 1 -3 0l-6.121 -6.121a2 2 0 0 1 -.586 -1.414v-5.379a4 4 0 0 1 4 -4z",
      }),
      host.jsx("path", { d: "M17.5 6.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }),
    );
  }

  // ---------------------------------------------------------------------
  // Host capability detection (Approach 3.3's tiering)
  // ---------------------------------------------------------------------

  /**
   * Tier 0 (no `taskFilter`): the top-bar dropdown is manage-only (no
   * checkboxes -- there is nowhere for a selection to gate cards). Tier 1
   * (`taskFilter` only): today's split -- the built-in dropdown keeps its
   * "Tags" filter section, and this dropdown stays manage-only so the two
   * don't duplicate the same control. Tier 2 (`filterSelectionApi` also
   * callable): this dropdown becomes the filter *and* the manager in one
   * place -- the registration sets `hidden: true` so the built-in dropdown's
   * section disappears. `scanStorage` is detected independently: without it
   * the delete confirmation degrades to "removed from every card" with no
   * exact count and no cascade.
   */
  function detectHostCapabilities(registry, host) {
    return {
      taskFilter: typeof registry.registerTaskFilter === "function",
      filterSelectionApi: !!(
        host.taskFilters &&
        typeof host.taskFilters.getSelection === "function" &&
        typeof host.taskFilters.setSelection === "function" &&
        typeof host.taskFilters.subscribe === "function"
      ),
      scanStorage: !!(host.storage && typeof host.storage.listByKey === "function"),
    };
  }

  /**
   * Tabler's IconFilter geometry -- a funnel, matching the built-in display
   * dropdown's own trigger convention (`IconAdjustmentsHorizontal` at
   * `h-4 w-4` inside an outline icon-only Button) without literally copying
   * Nextcloud Deck's tag-shaped filter icon.
   */
  function filterIconElement(host) {
    return host.jsx(
      "svg",
      {
        className: "h-4 w-4",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      host.jsx("path", {
        d: "M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z",
      }),
    );
  }

  /**
   * Every task's tag-id list currently in storage, scanned in one call
   * instead of depending on which cards happened to mount their chips
   * (D11/AC15). No-ops (resolves undefined) when the host predates
   * `listByKey`.
   */
  function primeTaskTagCache(host) {
    if (typeof host.storage.listByKey !== "function") return Promise.resolve();
    return host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: 1000 }).then(
      function (result) {
        result.entries.forEach(function (entry) {
          setTaskTagCache(entry.scopeId, sanitizeTagIdList(entry.value));
        });
      },
      function (err) {
        logError("prime task tag cache", err);
      },
    );
  }

  /** Counts how many tasks currently carry `tagId`. Null if the host can't scan (degrades the delete copy). */
  function countTasksWithTag(host, tagId) {
    if (typeof host.storage.listByKey !== "function") return Promise.resolve(null);
    return host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: 1000 }).then(function (result) {
      return result.entries.filter(function (entry) {
        return sanitizeTagIdList(entry.value).indexOf(tagId) !== -1;
      }).length;
    });
  }

  /**
   * Strips `tagId` from every task that carries it (D7: deleting a tag must
   * not orphan raw-id chips on cards). Each task is updated independently so
   * one failure doesn't block the rest; returns how many succeeded/failed.
   */
  function cascadeRemoveTagFromTasks(host, tagId) {
    if (typeof host.storage.listByKey !== "function") return Promise.resolve({ succeeded: 0, failed: 0 });
    return host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: 1000 }).then(function (result) {
      var affected = result.entries.filter(function (entry) {
        return sanitizeTagIdList(entry.value).indexOf(tagId) !== -1;
      });
      return affected.reduce(function (chain, entry) {
        return chain.then(function (acc) {
          return readModifyWriteTaskTags(host, entry.scopeId, MANAGER_WRITER_ID, function (current) {
            return removeTaskTagId(current, tagId);
          }).then(
            function () {
              acc.succeeded += 1;
              return acc;
            },
            function (err) {
              logError("cascade remove tag from task " + entry.scopeId, err);
              acc.failed += 1;
              return acc;
            },
          );
        });
      }, Promise.resolve({ succeeded: 0, failed: 0 }));
    });
  }

  // ---------------------------------------------------------------------
  // Delete-tag confirmation (nested modal, opened from the top-bar dropdown)
  // ---------------------------------------------------------------------

  function makeDeleteTagConfirm(host, tag, workspaceId, onDeleted) {
    var React = host.React;
    var jsx = host.jsx;
    var ui = host.ui;

    return function DeleteTagConfirm() {
      var countState = React.useState(null); // null = loading, a number, or "unknown"
      var count = countState[0];
      var setCount = countState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      React.useEffect(function () {
        countTasksWithTag(host, tag.id).then(function (result) {
          setCount(result === null ? "unknown" : result);
        });
      }, []);

      function handleConfirm() {
        setBusy(true);
        cascadeRemoveTagFromTasks(host, tag.id)
          .then(function (result) {
            return readModifyWriteCatalog(host, workspaceId, MANAGER_WRITER_ID, function (current) {
              return removeCatalogTag(current, tag.id);
            }).then(function () {
              if (result.failed > 0) {
                setError(
                  "Removed from " + result.succeeded + " card(s); " + result.failed + " card(s) failed to update.",
                );
                setBusy(false);
                return;
              }
              onDeleted();
            });
          })
          .catch(function (err) {
            logError("delete tag", err);
            setError(withDetail("Could not delete tag. Please try again.", err));
            setBusy(false);
          });
      }

      var description =
        count === null
          ? "Checking how many cards use “" + tag.name + "”…"
          : count === "unknown"
            ? "This tag will be removed from every card that uses it. This cannot be undone."
            : "Remove “" +
              tag.name +
              "” from " +
              count +
              (count === 1 ? " card" : " cards") +
              "? This cannot be undone.";

      return jsx(
        "div",
        { "data-testid": "kandev-tags-delete-confirm", style: { display: "flex", flexDirection: "column", gap: "12px" } },
        jsx("div", null, description),
        error ? jsx("div", { "data-testid": "kandev-tags-delete-error" }, error) : null,
        jsx(
          "div",
          { style: { display: "flex", justifyContent: "flex-end" } },
          jsx(
            ui.Button,
            {
              variant: "destructive",
              disabled: busy || count === null,
              "data-testid": "kandev-tags-delete-confirm-button",
              onClick: handleConfirm,
            },
            "Delete",
          ),
        ),
      );
    };
  }

  // ---------------------------------------------------------------------
  // main-top-bar dropdown: filter by tag (Tier 2) + inline rename/delete
  // ---------------------------------------------------------------------

  function makeTagsTopBarDropdown(host, capabilities) {
    var React = host.React;
    var jsx = host.jsx;
    var ui = host.ui;

    return function TagsTopBarDropdown(props) {
      var slotProps = props.slotProps || {};
      var resolvedWorkspaceId = resolveWorkspaceId(host, slotProps.workspaceId);
      var catalogAndLoaded = useCatalog(host, resolvedWorkspaceId, MANAGER_WRITER_ID);
      var catalog = catalogAndLoaded[0];
      var loaded = catalogAndLoaded[1];
      var refreshCatalog = catalogAndLoaded[2];
      var loadError = catalogAndLoaded[3];

      // Not a lazy initializer function: the plugin's minimal test React
      // host doesn't invoke function-form useState initializers.
      var selectedState = React.useState(
        capabilities.filterSelectionApi ? host.taskFilters.getSelection(TAGS_FILTER_ID) : [],
      );
      var selected = selectedState[0];
      var setSelected = selectedState[1];

      React.useEffect(function () {
        if (!capabilities.filterSelectionApi) return undefined;
        return host.taskFilters.subscribe(function () {
          setSelected(host.taskFilters.getSelection(TAGS_FILTER_ID));
        });
      }, []);

      var renamingIdState = React.useState(null);
      var renamingId = renamingIdState[0];
      var setRenamingId = renamingIdState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var draftState = React.useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      // { tagId, pendingColor } of the one row whose color picker is open,
      // or null. Picking a palette swatch or typing a hex only updates
      // `pendingColor` here -- no storage write happens until "Update".
      // Opening a second row's picker (a different tagId) simply replaces
      // this single piece of state, which closes whichever picker was open
      // before (only one may be open at a time).
      var colorPickerState = React.useState(null);
      var colorPicker = colorPickerState[0];
      var setColorPicker = colorPickerState[1];

      var displayError =
        error || (loadError ? withDetail("Could not load tags. Please try again.", loadError) : null);
      var draftName = normalizeName(draft);
      var canCreate =
        !!resolvedWorkspaceId &&
        loaded &&
        !loadError &&
        draftName !== null &&
        findTagByName(catalog, draftName) === null;

      function handleCreate() {
        if (!canCreate) return;
        setError(null);
        var createdTag = null;
        readModifyWriteCatalog(host, resolvedWorkspaceId, MANAGER_WRITER_ID, function (current) {
          var result = addCatalogTag(current, draft, null);
          if (result === null) return current;
          createdTag = result.tag;
          return result.catalog;
        })
          .then(function () {
            if (!createdTag) {
              // Another tab created this exact name between our disabled-
              // state check and this write (D6) -- surface it, don't clear
              // the input and pretend it succeeded.
              setError('A tag named "' + draftName + '" already exists.');
              return;
            }
            setDraft("");
            refreshCatalog();
          })
          .catch(function (err) {
            logError("create tag", err);
            setError(withDetail("Could not create tag. Please try again.", err));
          });
      }

      function selectedFilterValue() {
        // A pre-Select host may have persisted a multi-value selection. Keep
        // its first value visible until the user makes the next single-select
        // choice; new writes below always contain zero or one value.
        if (!selected || selected.length === 0) return ALL_TAGS_FILTER_VALUE;
        return selected[0];
      }

      function handleFilterSelection(value) {
        if (!capabilities.filterSelectionApi) return;
        var next = value === ALL_TAGS_FILTER_VALUE ? [] : [value];
        host.taskFilters.setSelection(TAGS_FILTER_ID, next);
        setSelected(next);
      }

      function handleRename(id, nextName) {
        setError(null);
        var normalized = normalizeName(nextName);
        if (normalized === null) {
          setRenamingId(null);
          return;
        }
        var changed = false;
        readModifyWriteCatalog(host, resolvedWorkspaceId, MANAGER_WRITER_ID, function (current) {
          var next = updateCatalogTag(current, id, { name: nextName });
          changed = next !== current;
          return next;
        })
          .then(function () {
            setRenamingId(null);
            if (!changed) {
              setError('A tag named "' + normalized + '" already exists.');
              return;
            }
            refreshCatalog();
          })
          .catch(function (err) {
            logError("rename tag", err);
            setRenamingId(null);
            setError(withDetail("Could not rename tag. Please try again.", err));
          });
      }

      function handleRecolor(id, nextColor) {
        setError(null);
        readModifyWriteCatalog(host, resolvedWorkspaceId, MANAGER_WRITER_ID, function (current) {
          return updateCatalogTag(current, id, { color: nextColor });
        })
          .then(refreshCatalog)
          .catch(function (err) {
            logError("recolor tag", err);
            setError(withDetail("Could not recolor tag. Please try again.", err));
          });
      }

      // Toggles a row's color picker box open/closed. Opening one closes
      // any other that was open (there is only one piece of state).
      function toggleColorPicker(tag) {
        if (colorPicker && colorPicker.tagId === tag.id) {
          setColorPicker(null);
          return;
        }
        setColorPicker({ tagId: tag.id, pendingColor: tag.color });
      }

      // Local-only -- picking a palette swatch or typing a hex must never
      // write to storage by itself (that was the "doesn't apply until
      // blur" bug: the old bare `<input type="color">` wrote on blur with
      // no way to preview or discard first).
      function setPendingColor(nextColor) {
        setColorPicker(function (current) {
          if (!current) return current;
          return Object.assign({}, current, { pendingColor: nextColor });
        });
      }

      // Update: writes the pending color via the existing handleRecolor ->
      // readModifyWriteCatalog path exactly once, then closes the picker.
      // Every other chip surface already subscribes to the catalog store
      // under its own writerId (see useCatalog), so they repaint on their
      // own once this write lands -- no extra plumbing needed here.
      function commitColor(tag) {
        handleRecolor(tag.id, colorPicker.pendingColor);
        setColorPicker(null);
      }

      // Cancel: discards the pending color and closes the picker with no
      // storage write. The swatch itself always renders the catalog's
      // committed tag.color (never pendingColor), so simply closing the
      // picker already "restores" it -- there is nothing else to revert.
      function cancelColorPicker() {
        setColorPicker(null);
      }

      function openDeleteConfirm(tag) {
        var modal = host.openModal({
          title: "Delete tag",
          size: "sm",
          content: makeDeleteTagConfirm(host, tag, resolvedWorkspaceId, function () {
            refreshCatalog();
            modal.close();
          }),
        });
      }

      var triggerButton = jsx(
        ui.Button,
        {
          variant: "outline",
          size: "icon-lg",
          type: "button",
          className: "cursor-pointer",
          "data-testid": "kandev-tags-topbar-button",
          "aria-label": capabilities.filterSelectionApi ? "Filter by tag" : "Manage tags",
        },
        filterIconElement(host),
      );

      if (!resolvedWorkspaceId) {
        return jsx(
          ui.DropdownMenu,
          null,
          jsx(ui.DropdownMenuTrigger, { asChild: true }, triggerButton),
          jsx(
            ui.DropdownMenuContent,
            { align: "end", style: { zIndex: TOPBAR_DROPDOWN_Z_INDEX } },
            jsx("div", { className: "text-muted-foreground text-xs px-2 py-1.5" }, "Select a workspace to use tags."),
          ),
        );
      }

      return jsx(
        ui.DropdownMenu,
        null,
        jsx(ui.DropdownMenuTrigger, { asChild: true }, triggerButton),
        jsx(
          ui.DropdownMenuContent,
          {
            align: "end",
            className: "p-2",
            style: { width: TOPBAR_WIDTH + "px", zIndex: TOPBAR_DROPDOWN_Z_INDEX },
            "data-testid": "kandev-tags-topbar-content",
          },
          jsx(
            "div",
            { className: "text-muted-foreground text-xs px-2 py-1.5" },
            capabilities.filterSelectionApi ? "Filter by tag" : "Manage tags",
          ),
          capabilities.filterSelectionApi
            ? jsx(
                "div",
                { style: { padding: "4px 8px 8px" } },
                jsx("label", { className: "text-xs", htmlFor: "kandev-tags-filter-select" }, "Tag"),
                jsx(
                  ui.Select,
                  {
                    value: selectedFilterValue(),
                    onValueChange: handleFilterSelection,
                  },
                  jsx(
                    ui.SelectTrigger,
                    {
                      id: "kandev-tags-filter-select",
                      "data-testid": "kandev-tags-topbar-select",
                      className: "mt-1 w-full",
                      "aria-label": "Filter by tag",
                    },
                    jsx(ui.SelectValue, { placeholder: "All tags" }),
                  ),
                  jsx(
                    ui.SelectContent,
                    null,
                    jsx(ui.SelectItem, { value: ALL_TAGS_FILTER_VALUE }, "All tags"),
                    catalog.map(function (tag) {
                      return jsx(
                        ui.SelectItem,
                        { key: tag.id, value: tag.id, "data-testid": "kandev-tags-topbar-select-option" },
                        jsx("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
                          jsx("span", {
                            "aria-hidden": "true",
                            style: {
                              width: "10px",
                              height: "10px",
                              borderRadius: "999px",
                              background: renderableColor(tag.color),
                              border: "1px solid rgba(0,0,0,0.15)",
                            },
                          }),
                          tag.name,
                        ),
                      );
                    }),
                    jsx(ui.SelectItem, { value: UNTAGGED_FILTER_VALUE }, "Untagged"),
                  ),
                ),
              )
            : null,
          jsx(ui.DropdownMenuSeparator, null),
          jsx(
            "div",
            { style: { display: "flex", gap: "6px", padding: "4px 8px" } },
            jsx(ui.Input, {
              "data-testid": "kandev-tags-topbar-create-input",
              value: draft,
              placeholder: "New tag name…",
              maxLength: MAX_TAG_LENGTH,
              // flex:1/minWidth:0 so the input can grow to fill the box's
              // full width -- a MAX_TAG_LENGTH-char name must fit with no
              // horizontal scroll -- while the Create button (below) keeps
              // a fixed width instead of being squeezed by a long name.
              // The budget: TOPBAR_WIDTH - 16 (p-2) - 16 (row padding)
              // - CREATE_BUTTON_WIDTH - 6 (gap) = 282px of input, 264px of
              // it text area once the input's padding and border are out.
              style: { flex: 1, minWidth: 0, height: "28px" },
              onChange: function (e) {
                setDraft(e.target.value);
              },
              onKeyDown: function (e) {
                if (e.key === "Enter") handleCreate();
              },
            }),
            jsx(
              ui.Button,
              {
                type: "button",
                size: "sm",
                "data-testid": "kandev-tags-topbar-create",
                disabled: !canCreate,
                style: { flexShrink: 0, width: CREATE_BUTTON_WIDTH + "px" },
                onClick: handleCreate,
              },
              "Create",
            ),
          ),
          jsx(ui.DropdownMenuSeparator, null),
          !loaded
            ? jsx("div", { className: "text-muted-foreground text-xs px-2 py-1.5" }, "Loading…")
            : catalog.length === 0
              ? jsx("div", { className: "text-muted-foreground text-xs px-2 py-1.5" }, "No tags yet.")
              : buildTagRows(),
          displayError ? jsx("div", { "data-testid": "kandev-tags-topbar-error" }, displayError) : null,
        ),
      );

      /**
       * One `{ display: "grid", ... }` row per catalog tag (swatch,
       * name pill/rename input, delete button --
       * see tagRowStyle for the grid's column widths), plus -- inserted
       * directly beneath the one row whose color picker is open, if any --
       * that row's picker box. Built as a flat array (rather than nesting
       * the picker inside the row) so the row's own DOM stays a single grid
       * with a stable, name-length-independent delete-column x-offset.
       */
      function buildTagRows() {
        var rows = [];
        catalog.forEach(function (tag) {
          rows.push(tagRowEl(tag));
          if (colorPicker && colorPicker.tagId === tag.id) rows.push(colorPickerBoxEl(tag));
        });
        return rows;
      }

      function tagRowEl(tag) {
        return jsx(
          "div",
          {
            key: tag.id,
            "data-testid": "kandev-tags-topbar-row",
            style: tagRowStyle(capabilities),
          },
          jsx("button", {
            type: "button",
            "data-testid": "kandev-tags-topbar-color-swatch",
            "aria-label": "Recolor tag " + tag.name,
            onClick: function () {
              toggleColorPicker(tag);
            },
            style: Object.assign(
              { background: renderableColor(tag.color), border: "1px solid rgba(0,0,0,0.15)" },
              TOPBAR_SWATCH_BUTTON_STYLE_BASE,
            ),
          }),
          renamingId === tag.id
            ? jsx(ui.Input, {
                autoFocus: true,
                "data-testid": "kandev-tags-topbar-rename-input",
                defaultValue: tag.name,
                maxLength: MAX_TAG_LENGTH,
                style: { height: "24px", minWidth: 0 },
                onBlur: function (e) {
                  handleRename(tag.id, e.target.value);
                },
                onKeyDown: function (e) {
                  if (e.key === "Enter") handleRename(tag.id, e.target.value);
                  if (e.key === "Escape") setRenamingId(null);
                },
              })
            : jsx(
                "span",
                {
                  style: Object.assign(
                    { minWidth: 0, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis" },
                    chipStyle(tag.color),
                  ),
                  "data-testid": "kandev-tags-topbar-pill",
                  onClick: function () {
                    setRenamingId(tag.id);
                  },
                },
                tag.name,
              ),
          jsx(
            "button",
            {
              type: "button",
              "aria-label": "Delete tag " + tag.name,
              "data-testid": "kandev-tags-topbar-delete",
              className: "hover:bg-accent",
              onClick: function () {
                openDeleteConfirm(tag);
              },
              style: TOPBAR_DELETE_BUTTON_STYLE,
            },
            "×",
          ),
        );
      }

      /**
       * The picker box rendered directly beneath `tag`'s row while its
       * color swatch is toggled open: the PALETTE as swatch buttons (the
       * pending color outlined), a native hex `<input type="color">`
       * feeding the same pending-color state, a live preview pill, and
       * Update/Cancel. Picking a swatch or typing a hex only calls
       * setPendingColor -- no storage write.
       */
      function colorPickerBoxEl(tag) {
        var pending = colorPicker.pendingColor;
        return jsx(
          "div",
          {
            key: tag.id + "-color-picker",
            "data-testid": "kandev-tags-topbar-color-picker",
            style: {
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              padding: "8px",
              margin: "0 4px 4px",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: "6px",
            },
          },
          jsx.apply(
            null,
            ["div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } }].concat(
              PALETTE.map(function (color) {
                var isPending = pending && pending.toLowerCase() === color.toLowerCase();
                return jsx("button", {
                  key: color,
                  type: "button",
                  "data-testid": "kandev-tags-topbar-color-palette-swatch",
                  "aria-label": "Color " + color,
                  "aria-pressed": isPending,
                  onClick: function () {
                    setPendingColor(color);
                  },
                  style: Object.assign(
                    { background: color, border: isPending ? "2px solid #111827" : "1px solid rgba(0,0,0,0.15)" },
                    TOPBAR_SWATCH_BUTTON_STYLE_BASE,
                  ),
                });
              }),
            ),
          ),
          jsx(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "8px" } },
            jsx("input", {
              type: "color",
              "data-testid": "kandev-tags-topbar-color-hex-input",
              "aria-label": "Custom color for " + tag.name,
              value: HEX_COLOR_RE.test(pending) ? pending : DEFAULT_COLOR,
              onChange: function (e) {
                setPendingColor(e.target.value);
              },
              style: { width: "28px", height: "28px", padding: 0, border: "none", background: "none", cursor: "pointer" },
            }),
            jsx(
              "span",
              { "data-testid": "kandev-tags-topbar-color-preview", style: chipStyle(pending) },
              tag.name,
            ),
          ),
          jsx(
            "div",
            { style: { display: "flex", justifyContent: "flex-end", gap: "6px" } },
            jsx(
              ui.Button,
              {
                type: "button",
                size: "sm",
                variant: "outline",
                "data-testid": "kandev-tags-topbar-color-cancel",
                onClick: cancelColorPicker,
              },
              "Cancel",
            ),
            jsx(
              ui.Button,
              {
                type: "button",
                size: "sm",
                "data-testid": "kandev-tags-topbar-color-update",
                onClick: function () {
                  commitColor(tag);
                },
              },
              "Update",
            ),
          ),
        );
      }
    };
  }

  /**
   * Grid column widths for one Tags-box tag row: a fixed 20px swatch
   * column, a flexible name-pill column, and a fixed 24px delete column.
   * `alignItems: "center"` plus
   * this fixed sizing is what keeps the delete button's x-offset identical
   * on every row regardless of the tag name's length (the bug this
   * replaces: a bare flex row where a long name pushed the delete button
   * around).
   */
  function tagRowStyle(capabilities) {
    return {
      display: "grid",
      gridTemplateColumns: "20px 1fr 24px",
      alignItems: "center",
      gap: "8px",
      padding: "4px 8px",
    };
  }

  // ---------------------------------------------------------------------
  // registerTaskFilter (feature-detected -- no-ops on hosts predating it)
  // ---------------------------------------------------------------------

  function registerTagFilter(registry, host, capabilities) {
    if (!capabilities.taskFilter) return;

    var catalog = [];
    var currentWorkspaceId = null;
    var unsubscribeStorage = null;

    function refreshCatalog() {
      if (!currentWorkspaceId) {
        catalog = [];
        return;
      }
      host.storage.get(CATALOG_SCOPE, currentWorkspaceId, CATALOG_KEY).then(
        function (entry) {
          catalog = sanitizeCatalog(entry ? entry.value : []);
        },
        function (err) {
          // Previously unhandled (D3) -- an unhandled rejection fired on
          // every workspace switch that hit a storage error.
          logError("load tag filter catalog", err);
        },
      );
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
      // A tag set gathered under the previous workspace must never inform
      // this one's filter (D13/AC20).
      clearTaskTagCache();
      if (unsubscribeStorage) {
        unsubscribeStorage();
        unsubscribeStorage = null;
      }
      if (currentWorkspaceId) {
        refreshCatalog();
        if (capabilities.scanStorage) primeTaskTagCache(host);
        unsubscribeStorage = host.storage.subscribe(
          { scope: CATALOG_SCOPE, scopeId: currentWorkspaceId, key: CATALOG_KEY },
          refreshCatalog,
        );
      } else {
        catalog = [];
      }
    }

    // Registered once: always checks the *current* unsubscribeStorage, so a
    // later workspace switch's subscription is released on destroy() too,
    // without accumulating one disposable per switch (D12).
    addDisposable(function () {
      if (unsubscribeStorage) {
        unsubscribeStorage();
        unsubscribeStorage = null;
      }
    });

    setWorkspace(resolveWorkspaceId(host, null));
    addDisposable(
      host.store.subscribe(function () {
        setWorkspace(resolveWorkspaceId(host, null));
      }),
    );

    if (capabilities.scanStorage) {
      // Keeps taskTagCache correct for cards that never mount their chips
      // (D11/AC15), scoped wide (no scopeId) so any task's tag write --
      // anywhere, not just the active workspace -- updates the cache.
      addDisposable(
        host.storage.subscribe({ scope: TASK_SCOPE, key: TASK_KEY }, function (change) {
          host.storage.get(TASK_SCOPE, change.scopeId, TASK_KEY).then(
            function (entry) {
              setTaskTagCache(change.scopeId, sanitizeTagIdList(entry ? entry.value : []));
            },
            function (err) {
              logError("refresh primed task tag cache entry", err);
            },
          );
        }),
      );
    }

    registry.registerTaskFilter({
      id: TAGS_FILTER_ID,
      label: "Tags",
      // Tier 2: this plugin's own top-bar dropdown is the filter UI, so the
      // built-in dropdown's section would just duplicate it.
      hidden: capabilities.filterSelectionApi,
      getOptions: function () {
        return catalog
          .map(function (tag) {
            // renderableColor for the same reason the chips use it: the host
            // paints this straight onto a swatch, and a stored colour it
            // cannot parse would leave that swatch blank.
            return { value: tag.id, label: tag.name, color: renderableColor(tag.color) };
          })
          .concat([{ value: UNTAGGED_FILTER_VALUE, label: "Untagged" }]);
      },
      matches: function (context, selected) {
        if (!selected || selected.length === 0) return true;
        // Cards that haven't mounted their TagChips yet have no cache entry
        // -- see getTaskTagCacheEntry's comment above. Treat that as "no
        // tags" rather than excluding the card outright.
        var tagIds = getTaskTagCacheEntry(context.taskId) || [];
        if (selected.indexOf(UNTAGGED_FILTER_VALUE) !== -1 && tagIds.length === 0) return true;
        return tagIds.some(function (id) {
          return selected.indexOf(id) !== -1;
        });
      },
    });
  }

  // ---------------------------------------------------------------------
  // registerTaskListFacet (newer hosts only)
  // ---------------------------------------------------------------------

  /**
   * Projects this user's private tags into the host's optional, page-local
   * task-list facet API. The host owns registration generation/lifecycle;
   * this plugin owns only its storage subscriptions and releases those in
   * destroy() through addDisposable. Older hosts simply do not have this
   * registry method, so their existing card chips and board filtering keep
   * working unchanged.
   */
  function registerTagTaskListFacet(registry, host) {
    if (typeof registry.registerTaskListFacet !== "function") return;

    var catalog = [];
    var currentWorkspaceId = null;
    var unsubscribeCatalog = null;
    var listeners = [];

    function notify() {
      listeners.slice().forEach(function (listener) {
        try {
          listener();
        } catch (err) {
          logError("notify task-list tag facet", err);
        }
      });
    }

    function refreshCatalog() {
      if (!currentWorkspaceId) {
        catalog = [];
        notify();
        return;
      }
      host.storage.get(CATALOG_SCOPE, currentWorkspaceId, CATALOG_KEY).then(
        function (entry) {
          catalog = sanitizeCatalog(entry ? entry.value : []);
          notify();
        },
        function (err) {
          // Empty values deliberately give the task list its untagged
          // fallback while a transient read failure is recovered.
          catalog = [];
          logError("load task-list tag facet catalog", err);
          notify();
        },
      );
    }

    function setWorkspace(workspaceId) {
      if (workspaceId === currentWorkspaceId) return;
      currentWorkspaceId = workspaceId || null;
      clearTaskTagCache();
      if (unsubscribeCatalog) {
        unsubscribeCatalog();
        unsubscribeCatalog = null;
      }
      if (currentWorkspaceId) {
        refreshCatalog();
        unsubscribeCatalog = host.storage.subscribe(
          { scope: CATALOG_SCOPE, scopeId: currentWorkspaceId, key: CATALOG_KEY },
          refreshCatalog,
        );
      } else {
        catalog = [];
        notify();
      }
    }

    setWorkspace(resolveWorkspaceId(host, null));
    addDisposable(function () {
      if (unsubscribeCatalog) unsubscribeCatalog();
      unsubscribeCatalog = null;
      listeners = [];
    });
    addDisposable(
      host.store.subscribe(function () {
        setWorkspace(resolveWorkspaceId(host, null));
      }),
    );
    addDisposable(
      host.storage.subscribe({ scope: TASK_SCOPE, key: TASK_KEY }, function (change) {
        host.storage.get(TASK_SCOPE, change.scopeId, TASK_KEY).then(
          function (entry) {
            setTaskTagCache(change.scopeId, sanitizeTagIdList(entry ? entry.value : []));
            notify();
          },
          function (err) {
            logError("refresh task-list tag facet task", err);
            notify();
          },
        );
      }),
    );
    // Hydrate values for rows that have not mounted their chip component.
    // A truncated result is still safe: entries we did receive are useful;
    // absent entries retain the explicit untagged/loading fallback above.
    if (typeof host.storage.listByKey === "function") {
      host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: 1000 }).then(
        function (result) {
          (result.entries || []).forEach(function (entry) {
            setTaskTagCache(entry.scopeId, sanitizeTagIdList(entry.value));
          });
          notify();
        },
        function (err) {
          logError("prime task-list tag facet", err);
          notify();
        },
      );
    }

    registry.registerTaskListFacet({
      id: TAGS_FILTER_ID,
      label: "Tag",
      getValues: function (context) {
        // Never use a prior workspace's catalog when the host provides a
        // task workspace context. A missing workspace keeps compatibility
        // with early host drafts and relies on the active-workspace reset.
        if (context.workspaceId && context.workspaceId !== currentWorkspaceId) return [];
        var tagIds = getTaskTagCacheEntry(context.taskId);
        if (!tagIds) return [];
        return tagIds
          .map(function (tagId) {
            var tag = resolveTag(catalog, tagId);
            return tag ? { value: tag.id, label: tag.name, color: renderableColor(tag.color) } : null;
          })
          .filter(function (tag) {
            return tag !== null;
          });
      },
      subscribe: function (listener) {
        listeners.push(listener);
        return function () {
          listeners = listeners.filter(function (candidate) {
            return candidate !== listener;
          });
        };
      },
    });
  }

  window.registerKandevPlugin("kandev-plugin-tags", {
    initialize: function (registry, host) {
      // Idempotent: a disable->enable cycle re-runs initialize() against the
      // cached registration without a matching destroy() call in between
      // (see destroy's own comment), so drain any still-pending disposables
      // from a prior initialize() first -- otherwise each cycle stacks
      // another live host.store/host.storage listener (D12) -- and reset the
      // shared stores alongside it, since draining is what unsubscribed
      // them (see resetSharedStores; without this the stores would never
      // resubscribe or refetch again for the life of the page).
      drainDisposables();
      resetSharedStores();
      var capabilities = detectHostCapabilities(registry, host);
      registry.registerComponent("task-card-tags", makeTagChips(host, { removable: true }));
      // Sidebar row / `/tasks` list row: smaller chips, no per-chip remove
      // (removal stays confined to the "Add tag..." modal), capped at
      // TASK_ROW_CHIP_LIMIT visible chips plus a "+N" indicator.
      registry.registerComponent("task-row-metadata", makeTagChips(host, { removable: false, dense: true }));
      registry.registerComponent("main-top-bar", makeTagsTopBarDropdown(host, capabilities));

      registry.registerTaskMenuAction({
        id: "add-tag",
        label: "Add tag\u2026",
        icon: tagIconElement(host),
        // Flat, top-level item between "Move to"/"Send to workflow" and
        // "Link" -- shipped in kdlbs/kandev PR #2351.
        group: "primary",
        run: function (context) {
          return host.openModal({
            title: "Tags",
            size: "md",
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
      registerTagFilter(registry, host, capabilities);
      registerTagTaskListFacet(registry, host);
    },
    // Called by the host's unloadPlugin on disable/uninstall (types.ts's
    // KandevPlugin already supports this -- the plugin simply never
    // implemented it before, which is why disabling it left its
    // host.store/host.storage listeners running forever, each still
    // calling host.storage.get on every workspace switch against a plugin
    // the backend now answers 404 "plugin is not active" for (D12).
    destroy: function () {
      // Reset the shared stores alongside the drain that unsubscribed them
      // -- a fresh initialize() after this must refetch rather than serve
      // data cached from a now-unsubscribed plugin instance.
      drainDisposables();
      resetSharedStores();
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
      logError: logError,
      resolveWorkspaceId: resolveWorkspaceId,
      setTaskTagCache: setTaskTagCache,
      readModifyWrite: readModifyWrite,
      sanitizeTagIdList: sanitizeTagIdList,
      sanitizeCatalog: sanitizeCatalog,
      renderableColor: renderableColor,
      chipStyle: chipStyle,
      denseChipStyle: denseChipStyle,
      resolveRgb: resolveRgb,
      contrastRatio: contrastRatio,
      chipTextColor: chipTextColor,
      MAX_TAG_LENGTH: MAX_TAG_LENGTH,
      MAX_TAGS_PER_TASK: MAX_TAGS_PER_TASK,
      TOPBAR_WIDTH: TOPBAR_WIDTH,
      CREATE_BUTTON_WIDTH: CREATE_BUTTON_WIDTH,
      TOPBAR_DROPDOWN_Z_INDEX: TOPBAR_DROPDOWN_Z_INDEX,
      PALETTE: PALETTE,
      DEFAULT_COLOR: DEFAULT_COLOR,
      UNTAGGED_FILTER_VALUE: UNTAGGED_FILTER_VALUE,
      ALL_TAGS_FILTER_VALUE: ALL_TAGS_FILTER_VALUE,
      TAGS_FILTER_ID: TAGS_FILTER_ID,
      makeTagChips: makeTagChips,
      makeTagPickerModal: makeTagPickerModal,
      makeTagsTopBarDropdown: makeTagsTopBarDropdown,
      makeDeleteTagConfirm: makeDeleteTagConfirm,
      detectHostCapabilities: detectHostCapabilities,
      countTasksWithTag: countTasksWithTag,
      cascadeRemoveTagFromTasks: cascadeRemoveTagFromTasks,
      primeTaskTagCache: primeTaskTagCache,
      registerTagTaskListFacet: registerTagTaskListFacet,
    },
  });
})();
