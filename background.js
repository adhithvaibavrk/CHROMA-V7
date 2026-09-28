// ---------------------------------------------------------------------------
// Project Chroma - Math Engine
//
// Pure-JS implementation of the Vienot / Brettel / Mollon (1999) daltonization
// model, C = I + g * R * (I - S), emitting the 20-value array that SVG
// <feColorMatrix type="matrix"> consumes.
//
// Pipeline, per pixel:
//
//   sRGB -> LMS -> C(LMS) -> sRGB
//
// driven by the Smith & Pokorny cone response matrix. Everything below is
// ordinary arithmetic: no canvas, no GPU, no offscreen document.
// ---------------------------------------------------------------------------

// --- 3x3 linear algebra (row-major) ----------------------------------------

function mat3Identity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

function mat3Multiply(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] +
        a[r * 3 + 1] * b[3 + c] +
        a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function mat3Add(a, b) {
  return a.map((value, i) => value + b[i]);
}

function mat3Scale(m, k) {
  return m.map(value => value * k);
}

function mat3Invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m;

  const c00 =  e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 =  d * h - e * g;
  const det = a * c00 + b * c01 + c * c02;

  if (!isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('Chroma: singular 3x3 matrix, cannot invert');
  }

  const s = 1 / det;
  return [
    c00 * s, -(b * i - c * h) * s,  (b * f - c * e) * s,
    c01 * s,  (a * i - c * g) * s, -(a * f - c * d) * s,
    c02 * s, -(a * h - b * g) * s,  (a * e - b * d) * s
  ];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function mat3Apply(m, v) {
  return [0, 1, 2].map(r => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
}

// --- Cone fundamentals -----------------------------------------------------

// Smith & Pokorny cone response matrix, normalised so equal-energy white
// (1,1,1) maps to LMS white (1,1,1). That normalisation is what lets the axes
// below be read directly as physical quantities.
const RGB_TO_LMS = [
  0.31399022, 0.63951294, 0.04649755,
  0.15537241, 0.75789446, 0.08670142,
  0.01775239, 0.10944209, 0.87256922
];

const LMS_TO_RGB = mat3Invert(RGB_TO_LMS);

// --- S: the dichromat projection -------------------------------------------
//
// A dichromat does not see a reduced version of the world; their view is the
// world with one cone's response *replaced* by a linear combination of the two
// they still have. That is the Brettel / Vienot / Mollon construction, and it
// is what this builds:
//
//   protanopia   L' = a*M + b*S      (no L cones)
//   deuteranopia M' = a*L + b*S      (no M cones)
//   tritanopia   S' = a*L + b*M      (no S cones)
//
// a and b are not free. They are fixed by requiring the projection to preserve
// two points exactly:
//
//   1. the achromatic axis -- white must stay white, or every grey on the page
//      acquires a tint and the correction becomes unusable;
//   2. one gamut anchor -- the primary at the edge of the deficiency's
//      confusion line, which is the other point the dichromat's two cones
//      unambiguously determine.
//
// Those two constraints are a 2x2 linear system in (a, b), solved below.
//
// This is the part the previous implementation got wrong, and it got it wrong
// in a way that was invisible in the output. It modelled the dichromat as the
// rank-1 projector S = I - n n^T with n = [1,-1,0] for *both* protanopia and
// deuteranopia. One axis, one matrix, identical bytes for two different
// clinical diagnoses. Worse, I - n n^T is not the Vienot projection at all:
// the reduced plane passes through the gamut's black, blue, white and yellow
// limits, and that plane's normal is not [1,-1,0]. The real construction below
// yields distinct matrices per deficiency, and its null direction is exactly
// the missing cone -- L, M and S respectively -- which is the sanity check the
// old version could never have passed.
//
// Anchor choice matters, and is not arbitrary:
//
//   protanopia / deuteranopia  anchor on blue. Both use the same reduced plane
//     (the KBWY plane), and blue is the corner that plane is built around. The
//     resulting coefficients are well conditioned -- a and b land near 1, so
//     no cancellation and no clipping blow-up.
//
//   tritanopia  anchor on red, not blue. A tritanope retains L and M and
//     genuinely distinguishes red from green, so the anchor must protect that
//     discrimination. Anchoring on blue instead drives a and b to about -20 and
//     +21, because the S response at the blue primary is nearly orthogonal to
//     both L and M there. The fit is then dominated by cancellation, the
//     projection collapses red toward the achromatic axis, and the model throws
//     away exactly the information a tritanope still has. Reusing the P/D
//     plane for tritan is the specific mistake the literature calls out as
//     "totally wrong", and it is what this file did before.
//
// LIMITATION -- tritanopia is an approximation here, and the popup warns the
// operator. Viénot 1999 covers protanopia and deuteranopia only; its authors
// did not extend it to tritan, and the single-matrix approaches in general are
// widely described as poor for tritan. The accurate model is Brettel 1997,
// which uses *two* half-planes selected per pixel -- a branch feColorMatrix
// cannot express, which is why expressing it as an SVG filter is documented as
// non-trivial. What is below is the best single-plane stand-in this
// architecture allows: it collapses blue and green toward each other and yellow
// toward pink, and keeps red roughly red, which is the right family of
// behaviour. It is not a faithful reproduction, and it should not be presented
// as a clinical simulation.
const LMS_WHITE = normalize3([1, 1, 1]);

// LMS response of the sRGB primaries, computed through RGB_TO_LMS rather than
// hard-coded, so the anchors cannot drift away from the cone matrix.
function lmsOf(rgb) {
  return [0, 1, 2].map(k => RGB_TO_LMS[k * 3] * rgb[0]
                       + RGB_TO_LMS[k * 3 + 1] * rgb[1]
                       + RGB_TO_LMS[k * 3 + 2] * rgb[2]);
}

const SRGB_BLUE = [0, 0, 1];
const SRGB_RED = [1, 0, 0];

// Which cone is missing, and which primary anchors the fit.
const DEFICIENCY = {
  protanopia: { missing: 0, anchor: SRGB_BLUE },
  deuteranopia: { missing: 1, anchor: SRGB_BLUE },
  tritanopia: { missing: 2, anchor: SRGB_RED }
};

const SIMULATION_CACHE = {};

// Builds the 3x3 LMS-space dichromat projection for a deficiency.
function simulationMatrix(cvdType) {
  const key = CVD_TYPES.includes(cvdType) ? cvdType : 'protanopia';
  if (SIMULATION_CACHE[key]) return SIMULATION_CACHE[key].slice();

  const spec = DEFICIENCY[key];
  const missing = spec.missing;
  const retained = [0, 1, 2].filter(k => k !== missing);
  const W = lmsOf([1, 1, 1]);
  const A = lmsOf(spec.anchor);

  // Solve  [ W[r0]  W[r1] ] [a]   [ W[missing] ]
  //        [ A[r0]  A[r1] ] [b] = [ A[missing] ]
  const m00 = W[retained[0]], m01 = W[retained[1]];
  const m10 = A[retained[0]], m11 = A[retained[1]];
  const det = m00 * m11 - m01 * m10;

  if (!isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('Chroma: degenerate anchor fit for ' + key);
  }

  const a = (W[missing] * m11 - m01 * A[missing]) / det;
  const b = (m00 * A[missing] - m10 * W[missing]) / det;

  // Start from identity, then *replace* the missing cone's row. Leaving the
  // diagonal at 1 would add the original cone response back in and roughly
  // double every predicted value.
  const S = mat3Identity();
  S[missing * 3 + missing] = 0;
  S[missing * 3 + retained[0]] = a;
  S[missing * 3 + retained[1]] = b;

  SIMULATION_CACHE[key] = S;
  return S.slice();
}

// --- C: the severity correction --------------------------------------------
//
//   C = I + g * (S - I)
//
// A straight interpolation from "untouched" at g = 0 to the exact dichromat
// projection S at g = 1, with severity from the clinical report mapped onto g.
// A larger reported deficit therefore pulls the display closer to what the
// patient actually perceives, and every intermediate value is a genuine
// mixture of the two rather than an ad-hoc blend.
//
// This replaces C = I - g*P. The old form assumed P was idempotent, which
// holds for a rank-1 *orthogonal* projector n n^T but not for the rank-1
// I - S that the real construction produces, so the "gain 1 is exactly S"
// claim did not survive contact with the actual matrix.
function correctionMatrix(cvdType, gain) {
  const S = simulationMatrix(cvdType);
  const delta = mat3Add(S, mat3Scale(mat3Identity(), -1));
  return mat3Add(mat3Identity(), mat3Scale(delta, gain));
}

// --- Anisotropic (dual-axis) correction ------------------------------------
//
// Mixed deficiencies elevate both the red-green and the yellow-blue axis, so a
// single gain under-corrects whichever axis it is not aimed at. Each axis gets
// its own gain, applied as a rank-1 projector onto that chromatic axis:
//
//   C = I - g_rg * P_rg - g_yb * P_yb
//
// The two axes are orthogonal to each other and both orthogonal to white, so
// the projectors mutually annihilate and the two gains compose with no
// cross-coupling: C*w = w for any pair of gains.
//
// NOTE: no caller currently reaches this. The popup sends only PROCESS_REPORT,
// never PROCESS_REPORT_ANISOTROPIC, and never sets axisGains. It is kept
// because the engine is the right place for it, but it is currently dead code
// and is not exercised by the UI.
function chromaticAxisProjector(axis) {
  const w = LMS_WHITE;
  // Orthogonalise against white so the achromatic axis survives untouched.
  const k = axis[0] * w[0] + axis[1] * w[1] + axis[2] * w[2];
  const n = normalize3([axis[0] - k * w[0], axis[1] - k * w[1], axis[2] - k * w[2]]);
  return [
    n[0] * n[0], n[0] * n[1], n[0] * n[2],
    n[1] * n[0], n[1] * n[1], n[1] * n[2],
    n[2] * n[0], n[2] * n[1], n[2] * n[2]
  ];
}

const RG_AXIS = [1, -1, 0];   // red-green; already orthogonal to white
const YB_AXIS = [0, 0, 1];    // yellow-blue; orthogonalised inside

function anisotropicCorrection(cvdType, rgGain, ybGain) {
  const g_rg = Math.min(Math.max(Number(rgGain) || 0, 0.0), 1.0);
  const g_yb = Math.min(Math.max(Number(ybGain) || 0, 0.0), 1.0);
  const P_rg = chromaticAxisProjector(RG_AXIS);
  const P_yb = chromaticAxisProjector(YB_AXIS);
  // A tritanope is blind on the yellow-blue axis, so the two gains are
  // assigned to the opposite projectors for them.
  const rg = cvdType === 'tritanopia' ? P_yb : P_rg;
  const yb = cvdType === 'tritanopia' ? P_rg : P_yb;
  return mat3Add(
    mat3Identity(),
    mat3Add(mat3Scale(rg, -g_rg), mat3Scale(yb, -g_yb))
  );
}

// --- Composition to display space ------------------------------------------

// feColorMatrix reads non-linear sRGB and there is no 4x5 matrix that can
// express a round trip through linear light, so the correction is composed in
// encoded sRGB directly. This is what every CSS/SVG-filter CVD tool does;
// folding an EOTF in and hoping to recover it linearly shifts neutrals badly.
//
// The cone matrices map white to white to within float noise, so the composed
// matrix still has unit row sums and greys stay grey.
function toDisplayMatrix(cvdType, gain) {
  return mat3Multiply(
    mat3Multiply(LMS_TO_RGB, correctionMatrix(cvdType, gain)),
    RGB_TO_LMS
  );
}

// --- Public API ------------------------------------------------------------

const CVD_TYPES = ['protanopia', 'deuteranopia', 'tritanopia'];

// Pads the 3x3 display matrix out to the 20 values feColorMatrix consumes:
// four rows of five, where the trailing columns are the alpha terms. The
// bottom row passes alpha through untouched.
function toFeColorMatrixValues(matrix3x3, precision = 6) {
  if (!matrix3x3 || matrix3x3.length !== 9 || matrix3x3.some(v => !isFinite(v))) {
    throw new Error('Chroma: expected a finite 3x3 matrix');
  }
  const m = matrix3x3.map(v => Number(v.toFixed(precision)));
  return [
    m[0], m[1], m[2], 0, 0,
    m[3], m[4], m[5], 0, 0,
    m[6], m[7], m[8], 0, 0,
    0, 0, 0, 1, 0
  ];
}

// Entry point: clinical report metrics -> the 20 numbers the filter needs.
function calculateDaltonizationMatrix(cvdType, severity = 1.0) {
  const type = CVD_TYPES.includes(cvdType) ? cvdType : 'protanopia';
  const gain = Math.min(Math.max(Number(severity) || 0, 0.0), 1.0);
  return toFeColorMatrixValues(toDisplayMatrix(type, gain));
}

// --- Pixel sampling --------------------------------------------------------

// Reads the composited colour at one viewport point.
//
// No content-script API can do this: a content script shares the DOM but not
// the rendered frame, so there is no "what colour is at (x, y)" to ask.
// document.elementFromPoint returns an element, not a colour. The only source of
// truth for a rendered pixel is the compositor, reached through
// captureVisibleTab, which is why this lives here rather than in the page.
//
// The cost of that call is the whole design problem. captureVisibleTab encodes
// the entire viewport to PNG and hands it over as a base64 data URL -- megabytes
// on an ordinary page, tens to hundreds of milliseconds of encoder and transfer
// per call. Doing that per mousemove made the readout feel broken: it trailed
// the pointer and the label arrived after the eye had already moved on.
//
// So the viewport is captured once and held. Reading one pixel out of a decoded
// ImageBitmap is effectively free, which means the label can track the pointer
// at mousemove rate while captures happen on a much slower cadence. The cache
// costs one bitmap per tab, not one per sample.
//
// Staleness is bounded by CACHE_TTL and by explicit invalidation from the page
// on scroll and resize, so a moving page cannot be read as a still one.
const CACHE_TTL = 700;

let cachedBitmap = null;
let cachedAt = 0;
let capturing = false;

// Drops the cache. The page calls this on scroll and resize, where a cached
// frame describes a layout that no longer exists.
function invalidatePixelCache() {
  if (cachedBitmap) {
    cachedBitmap.close();
    cachedBitmap = null;
  }
  cachedAt = 0;
}

async function captureViewport() {
  const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// Whether answering the next sample requires a fresh capture.
//
// The page needs to know this *before* it samples, because the lens has to be
// hidden across the capture. Asking first and acting second is what keeps the
// two honest: the page cannot infer staleness from its own state, and this
// side cannot see the page.
function needsFreshCapture(force) {
  if (!cachedBitmap) return true;
  if (force) return true;
  return (Date.now() - cachedAt) >= CACHE_TTL;
}

async function ensureBitmap(force, allowCapture) {
  const fresh = cachedBitmap && (Date.now() - cachedAt) < CACHE_TTL;
  if (cachedBitmap && !force && fresh) return cachedBitmap;

  if (capturing) {
    // A capture is already running. Answer from whatever is cached rather than
    // queueing a second encode -- a queued capture would land after the pointer
    // has moved and be stale on arrival.
    return cachedBitmap;
  }

  // Refusing to capture is deliberate, not an oversight. The caller did not
  // hide the lens, so a capture now would bake the correction into the pixels
  // and every later sample served from this cache would be wrong too. Serving
  // the existing clean frame, or nothing, is the only safe option.
  if (allowCapture === false) return cachedBitmap;

  capturing = true;
  try {
    const next = await captureViewport();
    invalidatePixelCache();
    cachedBitmap = next;
    cachedAt = Date.now();
    return cachedBitmap;
  } finally {
    capturing = false;
  }
}

async function sampleVisiblePixel(x, y, cssViewportWidth, force, allowCapture) {
  const bitmap = await ensureBitmap(force, allowCapture);
  if (!bitmap) return null;

  // Derive scale from the capture itself. Assumes devicePixelRatio instead
  // and this silently samples the wrong pixel on any zoomed or scaled display.
  const scale = cssViewportWidth > 0 ? bitmap.width / cssViewportWidth : 1;
  const px = Math.min(bitmap.width - 1, Math.max(0, Math.round(x * scale)));
  const py = Math.min(bitmap.height - 1, Math.max(0, Math.round(y * scale)));

  // One canvas per capture, reused for every sample taken from that bitmap.
  // Allocating one per sample was measurable on its own at mousemove rate.
  if (!sampleCanvas || sampleCanvas.width !== bitmap.width || sampleCanvas.height !== bitmap.height) {
    sampleCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  }
  sampleCtx.clearRect(0, 0, bitmap.width, bitmap.height);
  sampleCtx.drawImage(bitmap, 0, 0);

  const d = sampleCtx.getImageData(px, py, 1, 1).data;
  return [d[0], d[1], d[2]];
}

let sampleCanvas = null;
let sampleCtx = null;

function handleSampleColor(message, sendResponse) {
  const { x, y, viewportWidth, force, allowCapture } = message;
  sampleVisiblePixel(Number(x), Number(y), Number(viewportWidth), !!force, allowCapture)
    .then((rgb) => {
      if (rgb) sendResponse({ status: 'Ok', rgb });
      else sendResponse({ status: 'Busy' });
    })
    .catch((err) => {
      // captureVisibleTab rejects on tabs it cannot see. That is an expected
      // outcome, not a fault, so it is reported rather than thrown.
      sendResponse({ status: 'Error', error: String((err && err.message) || err) });
    });
}

// --- Tab wiring ------------------------------------------------------------

// Injects content.js into a tab.
//
// Resolves true once the script is in the tab, false if Chrome refused. The
// refusal is the normal outcome on any page the extension cannot script --
// chrome://, the Web Store, a PDF viewer, another extension's page -- and
// callers must be able to tell that apart from success, or an unreachable tab
// is indistinguishable from a delivered one.
//
// Re-injection is safe and needs no guard here. content.js wraps its body in an
// IIFE behind a sentinel, so a second evaluation gets its own function scope
// and exits immediately instead of throwing "Identifier 'IDENTITY_VALUES' has
// already been declared" -- the failure that made the original retry path
// unable to recover the very tab it existed to recover. A probe was tried here
// to skip the redundant work, and has been removed: it was the only construct
// in this file touching worker startup, so it is not worth the surface.
function injectContentScript(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  }).then(() => true).catch((err) => {
    console.warn('Chroma: could not inject content script', err);
    return false;
  });
}

