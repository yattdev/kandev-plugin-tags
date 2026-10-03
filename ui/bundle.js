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
 *     (TagPickerModal) to search/create and multi-select tags for the card.
 *     On a host that renders plugin submenus it becomes that editor plus a
 *     quick list -- "More tags..." first, then the workspace's latest-used
 *     tags, one click each (see quickTagItems); a host that predates the
 *     submenu field still renders the flat item and calls run;
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
 * A tag's color is explicit when a person (or `create_tag`) supplied one;
 * otherwise it is derived from the tag's name by `colorFromName` -- the same
 * content-addressed hash the backend applies (autoTagColor in
 * server/agent_tags.go), so a name created from the board and the same name
 * created by an agent come out identical. The operator can turn that off
 * (the manifest's auto_color setting); the picker in the Tags box is where a
 * color is chosen instead.
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
 * re-reading and reapplying the caller's intent once. The chip rows and the
 * icon glyphs are hand-built from host.React/host.jsx; the picker modal and the
 * Tags box manager use host.ui primitives (Input, Button, ScrollArea, the
 * DropdownMenu and Select families), so the bundle needs no build step but does
 * assume those named components exist on the host. A single
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
  //
  // The unit is UTF-16 code units, not code points, and the backend's cap
  // (maxTagNameRunes) counts runes -- so this side is the stricter one for
  // astral characters: a 12-emoji name is refused here and accepted by
  // create_tag. That direction is deliberate and safe: the cap is calibrated
  // against the input's width above, an agent-created name never goes through
  // this input, and a name this side refuses can never reach the post-create
  // lookup that requires the two normalizations to agree.
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
  // One page of the host's cross-scope scan (`host.storage.listByKey`), and the
  // only page we can see: a result whose `truncated` flag is set means more
  // entries exist than this, which the delete confirmation and its cascade treat
  // as "not the whole picture" rather than as a count (see countTasksWithTag).
  var TAG_SCAN_LIMIT = 1000;
  var CONFLICT_RETRY_LIMIT = 1;
  // A plugin update briefly replaces the backend process. Reads issued in
  // that window can receive 502/503/504 (or a network error) even though the
  // shared action and its host-owned state still exist. Retry only this
  // idempotent read, with a small bounded schedule; the regular 30-second
  // refresh/focus hooks remain the long-tail recovery path after it is spent.
  var SHARED_ACTION_RETRY_DELAYS = [250, 1000, 3000];
  // Private compatibility reads have the same short retry window. After it
  // is spent, foreground/reconnect, remount, or the visible Retry control can
  // start a new window; the shared 30-second poll does not touch these stores.
  var PRIVATE_READ_RETRY_DELAYS = [250, 1000, 3000];
  // Radix Select reserves the empty string for clearing its own value, so
  // use a private non-empty sentinel for the "All tags" UI choice.
  var ALL_TAGS_FILTER_VALUE = "__all_tags__";
  var UNTAGGED_FILTER_VALUE = "__untagged__";
  var TAGS_FILTER_ID = "tags";
  var TASK_ROW_CHIP_LIMIT = 3;
  // How many recently used workspace tags the card menu's "Add tag..." submenu
  // offers below its "More tags..." entry. The list is a shortcut, not a
  // second catalog: the picker behind "More tags..." still shows every tag.
  var QUICK_TAG_LIMIT = 5;

  // Shapes of generated catalog tag ids -- used by resolveTag to distinguish
  // an *orphaned* v2 tag id (deleted from the catalog but still referenced by
  // a stale card) from a legacy v1 plain-string tag name. Browser-created v2
  // ids use makeTagId's two base36 groups; the shared backend uses 10 random
  // bytes encoded as exactly 20 lowercase hex characters (newTagID in
  // server/agent_tags.go). Keep both shapes exact so similar legacy names
  // such as "tag-deadbeef" remain visible.
  var GENERATED_TAG_ID_RE = /^tag-(?:[0-9a-f]{20}|[0-9a-z]+-[0-9a-z]+)$/;

  // Distinct writerIds (not the shared per-tab default) so one surface's own
  // subscription doesn't treat another open surface's writes as its own echo
  // -- the chip row, the add/pick modal, and the manager modal can all be
  // open on the same card/workspace at once (see PluginStorageSetOptions).
  var CHIPS_WRITER_ID = "tags-chips";
  var PICKER_WRITER_ID = "tags-picker";
  var MANAGER_WRITER_ID = "tags-manager";

  // Curated deeper hues and shades, rather than a handful of loud primaries.
  // Keep this in sync with server/agent_tags.go and testdata/tag-colors.json.
  var PALETTE = [
    "#b45309", // amber
    "#c2410c", // burnt orange
    "#b91c1c", // red
    "#be185d", // rose
    "#a21caf", // fuchsia
    "#6d28d9", // violet
    "#4338ca", // indigo
    "#1d4ed8", // blue
    "#0369a1", // ocean blue
    "#0e7490", // cyan
    "#0f766e", // teal
    "#15803d", // green
    "#4d7c0f", // olive
    "#475569", // slate
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

  /**
   * The characters stripped from both ends of a user-supplied string -- a tag
   * name or a color: ECMAScript's WhiteSpace set plus its line terminators,
   * which is exactly what String.prototype.trim removes today.
   *
   * Written out rather than delegating to trim() so both ends of the contract
   * are frozen at the same set: the backend's counterpart (stripFromEdges in
   * server/agent_tags.go) is an explicit list, and trim() is defined by
   * reference to Unicode's Zs property, so a future Unicode revision could widen
   * the engine's set and silently desynchronize the two sides again -- which is
   * precisely the bug this replaced (Go's strings.TrimSpace vs this set differ
   * by U+FEFF and U+0085, and a name in either state was stored under one
   * spelling while the create-and-apply lookup used the other).
   *
   * testdata/tag-colors.json ("trim") carries the same code points as the shared
   * contract, asserted from both suites.
   *
   * Only ever used with String.replace: a /g/ regex carries lastIndex state, so
   * it is unsafe with test/exec.
   */
  var EDGE_TRIM_RE = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g;

  /** Trims a name or color of exactly the characters both backends agree on. */
  function trimEdges(text) {
    return text.replace(EDGE_TRIM_RE, "");
  }

  /**
   * Replaces an unpaired UTF-16 surrogate with U+FFFD -- what Go's JSON decoder
   * already substitutes, so it is the string the backend stores for such a name.
   * Without this the client would keep the raw surrogate and compare it against
   * a stored name it can never equal, which is the same class of miss the edge
   * trim above exists to prevent (the create-and-apply lookup reports "Could not
   * create tag" while the tag sits in the catalog). Paired surrogates -- any
   * astral character -- are kept verbatim, and a name can only contain an
   * unpaired one by pasting or by a malformed import.
   */
  function foldLoneSurrogates(text) {
    return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, function (pair) {
      return pair.length === 2 ? pair : "\uFFFD";
    });
  }

  /** Normalizes a raw tag name (foldLoneSurrogates + trimEdges), rejecting empty or over-MAX_TAG_LENGTH. Null if invalid. */
  function normalizeName(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = trimEdges(foldLoneSurrogates(raw));
    if (trimmed.length === 0 || trimmed.length > MAX_TAG_LENGTH) return null;
    return trimmed;
  }

  /** Validates/normalizes a hex color string (3 or 6 digit, `#` required). Null if invalid. */
  function normalizeColor(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = trimEdges(raw);
    if (!HEX_COLOR_RE.test(trimmed)) return null;
    return trimmed.toLowerCase();
  }

  /** Deterministic-enough unique id for a new catalog tag (no uuid dependency). */
  function makeTagId() {
    return "tag-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /**
   * One FNV-1a step over a single byte. `Math.imul` is what keeps the 32-bit
   * multiply exact: `hash * 16777619` would round away the low bits once the
   * product passes 2^53, and every caller compares against Go's uint32
   * arithmetic (`autoTagColor` in server/agent_tags.go).
   */
  function fnvByte(hash, byte) {
    return Math.imul(hash ^ byte, 16777619);
  }

  /**
   * A new tag's default color, derived from its name -- the content-addressed
   * scheme Proxmox tags and GitHub labels use, so the same name looks the same
   * wherever and by whomever it is created. The rule this replaced assigned
   * colors by catalog length (`PALETTE[catalog.length % PALETTE.length]`), so
   * creating or deleting any *other* tag silently recolored an existing one.
   *
   * On a host with plugin actions this mirrors what the backend already did
   * (this function is the private-storage fallback's copy of the rule); the
   * operator can turn the derivation off with the auto_color setting, which
   * this legacy path cannot read -- see the README's "Tag colors".
   *
   * FNV-1a (32-bit) over the name's UTF-8 bytes, reduced to an index into
   * PALETTE. It must match autoTagColor (server/agent_tags.go) byte for byte:
   * a person creating a tag in the Tags box and an agent calling create_tag
   * with the same name have to land on the same color, so neither the hash nor
   * the palette may drift. Two guards keep them in step: testdata/tag-colors.json
   * pins the expected color of every name in the fixture (both suites assert
   * it), and both suites also assert their own palette against the fixture's.
   *
   * The encoder is written out rather than delegating to TextEncoder so this
   * stays dependency-free and allocation-free in the vm realm the UI tests
   * evaluate the bundle in. A lone surrogate encodes as U+FFFD because that is
   * what Go's JSON decoder substitutes before the server ever sees the name;
   * paired surrogates (any emoji) encode as their real 4-byte sequence.
   *
   * `name` is hashed exactly as it is stored: trimmed, case preserved. Names
   * differing only in case cannot coexist in one catalog anyway.
   */
  function colorFromName(name) {
    var hash = 2166136261; // FNV-1a 32-bit offset basis
    for (var i = 0; i < name.length; i++) {
      var code = name.charCodeAt(i);
      if (code < 0x80) {
        hash = fnvByte(hash, code);
      } else if (code < 0x800) {
        hash = fnvByte(hash, 0xc0 | (code >> 6));
        hash = fnvByte(hash, 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdfff) {
        var low = code <= 0xdbff && i + 1 < name.length ? name.charCodeAt(i + 1) : 0;
        if (low >= 0xdc00 && low <= 0xdfff) {
          var astral = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          hash = fnvByte(hash, 0xf0 | (astral >> 18));
          hash = fnvByte(hash, 0x80 | ((astral >> 12) & 0x3f));
          hash = fnvByte(hash, 0x80 | ((astral >> 6) & 0x3f));
          hash = fnvByte(hash, 0x80 | (astral & 0x3f));
          i++;
        } else {
          // Lone surrogate: U+FFFD, as Go's JSON decoder already substituted.
          hash = fnvByte(hash, 0xef);
          hash = fnvByte(hash, 0xbf);
          hash = fnvByte(hash, 0xbd);
        }
      } else {
        hash = fnvByte(hash, 0xe0 | (code >> 12));
        hash = fnvByte(hash, 0x80 | ((code >> 6) & 0x3f));
        hash = fnvByte(hash, 0x80 | (code & 0x3f));
      }
    }
    return PALETTE[(hash >>> 0) % PALETTE.length];
  }

  /**
   * Case-insensitive name lookup within a catalog array.
   *
   * An *approximation* of the backend's rule, not the same rule: the server
   * compares names with Go's strings.EqualFold (Unicode simple case folding)
   * while this lowers both sides, and the two disagree for the characters whose
   * folding is not their lowercase form -- the classic pair being final sigma
   * ("\u03c2" folds to "\u03c3" but lowercases to itself) and long s. Both
   * directions follow: this check can call a name free that the server then
   * refuses as a duplicate (the common case, and the one that gets a create
   * through to an honest "already exists" -- see isDuplicateNameError), and it can
   * refuse one the server would accept, because a stored "i" plus a combining dot
   * lowercases to the same string as "\u0130" while EqualFold keeps them apart.
   * The server stays authoritative -- reproducing its rule here would mean
   * shipping Unicode's fold table into the bundle.
   */
  function findTagByName(catalog, name) {
    var key = nameKey(name);
    if (key === null) return null;
    for (var i = 0; i < catalog.length; i++) {
      if (nameKey(catalog[i].name) === key) return catalog[i];
    }
    return null;
  }

  /**
   * The key two names are compared by: normalized the way every write path
   * normalizes a name, then lowercased. Comparing keys rather than raw strings
   * means a catalog entry that slipped in unnormalized -- sanitizeCatalog checks
   * a tag's *shape* only, so private or imported storage can hold " urgent " --
   * still blocks its own normalized duplicate, which is the invariant the README
   * documents. Names that do not normalize at all (empty after trimming, or over
   * the length cap) have no key and match nothing.
   */
  function nameKey(name) {
    var normalized = normalizeName(name);
    return normalized === null ? null : normalized.toLowerCase();
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
   * the existing tag's id instead). A missing or invalid `rawColor` falls back
   * to colorFromName(name) -- the derived default, not a positional palette
   * color.
   *
   * This is the private-storage layer, reached only on hosts without plugin
   * actions, and it derives unconditionally: a UI bundle has no channel to the
   * operator's `auto_color` setting (the plugin config is backend-only, and the
   * host's plugin API exposes none), so the choice here is between ignoring an
   * explicit opt-out and ignoring the documented default for everyone on that
   * tier. It keeps the default -- and the tier's previous behaviour, which was
   * always colored -- and the setting's own description tells the operator that
   * such a host derives.
   */
  function addCatalogTag(catalog, rawName, rawColor) {
    var name = normalizeName(rawName);
    if (name === null) return null;
    if (findTagByName(catalog, name)) return null;
    var color = normalizeColor(rawColor) || colorFromName(name);
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

  /**
   * Combines canonical shared applications with the private compatibility
   * projection. A task can retain the same stable id in both stores after an
   * upgrade; shared data wins because it carries current ownership, note,
   * removal, name, and color semantics. Dedupe within either source too so a
   * malformed/migrated repeated id still renders as one logical application.
   */
  function mergeTagRepresentations(sharedTags, privateTags, sharedCatalog) {
    var seenIds = [];
    var merged = sharedTags.filter(function (tag) {
      if (seenIds.indexOf(tag.id) !== -1) return false;
      seenIds.push(tag.id);
      return true;
    });
    privateTags.forEach(function (tag) {
      // On a shared-actions host, catalog membership means this id is owned
      // by the canonical store even when it is no longer applied to this
      // task. Suppress the stale private copy so removal cannot make it
      // reappear. Older hosts supply an empty shared catalog and retain their
      // private v1/v2 behavior unchanged.
      if (findTagById(sharedCatalog, tag.id) || seenIds.indexOf(tag.id) !== -1) return;
      seenIds.push(tag.id);
      merged.push(tag);
    });
    return merged;
  }

  function isConflictError(err) {
    return !!err && err.name === "PluginStorageConflictError";
  }

  /**
   * True when a shared `tag-create`/`tag-update` was refused because the
   * workspace already holds that name -- the backend rejecting a duplicate the
   * local check could not predict (see findTagByName).
   *
   * The plugin answers that refusal as a 409 whose body is `{"error":"a tag
   * named \"X\" already exists"}` (actionError in server/actions.go), because a
   * Go error would reach the browser only as the host's generic 503 "plugin
   * action unavailable" and the wording would be lost. Matching the text rather
   * than the 409 alone is deliberate: a conflict status says something clashed,
   * not what, and every other conflict this plugin can produce (a storage
   * version clash, say) must keep its own handling. `ApiError.message` is the
   * response body's `error` field; the body is read too so a client that wraps
   * it differently still lands here.
   */
  function isDuplicateNameError(err) {
    if (!err) return false;
    var body = err.body;
    var detail = body && typeof body === "object" && typeof body.error === "string" ? body.error : "";
    var message = typeof err.message === "string" ? err.message : "";
    return /already exists/i.test(detail) || /already exists/i.test(message);
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

  /**
   * Drops catalog entries that don't look like `{ id, name, color }`. The id must
   * be a non-empty string, the same rule sanitizeTagIdList applies to the ids a
   * card stores: an entry with an empty id is a definition nothing can reference
   * (every write that would apply it refuses `""`), so keeping it would only offer
   * an unusable row in the picker and the manager.
   */
  function sanitizeCatalog(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (t) {
      return (
        t &&
        typeof t.id === "string" &&
        t.id.length > 0 &&
        typeof t.name === "string" &&
        typeof t.color === "string"
      );
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

  /**
   * A map keyed by a host-supplied opaque id (a workspace id, a task id) -- never
   * an ordinary object. An id of "__proto__" is legal input -- the backend
   * accepts an unvalidated task id, and the README documents that an invented one
   * is accepted -- and on an ordinary object `map["__proto__"] = store` would
   * write onto the realm's Object.prototype instead of storing an entry, so every
   * later `map[id]` read would find Object.prototype (truthy) and the store
   * writes would land on the prototype the whole page shares. Always create these
   * maps with this helper, including when resetting them.
   */
  function newIdMap() {
    return Object.create(null);
  }

  /**
   * The empty value a shared-tags store starts from. `tasks` is keyed by task id,
   * so it is built with newIdMap() like every other opaque-id map: a task id of
   * "__proto__" would otherwise make the read paths (`sharedTags.tasks[taskId]`)
   * hand back Object.prototype and `.map` a non-function. Host-minted ids are
   * uuids today, which is why this has never bitten -- the map contract is the
   * reason it cannot.
   */
  function emptySharedValue() {
    return { tags: [], tasks: newIdMap() };
  }

  var catalogStores = newIdMap(); // workspaceId -> store
  var taskTagStores = newIdMap(); // taskId -> store; keyed by task id, see newIdMap
  var taskTagWideUnsubscribe = null;
  // Workspace-shared catalog and task applications. New hosts expose this
  // through plugin actions; the existing host.storage data remains a
  // compatibility fallback for an older host or a user's pre-0.8 catalog.
  var sharedTagStores = newIdMap(); // workspaceId -> store; see newIdMap
  var sharedTagRefreshTimer = null;
  var sharedTagLoadErrorLogged = false;
  // "workspaceId|taskId" -> { shared, private, items }: quickTagItems'
  // derived card-menu list, keyed by the two store values it was derived
  // from. The host builds a card's menu entries on every render, menus open or
  // closed, so without this the scan plus sort behind each list would run for
  // every card on every board render. Dropped with the stores
  // (see resetSharedStores).
  var quickTagCaches = {};
  // Incremented whenever initialize()/destroy() drops the shared stores. A
  // request cannot be cancelled once invokeAction has started, so its later
  // settlement must prove it still belongs to the live store generation
  // before it can notify, mutate state, or schedule another retry.
  var sharedTagLifecycleGeneration = 0;

  function makeStore() {
    return {
      value: [],
      loaded: false,
      error: null,
      hasValue: false,
      listeners: [],
      inFlight: null,
      // Set when a fetch is requested while one is already in flight -- see
      // fetchStore, which re-issues on settle so a change notification
      // arriving mid-flight is never swallowed by the coalescing.
      dirty: false,
      unsubscribe: null,
      retryAttempt: 0,
      retryTimer: null,
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
  function clearPrivateReadRetry(store, resetAttempt) {
    if (store.retryTimer !== null) {
      clearTimeout(store.retryTimer);
      store.retryTimer = null;
    }
    if (resetAttempt) store.retryAttempt = 0;
  }

  function fetchStore(store, issueGet, sanitize, label, refetch, isCurrent, resetRetry) {
    if (resetRetry) clearPrivateReadRetry(store, true);
    if (store.inFlight) {
      store.dirty = true;
      return store.inFlight;
    }
    store.dirty = false;

    function settle(apply, retryable) {
      if (!isCurrent()) return;
      store.inFlight = null;
      apply();
      store.loaded = true;
      notifyStoreListeners(store);
      if (store.dirty) {
        clearPrivateReadRetry(store, false);
        refetch(false);
      } else if (retryable && store.retryTimer === null && store.retryAttempt < PRIVATE_READ_RETRY_DELAYS.length) {
        var delay = PRIVATE_READ_RETRY_DELAYS[store.retryAttempt];
        store.retryAttempt += 1;
        store.retryTimer = setTimeout(function () {
          if (!isCurrent()) return;
          store.retryTimer = null;
          refetch(false);
        }, delay);
      }
    }

    store.inFlight = issueGet().then(
      function (entry) {
        settle(function () {
          store.value = sanitize(entry ? entry.value : undefined);
          store.error = null;
          store.hasValue = true;
          clearPrivateReadRetry(store, true);
        }, false);
      },
      function (err) {
        var retryable = retryableStorageRead(err);
        logError("load " + label, err);
        settle(function () {
          store.error = err;
          if (!retryable) clearPrivateReadRetry(store, true);
        }, retryable);
      },
    );
    return store.inFlight;
  }

  function fetchCatalog(host, workspaceId, resetRetry) {
    var store = getCatalogStore(workspaceId);
    return fetchStore(
      store,
      function () {
        return host.storage.get(CATALOG_SCOPE, workspaceId, CATALOG_KEY);
      },
      sanitizeCatalog,
      CATALOG_SCOPE + "/" + CATALOG_KEY,
      function (reset) { fetchCatalog(host, workspaceId, reset); },
      function () { return catalogStores[workspaceId] === store; },
      resetRetry === true,
    );
  }

  function getTaskTagStore(taskId) {
    var store = taskTagStores[taskId];
    if (!store) {
      store = taskTagStores[taskId] = makeStore();
    }
    return store;
  }

  function getSharedTagStore(workspaceId) {
    var store = sharedTagStores[workspaceId];
    if (!store) {
      store = sharedTagStores[workspaceId] = makeStore();
      store.value = emptySharedValue();
      store.unavailable = false;
      store.retryAttempt = 0;
      store.retryTimer = null;
    }
    return store;
  }

  /**
   * Normalizes one `shared-tags` payload. The task map gets the same treatment as
   * the catalog, down to the elements: a task's entry must be an array of objects
   * carrying a non-empty string `id`, because five call sites iterate it and then read
   * `tag.id` (the chips, the picker, the board filter, the task-list facet and the
   * delete count -- the cascade reads storage, not this payload), and a malformed
   * value turns the intended degrade into a throw -- including inside a
   * store-notify re-render, which no `.catch` can reach, and inside the delete
   * confirmation's effect, which is the one place that cannot catch its way out.
   * The id requirement is what keeps those five agreeing: without it a payload
   * entry of `{"name":"no-id"}` would render a phantom chip with an undefined id
   * while the facet projections drop the same task, so one card would look tagged
   * to the chips and untagged to the facet. Dropping the bad parts leaves the task
   * looking untagged, which is what a host that cannot answer should look like.
   */
  function sanitizeSharedTags(raw) {
    if (!raw || !Array.isArray(raw.tags) || !raw.tasks || typeof raw.tasks !== "object") return { tags: [], tasks: newIdMap() };
    var tasks = newIdMap();
    Object.keys(raw.tasks).forEach(function (taskId) {
      if (!Array.isArray(raw.tasks[taskId])) return;
      var entries = raw.tasks[taskId].filter(function (entry) {
        return (
          !!entry &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          entry.id.length > 0 // the rule the readers apply, so all five agree
        );
      });
      if (entries.length > 0) tasks[taskId] = entries;
    });
    return { tags: sanitizeCatalog(raw.tags), tasks: tasks };
  }

  function sharedTagsAvailable(host) {
    return !!(host.api && typeof host.api.invokeAction === "function");
  }

  function sharedTagsEnabled(host, workspaceId) {
    return sharedTagsAvailable(host) && !!workspaceId && !getSharedTagStore(workspaceId).unavailable;
  }

  /** Returns the structured ApiError HTTP status, or null for network/unknown errors. */
  function actionErrorStatus(err) {
    if (!err || (typeof err !== "object" && typeof err !== "function")) return null;
    var status = Number(err.status);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  }

  // A structured 404 with this exact host error is the contract for an action
  // that the installed plugin did not declare. Other action-route 404s (for
  // example, "workspace not found") must leave shared state authoritative.
  function sharedActionUnsupported(err) {
    if (actionErrorStatus(err) !== 404) return false;
    var body = err && err.body;
    return !!body && typeof body === "object" && body.error === "plugin action not found";
  }

  function sharedActionRetryable(err) {
    var status = actionErrorStatus(err);
    return status === null || status === 502 || status === 503 || status === 504;
  }

  function clearSharedTagRetry(store, resetAttempt) {
    if (store.retryTimer !== null) {
      clearTimeout(store.retryTimer);
      store.retryTimer = null;
    }
    if (resetAttempt) store.retryAttempt = 0;
  }

  function cancelSharedTagRetry(workspaceId) {
    if (!workspaceId) return;
    var store = sharedTagStores[workspaceId];
    if (store) clearSharedTagRetry(store, true);
  }

  function scheduleSharedTagRetry(host, workspaceId, store, lifecycleGeneration) {
    if (sharedTagLifecycleGeneration !== lifecycleGeneration || sharedTagStores[workspaceId] !== store) return;
    if (store.unavailable || store.retryTimer !== null || store.retryAttempt >= SHARED_ACTION_RETRY_DELAYS.length) return;
    var delay = SHARED_ACTION_RETRY_DELAYS[store.retryAttempt];
    store.retryAttempt += 1;
    store.retryTimer = setTimeout(function () {
      if (sharedTagLifecycleGeneration !== lifecycleGeneration || sharedTagStores[workspaceId] !== store) return;
      store.retryTimer = null;
      fetchSharedTags(host, workspaceId);
    }, delay);
  }

  /**
   * Replaces a shared store's payload and releases every memoized quick list
   * built from the one it had. The memo's own identity check is only an
   * invalidation trigger -- this is what stops the old payload (every task's
   * applications, its tag objects, the run closures) from staying reachable
   * through a card whose menu is never built again.
   */
  function setSharedValue(store, value) {
    store.value = value;
    pruneQuickTagCaches(store);
  }

  /**
   * Drops every memoized quick list built from a payload the shared store has
   * since replaced. Without this, an entry for a card whose menu is not built
   * again would keep that whole-workspace payload reachable for the life of
   * the page -- one refresh every 30 seconds is enough for the cache to pin a
   * generation that nothing else references. Entries this store's current
   * payload still backs stay (another workspace's refresh drops them early,
   * which costs one recompute and is the safe direction).
   */
  function pruneQuickTagCaches(store) {
    Object.keys(quickTagCaches).forEach(function (key) {
      if (quickTagCaches[key].shared !== store.value) delete quickTagCaches[key];
    });
  }

  function fetchSharedTags(host, workspaceId) {
    var store = getSharedTagStore(workspaceId);
    var lifecycleGeneration = sharedTagLifecycleGeneration;
    if (!host.api || typeof host.api.invokeAction !== "function") {
      clearSharedTagRetry(store, true);
      store.unavailable = true;
      setSharedValue(store, emptySharedValue());
      store.loaded = true;
      store.error = null;
      store.hasValue = false;
      notifyStoreListeners(store);
      return Promise.resolve();
    }
    if (store.inFlight) {
      store.dirty = true;
      return store.inFlight;
    }
    store.dirty = false;

    function settle(apply, retryable) {
      // destroy() and a re-entrant initialize() both discard the shared
      // stores. Do not let an action started before that boundary revive an
      // obsolete retry timer after it finally resolves or rejects.
      if (sharedTagLifecycleGeneration !== lifecycleGeneration || sharedTagStores[workspaceId] !== store) return;
      store.inFlight = null;
      apply();
      store.loaded = true;
      notifyStoreListeners(store);
      if (store.dirty) {
        fetchSharedTags(host, workspaceId);
      } else if (retryable) {
        scheduleSharedTagRetry(host, workspaceId, store, lifecycleGeneration);
      }
    }

    store.inFlight = host.api.invokeAction("shared-tags", { workspaceId: workspaceId }).then(
      function (payload) {
        settle(function () {
          clearSharedTagRetry(store, true);
          store.unavailable = false;
          setSharedValue(store, sanitizeSharedTags(payload));
          store.error = null;
          store.hasValue = true;
          sharedTagLoadErrorLogged = false;
        }, false);
      },
      function (err) {
        var unsupported = sharedActionUnsupported(err);
        var retryable = !unsupported && sharedActionRetryable(err);
        settle(function () {
          if (unsupported) {
            clearSharedTagRetry(store, true);
            store.unavailable = true;
            setSharedValue(store, emptySharedValue());
            store.error = null;
            store.hasValue = false;
          } else {
            // A definitive failure -- neither "this host has no such action" nor
            // a retryable transport error -- must also drop any timer an earlier
            // outage armed: leaving it running fires the action the host just
            // rejected for good, and the spent retry budget would then be missing
            // for the next genuine outage.
            if (!retryable) clearSharedTagRetry(store, true);
            // Preserve the last confirmed shared value. In particular, never
            // make a transient update race authorize writes to legacy private
            // storage merely because the replacement process is not ready.
            store.unavailable = false;
            store.error = err;
          }
          if (!sharedTagLoadErrorLogged) {
            sharedTagLoadErrorLogged = true;
            logError("load shared tags", err);
          }
        }, retryable);
      },
    );
    return store.inFlight;
  }

  function retryableStorageRead(err) {
    if (!err) return false;
    if (err.name === "TypeError") return true;
    return /^plugin storage: get failed with status (429|502|503|504)$/.test(String(err.message || ""));
  }

  function refreshFailedPrivateTags(host) {
    Object.keys(catalogStores).forEach(function (workspaceId) {
      var store = catalogStores[workspaceId];
      if (store.listeners.length && store.error && retryableStorageRead(store.error) && !store.inFlight) {
        fetchCatalog(host, workspaceId, true);
      }
    });
    Object.keys(taskTagStores).forEach(function (taskId) {
      var store = taskTagStores[taskId];
      if (store.listeners.length && store.error && retryableStorageRead(store.error) && !store.inFlight) {
        fetchTaskTags(host, taskId, true);
      }
    });
  }

  function ensureSharedTagRefresh(host) {
    if (sharedTagRefreshTimer) return;
    if (!window || typeof window.setInterval !== "function" || typeof window.addEventListener !== "function") return;
    sharedTagRefreshTimer = window.setInterval(function () {
      Object.keys(sharedTagStores).forEach(function (workspaceId) { fetchSharedTags(host, workspaceId); });
    }, 30000);
    function onFocus() {
      Object.keys(sharedTagStores).forEach(function (workspaceId) { fetchSharedTags(host, workspaceId); });
      refreshFailedPrivateTags(host);
    }
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    addDisposable(function () { if (typeof window.clearInterval === "function") window.clearInterval(sharedTagRefreshTimer); sharedTagRefreshTimer = null; window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus); });
  }

  function useSharedTags(host, workspaceId) {
    return useSharedStore(host, workspaceId || null, getSharedTagStore, function (currentHost) { ensureSharedTagRefresh(currentHost); }, fetchSharedTags);
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

  function fetchTaskTags(host, taskId, resetRetry) {
    var store = getTaskTagStore(taskId);
    return fetchStore(
      store,
      function () {
        return host.storage.get(TASK_SCOPE, taskId, TASK_KEY);
      },
      sanitizeTagIdList,
      TASK_SCOPE + "/" + TASK_KEY,
      function (reset) { fetchTaskTags(host, taskId, reset); },
      function () { return taskTagStores[taskId] === store; },
      resetRetry === true,
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
  function useSharedStore(host, scopeId, getStore, ensureSubscription, fetchFn, retryFailedRead) {
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
        var firstListener = store.listeners.length === 0;
        store.listeners.push(onChange);
        if ((!store.loaded || (retryFailedRead && firstListener && retryableStorageRead(store.error))) && !store.inFlight) {
          fetchFn(host, scopeId, retryFailedRead && firstListener && !!store.error);
        }
        return function () {
          var idx = store.listeners.indexOf(onChange);
          if (idx !== -1) store.listeners.splice(idx, 1);
        };
      },
      [scopeId],
    );

    if (!scopeId) return [[], true, function () {}, null, true];
    var store = getStore(scopeId);
    return [
      store.value,
      store.loaded,
      function refresh() {
        fetchFn(host, scopeId, true);
      },
      store.error,
      store.hasValue,
    ];
  }

  function useTaskTagIds(host, taskId, writerId) {
    // writerId is accepted for call-site compatibility (and still used for
    // the *write* path -- see readModifyWriteTaskTags) but no longer
    // filters the shared store's subscribe: there is only one wide
    // subscribe for the whole store (see ensureTaskTagWideSubscription),
    // shared by every writer.
    return useSharedStore(host, taskId || null, getTaskTagStore, ensureTaskTagWideSubscription, fetchTaskTags, true);
  }

  function useCatalog(host, workspaceId, writerId) {
    return useSharedStore(host, workspaceId || null, getCatalogStore, ensureCatalogSubscription, fetchCatalog, true);
  }

  /**
   * The private compatibility task-tag cache used by legacy chips and
   * storage-backed filter hosts. Shared-action filter assignments live in
   * registerTagFilter's separate workspace-scoped index.
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
    Object.keys(taskTagStores).forEach(function (taskId) {
      clearPrivateReadRetry(taskTagStores[taskId], true);
    });
    taskTagStores = newIdMap();
    // Every memoized quick list is derived from one of those task stores (and
    // the shared payload it was built with), so dropping the stores drops them.
    quickTagCaches = {};
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
    sharedTagLifecycleGeneration += 1;
    Object.keys(catalogStores).forEach(function (workspaceId) {
      clearPrivateReadRetry(catalogStores[workspaceId], true);
    });
    catalogStores = newIdMap();
    clearTaskTagCache();
    taskTagWideUnsubscribe = null;
    Object.keys(sharedTagStores).forEach(function (workspaceId) {
      clearSharedTagRetry(sharedTagStores[workspaceId], true);
    });
    sharedTagStores = newIdMap();
    sharedTagRefreshTimer = null;
    sharedTagLoadErrorLogged = false;
    quickTagCaches = {};
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
      var displayNote = typeof tag.note === "string" ? tag.note.trim() : "";
      var agentLabel = tag.agent ? tag.name + (displayNote ? " — " + displayNote : "") : undefined;
      var spanArgs = [
        "span",
        {
          key: tag.id,
          "data-testid": "kandev-tags-chip",
          className: "kandev-tags-chip",
          style: tag.agent ? Object.assign({}, dense ? denseChipStyle(tag.color) : chipStyle(tag.color), { border: "1px dashed currentColor" }) : (dense ? denseChipStyle(tag.color) : chipStyle(tag.color)),
          "data-agent": tag.agent ? "true" : undefined,
          title: agentLabel,
          "aria-label": agentLabel,
        },
      ];
      if (tag.agent) spanArgs.push(botIconElement(host));
      spanArgs.push(tag.name);
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
                handleRemove(tag);
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
      var refreshTagIds = tagIdsAndLoaded[2];
      var tagIdsLoadError = tagIdsAndLoaded[3];
      var tagIdsHaveValue = tagIdsAndLoaded[4];
      var catalogAndLoaded = useCatalog(host, resolvedWorkspaceId, CHIPS_WRITER_ID);
      var catalog = catalogAndLoaded[0];
      var catalogLoaded = catalogAndLoaded[1];
      var refreshCatalog = catalogAndLoaded[2];
      var catalogLoadError = catalogAndLoaded[3];
      var catalogHaveValue = catalogAndLoaded[4];
      var sharedTagsAndLoaded = useSharedTags(host, resolvedWorkspaceId);
      var sharedTags = sharedTagsAndLoaded[0];
      var sharedTagsLoaded = sharedTagsAndLoaded[1];
      var refreshSharedTags = sharedTagsAndLoaded[2];
      var sharedTagsLoadError = sharedTagsAndLoaded[3];
      var sharedTagsHaveValue = sharedTagsAndLoaded[4];

      if (!resolvedWorkspaceId || !tagIdsLoaded || !catalogLoaded || !sharedTagsLoaded) return null;
      // A failed cold private read is unknown data, not a confirmed untagged
      // task. Keep confirmed cached values on the normal chip path, but give
      // card/sidebar/list surfaces an error and a direct recovery action when
      // the private catalog or task assignment has never loaded.
      var privateLoadError =
        (tagIdsLoadError && !tagIdsHaveValue) ||
        (catalogLoadError && !catalogHaveValue);
      // A cold shared-action failure is also unknown data. Show the same
      // warning while preserving any private or shared value already loaded.
      var sharedLoadError = sharedTagsLoadError && !sharedTagsHaveValue;
      var chipLoadError = privateLoadError || sharedLoadError;

      function handleRemove(tag) {
        if (tag.shared) {
          host.api.invokeAction("task-tag-remove", { taskId: taskId, body: { tagId: tag.id } }).then(refreshSharedTags).catch(function (err) { logError("remove shared tag from card", err); });
          return;
        }
        readModifyWriteTaskTags(host, taskId, CHIPS_WRITER_ID, function (current) {
          return removeTaskTagId(current, tag.id);
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
      var sharedTaskTags = (sharedTags.tasks[taskId] || []).map(function (tag) {
        return { id: tag.id, name: tag.name, color: tag.color, note: tag.note, agent: tag.agent === true, agentApplied: tag.agentApplied === true, shared: true };
      });
      // Legacy private tags stay visible after upgrading. A shared application
      // supersedes a private compatibility entry with the same stable id, so
      // migrated overlap cannot render a second chip or raw generated id.
      resolvedTags = mergeTagRepresentations(sharedTaskTags, resolvedTags, sharedTags.tags);
      if (resolvedTags.length === 0 && !chipLoadError) return null;

      var visibleTags = dense ? resolvedTags.slice(0, TASK_ROW_CHIP_LIMIT) : resolvedTags;
      var hiddenCount = resolvedTags.length - visibleTags.length;
      var chipEls = visibleTags.map(function (tag) {
        return chipEl(tag, handleRemove);
      });
      if (chipLoadError) {
        // Either source can fail while the other has confirmed task tags.
        // Keep those chips and show the unknown layer beside them.
        chipEls.push(jsx(
          "span",
          { key: "private-load-error", "data-testid": "kandev-tags-chip-load-error", role: "alert", className: "text-destructive text-xs" },
          withDetail("Could not load tags. Please try again.", chipLoadError),
          jsx(
            "button",
            {
              type: "button",
              "data-testid": "kandev-tags-chip-retry",
              className: "underline",
              style: { marginLeft: "4px" },
              onClick: function (e) {
                if (e && e.stopPropagation) e.stopPropagation();
                if (tagIdsLoadError && !tagIdsHaveValue) refreshTagIds();
                if (catalogLoadError && !catalogHaveValue) refreshCatalog();
                if (sharedLoadError) refreshSharedTags();
              },
              onPointerDown: function (e) {
                if (e && e.stopPropagation) e.stopPropagation();
              },
            },
            "Retry",
          ),
        ));
      }

      if (!dense) {
        // Unchanged output shape from before this generalization: exactly
        // one children arg (the mapped chip array), uncapped.
        return jsx("div", { "data-testid": "kandev-tags-chip-row", style: CHIP_ROW_STYLE }, chipEls);
      }

      var moreEl =
        hiddenCount > 0
          ? jsx("span", { key: "more", "data-testid": "kandev-tags-chip-more", style: CHIP_MORE_STYLE }, "+" + hiddenCount)
          : null;
      // Dense rows normally stay on one line. During a partial read failure,
      // let the warning wrap so it cannot be clipped after the shared chips.
      var rowStyle = chipLoadError
        ? Object.assign({}, DENSE_CHIP_ROW_STYLE, { flexWrap: "wrap", overflow: "visible" })
        : DENSE_CHIP_ROW_STYLE;
      return jsx("div", { "data-testid": "kandev-tags-chip-row", style: rowStyle }, chipEls, moreEl);
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
      var sharedTagsAndLoaded = useSharedTags(host, resolvedWorkspaceId);
      var sharedTags = sharedTagsAndLoaded[0];
      var sharedTagsLoaded = sharedTagsAndLoaded[1];
      var refreshSharedTags = sharedTagsAndLoaded[2];
      var sharedTagsLoadError = sharedTagsAndLoaded[3];
      var useShared = sharedTagsEnabled(host, resolvedWorkspaceId);
      if (useShared) {
        catalog = sharedTags.tags;
        catalogLoaded = sharedTagsLoaded;
        tagIds = (sharedTags.tasks[taskId] || []).map(function (tag) { return tag.id; });
        tagIdsLoaded = sharedTagsLoaded;
      }
      var draftState = React.useState("");
      var draft = draftState[0];
      var setDraft = draftState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var loadError = useShared ? sharedTagsLoadError : catalogLoadError || tagIdsLoadError;
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
        if (useShared) {
          host.api.invokeAction(applying ? "task-tag-add" : "task-tag-remove", { taskId: taskId, body: { tagId: id } }).then(refreshSharedTags).catch(function (err) {
            logError("toggle shared tag", err);
            setError(withDetail("Could not update tag. Please try again.", err));
          });
          return;
        }
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
        if (useShared) {
          host.api.invokeAction("tag-create", { workspaceId: resolvedWorkspaceId, body: { name: draft } }).then(function (payload) {
            var created = payload.tags.filter(function (tag) { return tag.name.toLowerCase() === name.toLowerCase(); })[0];
            if (!created) throw new Error("tag not found after create");
            setDraft("");
            return host.api.invokeAction("task-tag-add", { taskId: taskId, body: { tagId: created.id } });
          }).then(refreshSharedTags).catch(function (err) {
            logError("create shared tag", err);
            setError(
              isDuplicateNameError(err)
                ? 'A tag named "' + name + '" already exists.'
                : withDetail("Could not create tag. Please try again.", err),
            );
          });
          return;
        }
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
        displayError ? jsx("div", { "data-testid": "kandev-tags-picker-error" }, displayError,
          loadError ? jsx(ui.Button, { type: "button", size: "sm", "data-testid": "kandev-tags-picker-retry", onClick: function () {
            if (useShared) refreshSharedTags();
            else { refreshCatalog(); refreshTagIds(); }
          } }, "Retry") : null) : null,
      );
    };
  }

  // ---------------------------------------------------------------------
  // Card-menu quick pick (the "Add tag..." submenu's children)
  // ---------------------------------------------------------------------

  /** Opens the full picker modal: the menu's flat behavior on a host that
   * predates submenus, and its "More tags..." child on one that renders them. */
  function openTagPicker(host, taskId, workspaceId) {
    return host.openModal({
      title: "Tags",
      size: "md",
      content: makeTagPickerModal(host, taskId, workspaceId),
    });
  }

  /**
   * Applies one tag from the menu's quick list, mirroring the picker's apply
   * branch: the shared action is the only write path, since the quick list
   * exists only where the shared store does. Refreshes that store, which is
   * what every chip row reads. A failure toasts as well as logs -- a menu
   * click has no inline error surface the way the picker modal does.
   */
  function applyQuickTag(host, workspaceId, taskId, tagId) {
    return host.api
      .invokeAction("task-tag-add", { taskId: taskId, body: { tagId: tagId } })
      .then(function () {
        return fetchSharedTags(host, workspaceId);
      })
      .catch(function (err) {
        logError("add tag from card menu", err);
        if (host.toast && typeof host.toast.error === "function") {
          host.toast.error("Could not add tag. Please try again.");
        }
      });
  }

  /**
   * The last time a tag was applied anywhere in the workspace, in
   * milliseconds, from one application's `updatedAt`.
   *
   * The writer is Go's `time.RFC3339Nano`, which trims trailing zeros and may
   * carry more than three fractional digits, so the raw strings are not
   * comparable: as strings `...T00:00:00Z` sorts *after* `...T00:00:00.5Z`,
   * which is backwards. Truncating the fraction to milliseconds makes every
   * value a spec-shaped date string for `Date.parse` (engines are only
   * required to accept three fractional digits) that is still far finer than
   * the ordering a five-entry list needs; equal milliseconds fall back to
   * catalog order. Null for a missing or unparseable value, which the caller
   * treats as "never used".
   */
  function lastUsedMillis(at) {
    if (typeof at !== "string" || at === "") return null;
    var parsed = Date.parse(at.replace(/\.(\d{3})\d+/, ".$1"));
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * The quick list's entries are created by these factories rather than inline.
   * A closure created directly inside quickTagItems would share that call's
   * variable context -- which holds the workspace-wide application map it just
   * scanned -- and the host keeps these callbacks alive inside the menu entries
   * it holds, so the payload the memo released would stay reachable through
   * them. Each factory closes over its own arguments only, and the head entry
   * is only built when there is a list to head (see quickTagItems).
   */
  function quickTagRun(host, workspaceId, taskId, tagId) {
    return function () {
      return applyQuickTag(host, workspaceId, taskId, tagId);
    };
  }

  function quickTagColorIcon(host, tag) {
    // Shared catalog values cross the plugin boundary; accept only the
    // supported hex forms before using them as inline CSS.
    var color = normalizeColor(tag.color) || colorFromName(tag.name);
    return host.jsx("span", {
      "data-testid": "kandev-tags-quick-pick-color",
      "aria-hidden": "true",
      style: {
        display: "inline-block",
        width: "8px",
        height: "8px",
        flexShrink: 0,
        marginRight: "8px",
        borderRadius: "50%",
        backgroundColor: color,
      },
    });
  }

  function moreTagsEntry(host, workspaceId, taskId) {
    return {
      id: "more",
      label: "More tags\u2026",
      run: function () {
        return openTagPicker(host, taskId, workspaceId);
      },
    };
  }

  /**
   * The children of the card menu's "Add tag..." entry on a host that renders
   * plugin submenus: "More tags..." first (the picker modal), then the tags
   * this workspace applied most recently, newest first, capped at
   * QUICK_TAG_LIMIT.
   *
   * Everything here is derived from state the chip rows already keep warm:
   * the shared store holds every task's applications with the timestamp of
   * each last add by an agent or a person, so "latest used" is a scan of data
   * already in memory. A tag nothing has ever been applied with has no place
   * in a most-recently-used list and is left to the picker.
   *
   * This runs on the host's menu-build path -- once per card per board render
   * with this feature's host half (twice before its perf commit, which shares
   * one evaluation between a card's dropdown and context variants), menus open
   * or closed -- so it must stay synchronous and read-only (the host's own
   * `items` contract), and its result is cached
   * until one of the two stores it reads replaces its value (see
   * quickTagCaches), empty results included. A store that has not loaded yet
   * therefore yields an empty list -- the host's signal for "no usable
   * children", which renders the action's flat item -- and this path never
   * fetches.
   *
   * Only tags the card does not already carry are offered, so every child
   * adds exactly the tag it names: removal stays where it has always been, on
   * the card's own chips and in the picker.
   */
  function quickTagItems(host, context) {
    var workspaceId = resolveWorkspaceId(host, context.workspaceId);
    if (!workspaceId || !sharedTagsEnabled(host, workspaceId)) return [];

    var store = getSharedTagStore(workspaceId);
    var taskStore = getTaskTagStore(context.taskId);
    var cacheKey = workspaceId + "|" + context.taskId;
    var cached = quickTagCaches[cacheKey];
    // Both stores replace their value wholesale on every fetch, so identity
    // is a sound invalidation key for everything derived below.
    if (cached && cached.shared === store.value && cached.private === taskStore.value) {
      return cached.items;
    }

    var tasks = store.value.tasks || {};
    var applied = {};
    (tasks[context.taskId] || []).forEach(function (entry) {
      if (entry && typeof entry.id === "string") applied[entry.id] = true;
    });
    (taskStore.value || []).forEach(function (id) {
      applied[id] = true;
    });

    var lastUsedAt = {};
    Object.keys(tasks).forEach(function (taskId) {
      (tasks[taskId] || []).forEach(function (entry) {
        if (!entry || typeof entry.id !== "string") return;
        var at = lastUsedMillis(entry.updatedAt);
        if (at === null) return;
        if (lastUsedAt[entry.id] === undefined || at > lastUsedAt[entry.id]) lastUsedAt[entry.id] = at;
      });
    });

    // A catalog payload carrying the same id twice would otherwise produce
    // two children with one host React key -- the server's own ids are 80
    // random bits, so this is defence in depth, not a reachable state.
    var seen = {};
    var quick = (store.value.tags || [])
      .filter(function (tag) {
        if (applied[tag.id] || lastUsedAt[tag.id] === undefined || seen[tag.id]) return false;
        seen[tag.id] = true;
        return true;
      })
      .map(function (tag, order) {
        return { tag: tag, at: lastUsedAt[tag.id], order: order };
      })
      .sort(function (a, b) {
        return a.at === b.at ? a.order - b.order : b.at - a.at;
      })
      .slice(0, QUICK_TAG_LIMIT)
      .map(function (candidate, index) {
        var tagId = candidate.tag.id;
        return {
          id: tagId,
          label: candidate.tag.name,
          icon: quickTagColorIcon(host, candidate.tag),
          separatorBefore: index === 0,
          run: quickTagRun(host, workspaceId, context.taskId, tagId),
        };
      });

    // Nothing recent to offer -- a fresh workspace has no applications at all,
    // and a card can already carry every tag anyone applied. An empty list is
    // the host's "no usable children" signal, so the action stops being a
    // submenu and renders its flat item (label, and `run` opening this same
    // picker): one click, and the command palette keeps its entry. Returning a
    // lone "More tags..." child would nest that picker one level deeper for
    // nothing.
    // An empty list is cached like any other: "nothing to offer" is a stable
    // state on this hot path, not a transient one. The head entry is built only
    // on the branch that needs it, so a cache hit builds no entry at all -- the
    // composite cache key above is still built, on every call.
    var items =
      quick.length === 0
        ? []
        : [moreTagsEntry(host, workspaceId, context.taskId)].concat(quick);
    quickTagCaches[cacheKey] = { shared: store.value, private: taskStore.value, items: items };
    return items;
  }

  /**
   * The add-tag menu item's icon -- @tabler/icons-react's IconTag geometry,
   * inlined (host.ui exposes no icon set) at the same `mr-2 h-4 w-4`,
   * stroke="currentColor" sizing every neighbouring item in the same menu
   * uses (`Move to`/`Archive`/`Delete`), so it lines up pixel-for-pixel. It
   * is a ready-made element rather than a curated icon name or a component:
   * the host's menu entry passes an element through untouched -- and is the
   * only icon shape a host predating that resolution renders at all -- so
   * the plugin owns the className in every case.
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

  // Same Tabler IconRobot mark and yellow emphasis as the host's autopilot
  // indicator. It is inlined because the plugin UI contract has no icon
  // registry, while keeping the familiar bot glyph makes agent provenance
  // visible without relying on a chip colour or a tooltip.
  function botIconElement(host) {
    return host.jsx(
      "svg",
      {
        "data-testid": "kandev-tags-agent-icon",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        style: { width: "12px", height: "12px", marginRight: "3px", verticalAlign: "-2px", color: "#eab308", flexShrink: 0 },
      },
      host.jsx("path", { d: "M7 4v-2" }),
      host.jsx("path", { d: "M17 4v-2" }),
      host.jsx("rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }),
      host.jsx("path", { d: "M8 9h.01" }),
      host.jsx("path", { d: "M16 9h.01" }),
      host.jsx("path", { d: "M8 13h8" }),
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
    return host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: TAG_SCAN_LIMIT }).then(
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
    return host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: TAG_SCAN_LIMIT }).then(function (result) {
      // A page the host had to cap is not a count: reporting its length would
      // promise a delete "from N cards" while more sit past the page, so the
      // caller is told the truth -- the number is unknown.
      if (result.truncated) return null;
      return result.entries.filter(function (entry) {
        return sanitizeTagIdList(entry.value).indexOf(tagId) !== -1;
      }).length;
    });
  }

  /**
   * Counts the tasks the loaded shared catalog records as carrying `tagId`.
   *
   * The shared counterpart of countTasksWithTag, and deliberately synchronous:
   * the payload is already in hand (the catalog and its applications arrive in
   * one `shared-tags` response), so the delete confirmation needs no second
   * round trip to say how many cards it is about to touch. The count is exact
   * for what the backend records -- a task past its own cap is not represented
   * there and not presented as a card either.
   */
  function countSharedTasksWithTag(sharedTags, tagId) {
    var tasks = (sharedTags && sharedTags.tasks) || {};
    return Object.keys(tasks).filter(function (taskId) {
      return (tasks[taskId] || []).some(function (tag) {
        return !!tag && tag.id === tagId;
      });
    }).length;
  }

  /**
   * Strips `tagId` from every task that carries it (D7: deleting a tag must
   * not orphan raw-id chips on cards). Each task is updated independently so
   * one failure doesn't block the rest; returns how many succeeded/failed.
   */
  function cascadeRemoveTagFromTasks(host, tagId) {
    if (typeof host.storage.listByKey !== "function") {
      return Promise.resolve({ succeeded: 0, failed: 0, truncated: false });
    }
    return host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: TAG_SCAN_LIMIT }).then(function (result) {
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
      }, Promise.resolve({ succeeded: 0, failed: 0, truncated: result.truncated === true }));
    });
  }

  // ---------------------------------------------------------------------
  // Delete-tag confirmation (nested modal, opened from the top-bar dropdown)
  // ---------------------------------------------------------------------

  /**
   * The delete confirmation, shared by both host tiers. It is parameterized
   * (`countTasks` and `remove`) rather than hard-wired to the private storage
   * layer, because the *confirmation* is what the Tags box promises on every
   * host: an action-capable host's cascade runs atomically on the backend, but
   * that is a reason for the delete to need fewer round trips, not for a
   * destructive, irreversible action to lose its "Remove "x" from N cards?"
   * step.
   *
   * `countTasks` resolves to a number, or null when the number cannot be known
   * (no scan available, or a scan the host had to cap). `remove` performs the
   * removal and resolves to `{ succeeded, failed, truncated }` -- `truncated`
   * meaning the removal could not see every card, which is reported instead of
   * being passed off as a complete cascade. It may also reject, which surfaces
   * as a retryable error.
   */
  function makeDeleteTagConfirm(options) {
    var host = options.host;
    var tag = options.tag;
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
        options
          .countTasks()
          .then(function (result) {
            setCount(result === null ? "unknown" : result);
          })
          .catch(function (err) {
            // A failed count must not strand the confirmation: Delete stays
            // disabled while the count is still loading, and this modal has no
            // cancel of its own, so a rejection without this arm would leave the
            // person stuck on "Checking how many cards use ..." with no way
            // forward. Unknown is the honest answer, and it is the same wording a
            // host without a scan already produces.
            logError("count cards for tag", err);
            setCount("unknown");
          });
      }, []);

      function handleConfirm() {
        setBusy(true);
        options
          .remove()
          .then(function (result) {
            var remained = result.failed > 0;
            // Built once and reported once: a cascade can both fail some cards and
            // have been unable to see the rest (the scan stopped at
            // TAG_SCAN_LIMIT entries), and two setError calls in one tick would
            // leave the second -- the only one a person ever sees -- as a copy of
            // the first with a clause appended.
            var clauses = [];
            if (remained) {
              clauses.push(
                "Removed from " + result.succeeded + " card(s); " + result.failed + " card(s) failed to update.",
              );
            }
            if (result.truncated) {
              clauses.push(
                "This host's scan stops at " +
                  TAG_SCAN_LIMIT +
                  " entries, so cards beyond it may still reference the tag.",
              );
            }
            if (clauses.length > 0) {
              setError(clauses.join(" "));
              setBusy(false);
              return;
            }
            options.onDeleted();
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
      var sharedTagsAndLoaded = useSharedTags(host, resolvedWorkspaceId);
      var sharedTags = sharedTagsAndLoaded[0];
      var sharedTagsLoaded = sharedTagsAndLoaded[1];
      var refreshSharedTags = sharedTagsAndLoaded[2];
      var sharedTagsLoadError = sharedTagsAndLoaded[3];
      var useShared = sharedTagsEnabled(host, resolvedWorkspaceId);
      if (useShared) {
        catalog = sharedTags.tags;
        loaded = sharedTagsLoaded;
        loadError = sharedTagsLoadError;
      }

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

      // The catalog can change independently of this dropdown (for example,
      // when another user or tab deletes a shared tag). A controlled Select
      // cannot represent a value whose option has disappeared, so reconcile
      // the host filter once the active catalog source has finished loading.
      React.useEffect(function () {
        if (!capabilities.filterSelectionApi || !loaded || loadError || !selected || selected.length === 0) return;
        if (selected[0] === UNTAGGED_FILTER_VALUE || findTagById(catalog, selected[0])) return;
        host.taskFilters.setSelection(TAGS_FILTER_ID, []);
        setSelected([]);
      }, [catalog, loaded, selected]);

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
        if (useShared) {
          host.api.invokeAction("tag-create", { workspaceId: resolvedWorkspaceId, body: { name: draft } }).then(function () {
            setDraft("");
            refreshSharedTags();
          }).catch(function (err) {
            logError("create shared tag", err);
            setError(
              isDuplicateNameError(err)
                ? 'A tag named "' + draftName + '" already exists.'
                : withDetail("Could not create tag. Please try again.", err),
            );
          });
          return;
        }
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
        if (useShared) {
          host.api.invokeAction("tag-update", { workspaceId: resolvedWorkspaceId, body: { id: id, name: nextName } }).then(function () {
            setRenamingId(null);
            refreshSharedTags();
          }).catch(function (err) {
            logError("rename shared tag", err);
            setRenamingId(null);
            setError(
              isDuplicateNameError(err)
                ? 'A tag named "' + normalized + '" already exists.'
                : withDetail("Could not rename tag. Please try again.", err),
            );
          });
          return;
        }
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
        if (useShared) {
          host.api.invokeAction("tag-update", { workspaceId: resolvedWorkspaceId, body: { id: id, color: nextColor } }).then(refreshSharedTags).catch(function (err) {
            logError("recolor shared tag", err);
            setError(withDetail("Could not recolor tag. Please try again.", err));
          });
          return;
        }
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
        var modal;
        if (useShared) {
          modal = host.openModal({
            title: "Delete tag",
            size: "sm",
            content: makeDeleteTagConfirm({
              host: host,
              tag: tag,
              // Counted from the loaded shared payload, so the confirmation is
              // immediate; the backend still cascades atomically on confirm.
              countTasks: function () {
                return Promise.resolve(countSharedTasksWithTag(sharedTags, tag.id));
              },
              remove: function () {
                return host.api
                  .invokeAction("tag-delete", { workspaceId: resolvedWorkspaceId, body: { id: tag.id } })
                  .then(function () {
                    refreshSharedTags();
                    return { succeeded: 0, failed: 0, truncated: false };
                  });
              },
              onDeleted: function () {
                modal.close();
              },
            }),
          });
          return;
        }
        modal = host.openModal({
          title: "Delete tag",
          size: "sm",
          content: makeDeleteTagConfirm({
            host: host,
            tag: tag,
            countTasks: function () {
              return countTasksWithTag(host, tag.id);
            },
            remove: function () {
              return cascadeRemoveTagFromTasks(host, tag.id).then(function (result) {
                return readModifyWriteCatalog(host, resolvedWorkspaceId, MANAGER_WRITER_ID, function (current) {
                  return removeCatalogTag(current, tag.id);
                }).then(function () {
                  refreshCatalog();
                  return result;
                });
              });
            },
            onDeleted: function () {
              modal.close();
            },
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
            : loadError && catalog.length === 0
              ? null
              : catalog.length === 0
              ? jsx("div", { className: "text-muted-foreground text-xs px-2 py-1.5" }, "No tags yet.")
              : buildTagRows(),
          displayError ? jsx("div", { "data-testid": "kandev-tags-topbar-error" }, displayError,
            loadError ? jsx(ui.Button, { type: "button", size: "sm", "data-testid": "kandev-tags-topbar-retry", onClick: function () {
              if (useShared) refreshSharedTags();
              else refreshCatalog();
            } }, "Retry") : null) : null,
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
            : tagPillEl(tag),
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

      function tagPillEl(tag) {
        var args = [
          "span",
          {
            style: Object.assign(
              { minWidth: 0, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis" },
              chipStyle(tag.color),
            ),
            "data-testid": "kandev-tags-topbar-pill",
            onClick: function () { setRenamingId(tag.id); },
          },
        ];
        if (tag.owner === "agent") args.push(botIconElement(host));
        args.push(tag.name);
        return jsx.apply(null, args);
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
    var sharedTaskTagIds = null;
    var currentWorkspaceId = null;
    var unsubscribeStorage = null;
    var unsubscribeSharedTags = null;

    // Keep the board filter on the same authoritative shared store used by
    // chips, the manager, and the task-list facet. In particular, a
    // replacement-time 503 must not expose the private compatibility layer.
    function adoptSharedCatalog() {
      if (!currentWorkspaceId) return;
      var store = getSharedTagStore(currentWorkspaceId);
      if (store.unavailable) {
        sharedTaskTagIds = null;
        loadPrivateCatalog();
        return;
      }
      if (!store.hasValue) return;
      var payload = store.value || emptySharedValue();
      catalog = sanitizeCatalog(payload.tags);
      sharedTaskTagIds = {};
      Object.keys(payload.tasks || {}).forEach(function (taskId) {
        sharedTaskTagIds[taskId] = sanitizeTagIdList(
          (payload.tasks[taskId] || []).map(function (tag) { return tag && tag.id; }),
        );
      });
    }

    function refreshCatalog() {
      if (!currentWorkspaceId) {
        catalog = [];
        return;
      }
      if (sharedTagsAvailable(host)) {
        var store = getSharedTagStore(currentWorkspaceId);
        if (!store.loaded && !store.inFlight) fetchSharedTags(host, currentWorkspaceId);
        adoptSharedCatalog();
        return;
      }
      loadPrivateCatalog();
    }

    function loadPrivateCatalog() {
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

    function subscribeSharedTags(workspaceId) {
      ensureSharedTagRefresh(host);
      var store = getSharedTagStore(workspaceId);
      store.listeners.push(adoptSharedCatalog);
      if (!store.loaded && !store.inFlight) fetchSharedTags(host, workspaceId);
      return function () {
        var idx = store.listeners.indexOf(adoptSharedCatalog);
        if (idx !== -1) store.listeners.splice(idx, 1);
      };
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
      var previousWorkspaceId = currentWorkspaceId;
      currentWorkspaceId = workspaceId || null;
      sharedTaskTagIds = null;
      cancelSharedTagRetry(previousWorkspaceId);
      // A tag set gathered under the previous workspace must never inform
      // this one's filter (D13/AC20).
      clearTaskTagCache();
      if (unsubscribeStorage) {
        unsubscribeStorage();
        unsubscribeStorage = null;
      }
      if (unsubscribeSharedTags) {
        unsubscribeSharedTags();
        unsubscribeSharedTags = null;
      }
      if (currentWorkspaceId) {
        refreshCatalog();
        if (sharedTagsAvailable(host)) unsubscribeSharedTags = subscribeSharedTags(currentWorkspaceId);
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
      if (unsubscribeSharedTags) {
        unsubscribeSharedTags();
        unsubscribeSharedTags = null;
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
        var tagIds = sharedTaskTagIds
          ? sharedTaskTagIds[context.taskId] || []
          : getTaskTagCacheEntry(context.taskId) || [];
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
    // taskId -> tag ids, projected from the shared workspace catalog. Null
    // means this host definitively has no shared-tags action, in which case
    // getValues reads the per-user task-tag cache below instead. Transient
    // action failures retain the shared source and its last confirmed value.
    var sharedTaskTags = null;
    var currentWorkspaceId = null;
    var unsubscribeCatalog = null;
    var unsubscribeSharedTags = null;
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

    /**
     * The shared-tags store is the canonical catalog on hosts that support
     * it, so the facet's Sort/Group options resolve current
     * workspace-shared tag names/colors instead of a stale, near-empty
     * legacy private catalog.
     *
     * Read it through getSharedTagStore rather than issuing a second,
     * independent invokeAction: on a shared-tags host every mutation goes
     * through an action (tag-create/tag-update/tag-delete, task-tag-add/
     * task-tag-remove) and nothing ever writes CATALOG_SCOPE/TASK_SCOPE
     * storage, so neither of this facet's own storage subscriptions fires.
     * A private copy would therefore freeze at whatever the catalog looked
     * like when the plugin loaded -- renames would keep showing the old
     * group header and a newly applied tag would never leave Untagged
     * until a full reload. Every one of those actions calls
     * refreshSharedTags(), and ensureSharedTagRefresh adds a 30s/on-focus
     * poll, so adopting that store is what makes /tasks react live.
     */
    function refreshCatalog() {
      if (!currentWorkspaceId) {
        catalog = [];
        sharedTaskTags = null;
        notify();
        return;
      }
      if (sharedTagsAvailable(host)) {
        var store = getSharedTagStore(currentWorkspaceId);
        if (!store.unavailable) {
          var value = store.value || emptySharedValue();
          var tasks = value.tasks || {};
          catalog = value.tags || [];
          sharedTaskTags = newIdMap(); // keyed by task id: see newIdMap
          Object.keys(tasks).forEach(function (taskId) {
            sharedTaskTags[taskId] = sanitizeTagIdList(
              (tasks[taskId] || []).map(function (tag) {
                return tag && tag.id;
              }),
            );
          });
          notify();
          return;
        }
        // A pre-actions host still has the old private implementation;
        // retain it as a transparent fallback.
      }
      sharedTaskTags = null;
      loadPrivateCatalog();
    }

    function loadPrivateCatalog(actionErr) {
      host.storage.get(CATALOG_SCOPE, currentWorkspaceId, CATALOG_KEY).then(
        function (entry) {
          catalog = sanitizeCatalog(entry ? entry.value : []);
          notify();
        },
        function (err) {
          // Empty values deliberately give the task list its untagged
          // fallback while a transient read failure is recovered.
          catalog = [];
          logError("load task-list tag facet catalog", actionErr || err);
          notify();
        },
      );
    }

    /** Listens to the one shared-tag store for this workspace, and kicks off its first load. */
    function subscribeSharedTags(workspaceId) {
      ensureSharedTagRefresh(host);
      var store = getSharedTagStore(workspaceId);
      store.listeners.push(refreshCatalog);
      if (!store.loaded && !store.inFlight) fetchSharedTags(host, workspaceId);
      return function () {
        var idx = store.listeners.indexOf(refreshCatalog);
        if (idx !== -1) store.listeners.splice(idx, 1);
      };
    }

    function setWorkspace(workspaceId) {
      if (workspaceId === currentWorkspaceId) return;
      var previousWorkspaceId = currentWorkspaceId;
      currentWorkspaceId = workspaceId || null;
      sharedTaskTags = null;
      clearTaskTagCache();
      cancelSharedTagRetry(previousWorkspaceId);
      if (unsubscribeCatalog) {
        unsubscribeCatalog();
        unsubscribeCatalog = null;
      }
      if (unsubscribeSharedTags) {
        unsubscribeSharedTags();
        unsubscribeSharedTags = null;
      }
      if (currentWorkspaceId) {
        if (sharedTagsAvailable(host)) unsubscribeSharedTags = subscribeSharedTags(currentWorkspaceId);
        refreshCatalog();
        // Kept even on a shared-tags host: it is the only live signal for
        // the legacy private catalog the fallback above reads.
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
      if (unsubscribeSharedTags) unsubscribeSharedTags();
      unsubscribeSharedTags = null;
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
      host.storage.listByKey(TASK_SCOPE, TASK_KEY, { limit: TAG_SCAN_LIMIT }).then(
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
        var tagIds = sharedTaskTags ? sharedTaskTags[context.taskId] : getTaskTagCacheEntry(context.taskId);
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
        // A host that renders plugin submenus (TaskMenuActionRegistration.items)
        // turns this item into the quick list: "More tags..." (this picker)
        // plus the workspace's latest-used tags, one click each. A host that
        // predates the field ignores it entirely and calls run, so the item
        // behaves exactly as it did before -- which is also why run stays
        // here rather than living only inside the submenu's first child.
        items: function (context) {
          return quickTagItems(host, context);
        },
        run: function (context) {
          return openTagPicker(host, context.taskId, context.workspaceId);
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
      colorFromName: colorFromName,
      findTagByName: findTagByName,
      findTagById: findTagById,
      addCatalogTag: addCatalogTag,
      updateCatalogTag: updateCatalogTag,
      removeCatalogTag: removeCatalogTag,
      addTaskTagId: addTaskTagId,
      removeTaskTagId: removeTaskTagId,
      resolveTag: resolveTag,
      mergeTagRepresentations: mergeTagRepresentations,
      isConflictError: isConflictError,
      isDuplicateNameError: isDuplicateNameError,
      logError: logError,
      resolveWorkspaceId: resolveWorkspaceId,
      setTaskTagCache: setTaskTagCache,
      clearTaskTagCache: clearTaskTagCache,
      readModifyWrite: readModifyWrite,
      sanitizeTagIdList: sanitizeTagIdList,
      sanitizeCatalog: sanitizeCatalog,
      sanitizeSharedTags: sanitizeSharedTags,
      TAG_SCAN_LIMIT: TAG_SCAN_LIMIT,
      newIdMap: newIdMap,
      emptySharedValue: emptySharedValue,
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
      quickTagItems: quickTagItems,
      applyQuickTag: applyQuickTag,
      quickTagCacheSize: function () {
        return Object.keys(quickTagCaches).length;
      },
      QUICK_TAG_LIMIT: QUICK_TAG_LIMIT,
      makeTagsTopBarDropdown: makeTagsTopBarDropdown,
      makeDeleteTagConfirm: makeDeleteTagConfirm,
      detectHostCapabilities: detectHostCapabilities,
      countTasksWithTag: countTasksWithTag,
      countSharedTasksWithTag: countSharedTasksWithTag,
      cascadeRemoveTagFromTasks: cascadeRemoveTagFromTasks,
      primeTaskTagCache: primeTaskTagCache,
      actionErrorStatus: actionErrorStatus,
      sharedActionUnsupported: sharedActionUnsupported,
      sharedActionRetryable: sharedActionRetryable,
      sharedTagsEnabled: sharedTagsEnabled,
      getSharedTagStore: getSharedTagStore,
      fetchSharedTags: fetchSharedTags,
      registerTagTaskListFacet: registerTagTaskListFacet,
    },
  });
})();
