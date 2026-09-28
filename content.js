// ---------------------------------------------------------------------------
// Project Chroma - page-side renderer
//
// Two mutually exclusive presentation modes, sharing one injected
// feColorMatrix:
//
//   global    - the whole document carries the correction.
//   spotlight - the page stays untouched; a circular lens following the cursor
//               corrects just the disc under the pointer.
//
// backdrop-filter reads the real composited backdrop, so the lens needs no DOM
// clone and stays live over text, images, canvas and video alike.
// ---------------------------------------------------------------------------

// This file is delivered twice over: once by the manifest on every page load,
// and again by background.js's inject-and-retry for tabs whose document_idle
// injection has not run yet. Both evaluations share one isolated world.
//
// A top-level const/let would therefore be re-declared on the second pass, and
// the whole file would abort at parse time with "Identifier 'IDENTITY_VALUES'
// has already been declared" -- before a single statement ran, so before the
// onMessage listener was ever registered. The duplication was self-defeating:
// the retry path could not recover the very tab it existed to recover.
//
// A runtime guard cannot fix that, because the failure happens before any
// guard executes. The scope has to be structural, so everything below lives
// inside this IIFE: a second evaluation gets its own function scope, re-runs
// harmlessly, and exits at the sentinel. background.js probes that same
// sentinel before injecting, so the two halves cannot disagree.
(function () {
  if (globalThis.__chromaContentReady) return;
  globalThis.__chromaContentReady = true;

// Create and inject SVG Matrix Filter into DOM
function injectChromaFilter() {
  if (document.getElementById('chroma-svg-filter')) return;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'chroma-svg-filter';
  svg.style.display = 'none';

  svg.innerHTML = `
    <filter id="chroma-matrix-filter" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" id="chroma-fe-matrix" values="
        1 0 0 0 0
        0 1 0 0 0
        0 0 1 0 0
        0 0 0 1 0" />
    </filter>
  `;

  document.documentElement.appendChild(svg);
}

const IDENTITY_VALUES = '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0';

// The last matrix the operator actually confirmed. Previews mutate the page,
// so this is what Cancel has to put back.
let committedValues = null;

// Spotlight state.
let spotlightActive = false;
let spotlightRadius = 120;
let savedRootFilter = null;
let onSpotlightMove = null;

// Update the filter matrix values. Always writes the feColorMatrix; only
// attaches it to the document root when the global mode owns the page, so
// spotlight mode never ends up with the matrix applied twice.
function updateMatrixOverlay(matrix) {
  if (!matrix) return;

  const values = Array.isArray(matrix) ? matrix : [];
  let svgValues;

  if (values.length === 20) {
    svgValues = values;
  } else if (values.length === 9) {
    // Lift a 3x3 shader matrix into the 4x5 SVG colour matrix layout.
    const m = values;
    svgValues = [
      m[0], m[1], m[2], 0, 0,
      m[3], m[4], m[5], 0, 0,
      m[6], m[7], m[8], 0, 0,
      0, 0, 0, 1, 0
    ];
  } else {
    return;
  }

  injectChromaFilter();

  const feMatrix = document.getElementById('chroma-fe-matrix');
  if (!feMatrix) return;

  feMatrix.setAttribute('values', svgValues.join(' '));

  if (!spotlightActive) {
    document.documentElement.style.filter = 'url(#chroma-matrix-filter)';
  }
}

// Detach the filter entirely. Preferable to applying the identity matrix:
// no filter element left in the render path, and the page is genuinely
// untouched rather than mathematically unchanged.
function clearMatrixOverlay() {
  document.documentElement.style.filter = '';
}

// --- Colour readout --------------------------------------------------------

// Names a colour by hue family and lightness rather than by nearest match in a
// palette table. Nearest-neighbour naming produces confident nonsense -- a
// slightly desaturated firebrick coming back as "Chocolate" -- and this is a
// readout a user is meant to trust while judging a filter, so the name has to
// stay predictable. Hue families are fixed bands, so the same pixel always
// yields the same word.
function describeColor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const l = (max + min) / 2 / 255;
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  // Neutral test, deliberately not HSL saturation.
  //
  // HSL saturation divides by a term that collapses as lightness falls, so it
  // reports strong chroma for colours that are plainly grey: #94A3B8 came out
  // "Blue" and #64748B came out "Blue". Judged by eye both are grey, and a
  // readout used while assessing a colour filter has to agree with the eye.
  //
  // Nor can the test be purely absolute. An absolute spread flattens the
  // opposite error: #112222 and #3C5A3C are dark, muted colours but genuinely
  // teal and green, and a fixed threshold reads both as grey.
  //
  // Relative chroma -- spread over the strongest channel -- is scale
  // invariant, so it judges a colour the same way at any brightness. It
  // separates the slate greys (0.20, 0.28) from the muted teals (0.50, 0.33)
  // with room to spare, and it needs no lightness term at all.
  const relChroma = max > 0 ? d / max : 0;
  const neutral = relChroma < 0.30;

  if (neutral) {
    if (l < 0.10) return { name: 'Black', hex };
    if (l < 0.32) return { name: 'Dark Gray', hex };
    if (l < 0.62) return { name: 'Gray', hex };
    if (l < 0.88) return { name: 'Light Gray', hex };
    return { name: 'White', hex };
  }

  let family;
  if (h < 15 || h >= 345) family = 'Red';
  else if (h < 45) family = 'Orange';
  else if (h < 70) family = 'Yellow';
  else if (h < 150) family = 'Green';
  else if (h < 190) family = 'Teal';
  else if (h < 255) family = 'Blue';
  else if (h < 290) family = 'Purple';
  else family = 'Magenta';

  let prefix = '';
  if (l < 0.22) prefix = 'Deep ';
  else if (l < 0.42) prefix = 'Dark ';
  else if (l > 0.84) prefix = 'Pale ';
  else if (l > 0.70) prefix = 'Light ';

  return { name: prefix + family, hex };
}

function createColorLabel() {
  if (document.getElementById('chroma-color-label')) return;

  const el = document.createElement('div');
  el.id = 'chroma-color-label';
  el.style.cssText = [
    'position: fixed',
    'left: 0', 'top: 0',
    'display: none',
    'pointer-events: none',
    'z-index: 2147483646',
    'padding: 5px 8px 5px 6px',
    'border-radius: 8px',
    'background: rgba(0, 0, 0, 0.82)',
    'color: #fff',
    'font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'letter-spacing: 0.01em',
    'white-space: nowrap',
    // The page can set almost anything on body; scoping these keeps a hostile
    // or merely enthusiastic stylesheet from breaking the readout.
    'box-shadow: 0 2px 8px rgba(0,0,0,0.35)',
    'display: flex', 'align-items: center', 'gap: 6px'
  ].join('; ');

  const swatch = document.createElement('span');
  swatch.id = 'chroma-color-swatch';
  swatch.style.cssText = [
    'width: 14px', 'height: 14px', 'flex: 0 0 14px',
    'border-radius: 4px',
    'box-shadow: inset 0 0 0 1px rgba(255,255,255,0.35)'
  ].join('; ');

  const text = document.createElement('span');
  text.id = 'chroma-color-text';

  el.appendChild(swatch);
  el.appendChild(text);
  (document.body || document.documentElement).appendChild(el);
}

// Places the label clear of the lens disc and inside the viewport.
//
// Clear of the disc is not cosmetic. The lens is a backdrop-filter covering
// everything within its radius, so a label parked at a fixed 18px offset sat
// *inside* the disc for any radius above that -- meaning the swatch, the one
// element whose whole job is to show a true colour, was itself being run
// through the correction. The readout was displaying a filtered version of the
// colour it claimed to be reporting.
function placeColorLabel(x, y) {
  const el = document.getElementById('chroma-color-label');
  if (!el) return;

  const pad = 12;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Candidate positions in preference order: right of the disc, left of it,
  // then above and below. Each is tried and the first that fits is used.
  const gap = spotlightRadius + 10;
  const candidates = [
    [x + gap, y - h / 2],
    [x - gap - w, y - h / 2],
    [x - w / 2, y - gap - h],
    [x - w / 2, y + gap]
  ];

  let left = null;
  let top = null;
  for (const [cx, cy] of candidates) {
    if (cx >= pad && cx + w <= vw - pad && cy >= pad && cy + h <= vh - pad) {
      left = cx;
      top = cy;
      break;
    }
  }

  // Nothing fits clear of the disc -- a very large radius on a small viewport.
  // Fall back to clamping into the viewport; showing the colour imperfectly
  // beats not showing it at all.
  if (left === null) {
    left = Math.min(Math.max(pad, x + 18), Math.max(pad, vw - w - pad));
    top = Math.min(Math.max(pad, y - h - 14), Math.max(pad, vh - h - pad));
  }

  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function showColorLabel(rgb) {
  createColorLabel();
  const el = document.getElementById('chroma-color-label');
  if (!el) return;

  const { name, hex } = describeColor(rgb[0], rgb[1], rgb[2]);
  const swatch = document.getElementById('chroma-color-swatch');
  const text = document.getElementById('chroma-color-text');
  if (swatch) swatch.style.background = hex;
  if (text) text.textContent = name + '  ' + hex;
  el.style.display = 'flex';
}

function hideColorLabel() {
  const el = document.getElementById('chroma-color-label');
  if (el) el.style.display = 'none';
}

function removeColorLabel() {
  const el = document.getElementById('chroma-color-label');
  if (el) el.remove();
}

// Requests a colour for the current pointer position.
//
// Two separate concerns, and conflating them is what made the first version
// laggy and wrong:
//
//   accuracy -- the lens is a backdrop-filter, so sampling with it up reads the
//     *corrected* pixel and reports the filter's own output as the object's
//     colour. It has to be hidden across the capture, and the capture has to
//     wait for a frame boundary, or it races the compositor and sometimes
//     captures the lens before it was hidden. That wait is the one genuinely
//     slow step, so it happens only when a fresh capture is actually needed.
//
//   latency  -- the background serves most samples from a cached viewport
//     capture, so the common path never waits on the compositor at all. Only a
//     cache miss pays for the frame wait.
//
// Note there is deliberately no element-identity check here. An earlier version
// skipped sampling when document.elementFromPoint returned the same element as
// last time, which is a good idea for DOM structure and a terrible one for
// colour: a photograph is a single <img> spanning the whole viewport, so the
// label froze on one pixel for the entire image while the colour under the
// pointer changed continuously.
let sampleInFlight = false;
let lastSampleAt = 0;
const SAMPLE_MIN_INTERVAL = 45;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function requestColorSample(x, y, force) {
  if (sampleInFlight) return;
  const now = Date.now();
  if (!force && now - lastSampleAt < SAMPLE_MIN_INTERVAL) return;
  lastSampleAt = now;
  sampleInFlight = true;

  const lens = document.getElementById('chroma-spotlight');
  const label = document.getElementById('chroma-color-label');
  const lensWasShown = lens && lens.style.display !== 'none';
  const labelWasShown = label && label.style.display !== 'none';

  const restore = () => {
    if (lensWasShown && lens) lens.style.display = 'block';
    if (labelWasShown && label) label.style.display = 'flex';
    sampleInFlight = false;
  };

  const hideLens = async () => {
    if (lensWasShown && lens) lens.style.display = 'none';
    // Two frames, not one. The first commits the style change, the second
    // guarantees the compositor has actually painted without the lens. A single
    // rAF still raced, and the symptom was a label reporting a corrected colour.
    await nextFrame();
    await nextFrame();
  };

  // Two-phase, because the page cannot know whether the background is about to
  // capture -- only the background knows if its cache is warm.
  //
  // An earlier version gated the hide on `force` alone, on the reasoning that
  // only a forced capture is a "real" one. That was wrong, and wrong in the
  // worst way: the background also captures whenever the cache expires, so most
  // captures happened with the lens *up* and the label reported the corrected
  // pixel instead of the object's own colour. Worse, those frames went into the
  // cache and were then served as if clean, so the error was sticky rather than
  // transient. It surfaced as green swatches reading as grey under the tritan
  // simulation, which maps saturated greens to a near-neutral result.
  chrome.runtime.sendMessage({ type: 'SAMPLE_PREFLIGHT', force: !!force })
    .then((pre) => {
      const needsCapture = !pre || pre.needsCapture;
      if (!needsCapture) return null;
      return hideLens().then(() => true);
    })
    .then((didHide) => chrome.runtime.sendMessage({
      type: 'SAMPLE_COLOR',
      x: x,
      y: y,
      viewportWidth: window.innerWidth,
      force: !!force,
      // Only permit a fresh capture if the lens was actually hidden first.
      allowCapture: didHide === true
    }))
    .then((res) => {
      if (res && res.status === 'Ok' && Array.isArray(res.rgb)) {
        showColorLabel(res.rgb);
        placeColorLabel(x, y);
      }
    })
    .catch(() => {
      // A rejected capture means the page is one we cannot see. Say nothing
      // rather than flashing an error at the user on every mouse move.
    })
    .finally(restore);
}

// --- Spotlight lens --------------------------------------------------------

function createSpotlightLens() {
  if (document.getElementById('chroma-spotlight')) return;

  const host = document.createElement('div');
  host.id = 'chroma-spotlight';
  host.style.cssText = [
    'position: fixed',
    'top: 0', 'left: 0',
    'width: 100vw', 'height: 100vh',
    'pointer-events: none',
    'z-index: 2147483647',
    'display: none',
    'background: transparent',
    // The page pixels behind this element, corrected. Clip decides where.
    'backdrop-filter: url(#chroma-matrix-filter)',
    '-webkit-backdrop-filter: url(#chroma-matrix-filter)',
    // Driven by two custom properties so a mousemove touches two numbers
    // instead of reparsing a full clip-path string.
    '--chroma-x: 0px', '--chroma-y: 0px', '--chroma-r: ' + spotlightRadius + 'px',
    'clip-path: circle(var(--chroma-r) at var(--chroma-x) var(--chroma-y))'
  ].join('; ');

  (document.body || document.documentElement).appendChild(host);
}

function moveSpotlight(e) {
  const host = document.getElementById('chroma-spotlight');
  if (host) {
    host.style.setProperty('--chroma-x', e.clientX + 'px');
    host.style.setProperty('--chroma-y', e.clientY + 'px');
  }
  requestColorSample(e.clientX, e.clientY, false);
}

// The cached viewport frame stops describing the page the moment the page
// moves. Without this the readout would keep answering from a frame of the
// previous scroll position -- correct once, then quietly wrong.
function invalidateSampleCache() {
  chrome.runtime.sendMessage({ type: 'INVALIDATE_SAMPLE_CACHE' }).catch(() => {});
}

let onSpotlightInvalidate = null;

// The two modes cannot both own the page. backdrop-filter operates on the
// already-rendered backdrop, so leaving the root filtered would apply the
// matrix twice inside the disc.
function setSpotlightMode(enabled, radius) {
  injectChromaFilter();

  if (radius !== undefined && radius !== null) {
    spotlightRadius = Math.max(parseInt(radius, 10) || 0, 20);
  }

  createSpotlightLens();
  const host = document.getElementById('chroma-spotlight');
  if (!host) return;

  // Radius is a live property, not a one-shot on activation: dragging the
  // slider re-sends enabled=true for a lens that is already on, so this has
  // to be applied before the no-op guard below.
  host.style.setProperty('--chroma-r', spotlightRadius + 'px');

  if (enabled === spotlightActive) return;

  if (enabled) {
    // Hand the page back untouched for the duration of the preview.
    savedRootFilter = document.documentElement.style.filter || '';
    document.documentElement.style.filter = '';
    spotlightActive = true;
    host.style.display = 'block';
    onSpotlightMove = moveSpotlight;
    window.addEventListener('mousemove', onSpotlightMove, { passive: true });

    onSpotlightInvalidate = invalidateSampleCache;
    window.addEventListener('scroll', onSpotlightInvalidate, { passive: true, capture: true });
    window.addEventListener('resize', onSpotlightInvalidate, { passive: true });

    // Warm the cache before the first sample so the opening hover answers
    // immediately rather than after a full capture.
    invalidateSampleCache();
  } else {
    spotlightActive = false;
    host.style.display = 'none';
    removeColorLabel();
    if (onSpotlightInvalidate) {
      window.removeEventListener('scroll', onSpotlightInvalidate, { capture: true });
      window.removeEventListener('resize', onSpotlightInvalidate);
      onSpotlightInvalidate = null;
    }
    if (onSpotlightMove) {
      window.removeEventListener('mousemove', onSpotlightMove);
      onSpotlightMove = null;
    }
    document.documentElement.style.filter = savedRootFilter || '';
    savedRootFilter = null;
    invalidateSampleCache();
  }
}

// --- Colour audit ---------------------------------------------------------
//
// Collects the colour pairs on this page that a dichromat would struggle to
// tell apart, and hands them to the popup as plain data.
//
// Two constraints shape this. A content script cannot import an ES module, so
// none of the colour maths happens here -- this file extracts and ships, and
// popup.js does the analysis with color/discriminability.js. And a full DOM
// walk on a large page is expensive, so the walk is capped and the elements it
// inspects are chosen for whether they *carry* meaning rather than in document
// order.

const AUDIT_MAX_NODES = 4000;

function parseCssColor(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  if (s === 'transparent' || s === 'none' || s.startsWith('rgba(0, 0, 0, 0)')) return null;

  // rgb()/rgba() in both legacy and space syntax
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
    if (![r, g, b].every(Number.isFinite)) return null;
    if (a < 0.5) return null;
    return [Math.round(r), Math.round(g), Math.round(b)];
  }

  if (s[0] === '#') {
    const h = s.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (full.length !== 6 || !/^[0-9a-f]{6}$/.test(full)) return null;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;   // named colours are not worth a lookup table here
}

// Effective background, walking ancestors until something opaque shows up.
// getComputedStyle only reports the element's own background, and most text
// sits directly on <body> or a transparent wrapper, so without this walk the
// audit would miss most of the page.
function effectiveBackground(el) {
  let node = el;
  let depth = 0;
  while (node && depth < 12) {
    const bg = parseCssColor(getComputedStyle(node).backgroundColor);
    if (bg) return bg;
    node = node.parentElement;
    depth++;
  }
  return [255, 255, 255];
}

// A short, human-readable description of what the element is, so a finding can
// be located on the page instead of just reported.
function describeElement(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id) return tag + '#' + el.id;
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
  if (cls) return tag + '.' + cls;
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
  return text ? tag + ' "' + text + '"' : tag;
}

function collectColorPairs() {
  const pairs = [];
  const seen = new Set();
  let visited = 0;

  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);

  // Text nodes are the highest-value target: "can you read this" is the
  // question the tool exists to answer, and text nodes are cheap to enumerate.
  let node;
  while ((node = walker.nextNode()) && visited < AUDIT_MAX_NODES) {
    const text = node.nodeValue;
    if (!text || text.trim().length < 2) continue;
    const el = node.parentElement;
    if (!el || el.closest('script, style, noscript, svg')) continue;
    visited++;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.15) continue;
    // Ignore text far too small to be a real legibility concern on top of
    // everything else this tool reports.
    if (parseFloat(style.fontSize) < 9) continue;

    const fg = parseCssColor(style.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);

    const key = fg.join(',') + '|' + bg.join(',');
    if (seen.has(key)) continue;
    seen.add(key);

    pairs.push({
      kind: 'text',
      fg, bg,
      selector: describeElement(el),
      sample: text.trim().replace(/\s+/g, ' ').slice(0, 40)
    });
  }

  return pairs;
}