// Single delivery path for every message aimed at the page.
//
// Delivers, or injects-then-delivers. Every exit is deliberate: a tab that
// cannot be scripted resolves to 'no receiver' and logs once at debug level --
// the popup already handles an unreachable engine, and a warning per message
// on every keystroke of the gain slider would bury anything real. The point is
// that a failure is *reachable and named*, not that it is loud.
function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;

    chrome.tabs.sendMessage(tabId, message).catch(() => {
      // No receiver: the tab either never got the content script, or this is a
      // page the extension cannot script at all. Inject unconditionally -- the
      // sentinel in content.js makes that a cheap no-op when it is already
      // there -- then retry the delivery.
      injectContentScript(tabId)
        .then(injected => {
          if (!injected) {
            // The tab exists but refuses scripting, or the injection failed
            // for some other reason. Nothing was delivered; say so once.
            console.debug('Chroma: no content script in tab', tabId);
            return false;
          }
          return chrome.tabs.sendMessage(tabId, message).then(() => true).catch(() => false);
        })
        .then((delivered) => {
          if (!delivered) console.debug('Chroma: message undelivered', message.type, tabId);
        });
    });
  });
}

// The committed state. Previews never reach storage, so a reload always comes
// back to the last confirmed profile.
function applyMatrixToActiveTab(matrix) {
  chrome.storage.local.set({ chromaMatrix: matrix, chromaEnabled: true });
  sendToActiveTab({ type: 'APPLY_FILTER', matrix });
}