// Sets: groups of sibling elements whose own colour is the only thing
// telling them apart. Chart series, legend swatches, status dots, tag
// colours, step indicators.
//
// This is the case that actually matters, and a text-only audit will miss
// nearly all of it. Text is dominated by the lightness difference between
// foreground and background, and that survives a deficiency intact -- red on
// white is perfectly readable to a deuteranope. What breaks is a set of marks
// at matched lightness, where hue is the *only* cue available. Red and green
// series on a chart at the same lightness are indistinguishable, and no
// amount of lightness contrast would have saved them.
//
// Collected as sets rather than pairs, because the question is mutual: every
// mark in the group has to be tellable from every other.
function collectColorSets() {
  const sets = [];
  const roots = document.querySelectorAll('[class*="legend"], [class*="chart"], [class*="series"], [role="list"], nav ul, table tr');

  const seenKeys = new Set();
  let scanned = 0;

  for (const root of roots) {
    if (scanned > 60) break;
    if (root.closest('script, style, noscript')) continue;

    // Direct-ish children only: a deep subtree would sweep in unrelated
    // page furniture and drown the signal.
    const kids = [...root.children].slice(0, 24);
    if (kids.length < 2) continue;

    const members = [];
    for (const kid of kids) {
      const style = getComputedStyle(kid);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const bg = parseCssColor(style.backgroundColor);
      if (!bg) continue;
      const rect = kid.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      members.push({ bg, el: kid });
    }
    if (members.length < 2) continue;

    // Dedupe by the set of colours, so the same legend found twice via a
    // wrapper and its list does not report twice.
    const key = members.map((m) => m.bg.join(',')).sort().join('|');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    scanned++;

    sets.push({
      kind: 'set',
      label: describeElement(root),
      colors: members.map((m) => m.bg),
      count: members.length
    });
  }
  return sets;
}