// Applies a twin-view state to the page. Nothing is persisted, so leaving the
// confirmation screen can put the page back.
function previewModeOnTab(mode, matrix, radius) {
  sendToActiveTab({ type: 'PREVIEW_MODE', mode, matrix, radius });
}

function setSpotlightOnTab(enabled, radius) {
  sendToActiveTab({ type: 'SET_SPOTLIGHT', enabled, radius });
}

function restoreCommittedOnTab() {
  sendToActiveTab({ type: 'RESTORE_COMMITTED' });
}

// The twin-view states, all derived from the same engine and the same
// blindness axis -- no separate simulation path to keep in sync:
//
//   original   - C(g=0), the identity. Page exactly as authored.
//   simulated  - C(g=1), which the algebra shows collapses to the dichromat
//                projection S. This is what the dichromat actually perceives,
//                so it is the honest "before" baseline to compare against.
//   corrected  - C(g) at the operator's chosen gain.
//   spotlight  - same corrected matrix, but shown through a cursor lens rather
//                than applied to the document root. Presentation only, so it
//                reuses the corrected matrix rather than computing a new one.
const PREVIEW_MODES = ['original', 'simulated', 'corrected', 'spotlight'];

const IDENTITY_FE = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

function matrixForMode(cvdType, gain, mode, axisGains) {
  switch (mode) {
    case 'original':
      return IDENTITY_FE.slice();
    case 'simulated':
      return calculateDaltonizationMatrix(cvdType, 1.0);
    case 'spotlight':
      // Presentation only: the lens corrects with the same matrix as 'corrected'.
      return calculateDaltonizationMatrix(cvdType, gain);
    case 'corrected':
    default:
      // An explicit axis pair selects anisotropic mode; absent one, the
      // historical single-gain behaviour is preserved exactly.
      if (axisGains && (axisGains.rg !== undefined || axisGains.yb !== undefined)) {
        return toFeColorMatrixValues(
          mat3Multiply(
            mat3Multiply(LMS_TO_RGB, anisotropicCorrection(cvdType, axisGains.rg, axisGains.yb)),
            RGB_TO_LMS
          )
        );
      }
      return calculateDaltonizationMatrix(cvdType, gain);
  }
}