function auditPage() {
  try {
    const pairs = collectColorPairs();
    const sets = collectColorSets();
    return {
      status: 'Ok', pairs, sets,
      url: location.href,
      scanned: pairs.length
    };
  } catch (err) {
    return { status: 'Error', error: String((err && err.message) || err), pairs: [], sets: [] };
  }
}

// Listen for matrix updates from background worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'APPLY_FILTER') {
    updateMatrixOverlay(message.matrix);
    committedValues = message.matrix;
  }

  if (message.type === 'PREVIEW_MODE') {
    if (message.mode === 'spotlight') {
      // Enable first, then write the matrix. updateMatrixOverlay deliberately
      // skips the document root while the lens is active, so doing it in this
      // order keeps the page untouched while the lens picks up gain changes.
      setSpotlightMode(true, message.radius);
      updateMatrixOverlay(message.matrix);
      return;
    }
    if (spotlightActive) setSpotlightMode(false);
    if (message.mode === 'original') clearMatrixOverlay();
    else updateMatrixOverlay(message.matrix);
  }

  if (message.type === 'SET_SPOTLIGHT') {
    setSpotlightMode(!!message.enabled, message.radius);
  }

  if (message.type === 'RESTORE_COMMITTED') {
    if (spotlightActive) setSpotlightMode(false);
    if (committedValues) updateMatrixOverlay(committedValues);
    else clearMatrixOverlay();
  }

  // Global off switch. The filter is detached from the render path rather than
  // set to identity: applying the identity matrix still leaves an SVG filter
  // element in the document, which changes stacking and compositing on some
  // pages. Detaching it is genuinely "no filter applied".
  if (message.type === 'CLEAR_FILTER') {
    if (spotlightActive) setSpotlightMode(false);
    clearMatrixOverlay();
    removeColorLabel();
    committedValues = null;
  }

  // Colour audit. The analysis happens in the popup, which is the only context
  // allowed to load an ES module; this side only extracts.
  //
  // Replies via sendResponse rather than re-broadcasting on the runtime. A
  // tabs.sendMessage round trip already carries a response channel, and going
  // back out through the runtime meant the answer had no way to be correlated
  // with the request that asked for it -- a second audit would race the first.
  if (message.type === 'AUDIT_COLORS') {
    sendResponse(auditPage());
  }
});

// Auto-apply saved matrix profile on page load -- but only while enabled.
// The enabled flag is stored separately from the matrix precisely so that
// switching off is destructive to the *effect* without destroying the
// operator's profile: the matrix survives, and switching back on restores it.
chrome.storage.local.get(['chromaMatrix', 'chromaEnabled'], (result) => {
  if (result.chromaEnabled === false) return;
  if (result.chromaMatrix) {
    updateMatrixOverlay(result.chromaMatrix);
    committedValues = result.chromaMatrix;
  }
});
})();