function buildModeSet(cvdType, gain, axisGains) {
  const type = CVD_TYPES.includes(cvdType) ? cvdType : 'protanopia';
  const g = Math.min(Math.max(Number(gain) || 0, 0.0), 1.0);
  return {
    cvdType: type,
    gain: g,
    anisotropic: !!(axisGains && (axisGains.rg !== undefined || axisGains.yb !== undefined)),
    matrices: {
      original: matrixForMode(type, g, 'original', axisGains),
      simulated: matrixForMode(type, g, 'simulated', axisGains),
      corrected: matrixForMode(type, g, 'corrected', axisGains),
      // Presentation-only mode; the lens corrects with the same matrix.
      spotlight: matrixForMode(type, g, 'spotlight', axisGains)
    }
  };
}

function describeCorrection(payload) {
  const { cvdType, severity } = payload || {};
  const type = CVD_TYPES.includes(cvdType) ? cvdType : 'protanopia';
  const gain = Math.min(Math.max(Number(severity) || 0, 0.0), 1.0);
  return {
    cvdType: type,
    gain,
    matrix: calculateDaltonizationMatrix(type, gain)
  };
}

function handleComputeRequest(payload) {
  const result = describeCorrection(payload);
  applyMatrixToActiveTab(result.matrix);
  return { status: 'Processing', ...result };
}

// Anisotropic commit, used when a report carries both channel thresholds.
function handleAnisotropicRequest(payload) {
  const { cvdType, axisGains } = payload || {};
  const set = buildModeSet(cvdType, 0, axisGains);
  applyMatrixToActiveTab(set.matrices.corrected);
  return { status: 'Processing', cvdType: set.cvdType, gain: set.gain, anisotropic: true, matrix: set.matrices.corrected };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Liveness probe from popup/boot-guard.js. A service worker that fails to
  // start leaves the popup silently dead, so it announces itself explicitly.
  if (message.type === 'PING') {
    sendResponse({ status: 'Ready' });
    return false;
  }

  // Colour readout for the lens. Answered asynchronously and deliberately
  // retargeted at the sender's own tab: the active tab may have changed
  // between the mousemove and the capture, and sampling the wrong tab would
  // report a colour that has nothing to do with the pointer.
  if (message.type === 'SAMPLE_PREFLIGHT') {
    sendResponse({ status: 'Ready', needsCapture: needsFreshCapture(!!message.force) });
    return false;
  }

  if (message.type === 'SAMPLE_COLOR') {
    handleSampleColor(message, sendResponse);
    return true;
  }

  // The page moves; a cached frame now describes a layout that no longer
  // exists, so it is dropped rather than served stale.
  if (message.type === 'INVALIDATE_SAMPLE_CACHE') {
    invalidatePixelCache();
    sendResponse({ status: 'Invalidated' });
    return false;
  }

  // Global on/off. The saved matrix is deliberately left untouched: switching
  // off must remove the correction from the page without destroying the
  // profile the operator confirmed, so switching back on is a single toggle
  // rather than a re-import. That is the whole point of the switch existing.
  if (message.type === 'SET_ENABLED') {
    const enabled = !!message.enabled;
    if (enabled) {
      chrome.storage.local.set({ chromaEnabled: true }, () => {
        chrome.storage.local.get(['chromaMatrix'], (r) => {
          if (r.chromaMatrix) sendToActiveTab({ type: 'APPLY_FILTER', matrix: r.chromaMatrix });
        });
      });
    } else {
      chrome.storage.local.set({ chromaEnabled: false }, () => {
        sendToActiveTab({ type: 'CLEAR_FILTER' });
      });
    }
    sendResponse({ status: enabled ? 'Enabled' : 'Disabled' });
    return false;
  }

  // All three twin-view matrices in one round trip, so the toggle never has to
  // wait on a per-click compute.
  if (message.type === 'GET_MODE_SET') {
    try {
      sendResponse({ status: 'ModeSet', ...buildModeSet(message.cvdType, message.gain) });
    } catch (err) {
      console.error('Chroma: mode set failed', err);
      sendResponse({ status: 'Error', error: String((err && err.message) || err) });
    }
  }

  // Live preview. Applies to the page but never to storage.
  if (message.type === 'PREVIEW_MODE') {
    try {
      const { mode, cvdType, gain, radius, axisGains } = message;
      if (!PREVIEW_MODES.includes(mode)) {
        throw new Error(`unknown preview mode: ${mode}`);
      }
      const set = buildModeSet(cvdType, gain, axisGains);
      previewModeOnTab(mode, set.matrices[mode], radius);
      sendResponse({ status: 'Previewing', mode, cvdType: set.cvdType, gain: set.gain, anisotropic: set.anisotropic });
    } catch (err) {
      console.error('Chroma: preview mode failed', err);
      sendResponse({ status: 'Error', error: String((err && err.message) || err) });
    }
  }

  // Spotlight is a page-side effect only; it never touches storage.
  if (message.type === 'SET_SPOTLIGHT') {
    try {
      setSpotlightOnTab(!!message.enabled, message.radius);
      sendResponse({ status: message.enabled ? 'Spotlight on' : 'Spotlight off' });
    } catch (err) {
      console.error('Chroma: spotlight failed', err);
      sendResponse({ status: 'Error', error: String((err && err.message) || err) });
    }
  }

  if (message.type === 'RESTORE_PREVIEW') {
    restoreCommittedOnTab();
    sendResponse({ status: 'Restored' });
  }

  // Preview is deliberately inert: compute and report, apply nothing.
  if (message.type === 'PREVIEW_MATRIX') {
    try {
      sendResponse({ status: 'Preview', ...describeCorrection(message.payload) });
    } catch (err) {
      console.error('Chroma: preview failed', err);
      sendResponse({ status: 'Error', error: String((err && err.message) || err) });
    }
  }

  if (message.type === 'PROCESS_REPORT_ANISOTROPIC') {
    try {
      sendResponse(handleAnisotropicRequest(message.payload));
    } catch (err) {
      console.error('Chroma: anisotropic computation failed', err);
      sendResponse({ status: 'Error', error: String((err && err.message) || err) });
    }
  }

  if (message.type === 'PROCESS_REPORT' || message.type === 'COMPUTE_MATRIX') {
    try {
      sendResponse(handleComputeRequest(message.payload));
    } catch (err) {
      console.error('Chroma: matrix computation failed', err);
      sendResponse({ status: 'Error', error: String((err && err.message) || err) });
    }
  }

  if (message.type === 'MATRIX_COMPUTED' && message.matrix) {
    applyMatrixToActiveTab(message.matrix);
  }

  return true;
});
