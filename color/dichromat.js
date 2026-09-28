// ---------------------------------------------------------------------------
// Project Chroma - dichromat simulation, as a shareable module
//
// This is the cone-space model the display filter uses, factored out so the
// discriminability engine can ask the same question the filter answers.
//
// IMPORTANT -- read before editing.
//
// background.js holds its own copy of these nine constants and of the anchor
// fit, because an MV3 service worker declared as a classic script cannot import
// anything. A content script cannot either. Only popup.js is a module. So this
// file and background.js necessarily both carry the cone matrix, and they must
// be changed together. The parity check in tools/verify-color.js compares them
// and fails loudly on drift; run it after any change to either.
//
// The difference between the two paths is deliberate and is the one thing worth
// understanding before touching either:
//
//   background.js  composes in *encoded* sRGB. No round trip through light.
//                   It has to, because a CSS feColorMatrix reads non-linear
//                   channel values and no 4x5 matrix can express a transfer
//                   function. It is the right choice for repainting pixels.
//
//   this module    linearises first, then simulates, then measures. It has to,
//                   because a perceptual distance between two colours is only
//                   meaningful on light, and OKLab assumes light. It is the
//                   right choice for answering "can this person tell them
//                   apart".
//
// So the filter and this engine will not agree to the last digit. They agree
// about which pairs collapse, which is what each is for.
// ---------------------------------------------------------------------------

// Smith & Pokorny cone fundamentals, normalised so equal-energy white
// (1,1,1) maps to LMS white (1,1,1). Must stay identical to the copy in
// background.js.
export const RGB_TO_LMS = [
  0.31399022, 0.63951294, 0.04649755,
  0.15537241, 0.75789446, 0.08670142,
  0.01775239, 0.10944209, 0.87256922
];

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;
  const det = a * c00 + b * c01 + c * c02;
  if (!isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('Chroma: singular cone matrix');
  }
  const s = 1 / det;
  return [
    c00 * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    c01 * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    c02 * s, -(a * h - b * g) * s, (a * e - b * d) * s
  ];
}

export const LMS_TO_RGB = invert3(RGB_TO_LMS);

// --- sRGB transfer ---------------------------------------------------------

const SRGB_THRESHOLD = 0.04045;
const SRGB_SLOPE = 12.92;
const SRGB_ALPHA = 0.055;
const SRGB_GAMMA = 2.4;

export function srgbToLinear(c) {
  return c <= SRGB_THRESHOLD
    ? c / SRGB_SLOPE
    : Math.pow((c + SRGB_ALPHA) / (1 + SRGB_ALPHA), SRGB_GAMMA);
}

export function linearToSrgb(c) {
  return c <= 0.0031308
    ? c * SRGB_SLOPE
    : (1 + SRGB_ALPHA) * Math.pow(c, 1 / SRGB_GAMMA) - SRGB_ALPHA;
}

// --- The projection --------------------------------------------------------
//
// Same construction as background.js: the missing cone's response is replaced
// by a linear combination of the two retained, fitted so that white and one
// gamut anchor are preserved exactly. See the long comment in background.js
// for why the anchor differs for tritanopia.

const SRGB_BLUE = [0, 0, 1];
const SRGB_RED = [1, 0, 0];

const DEFICIENCY = {
  protanopia: { missing: 0, anchor: SRGB_BLUE },
  deuteranopia: { missing: 1, anchor: SRGB_BLUE },
  tritanopia: { missing: 2, anchor: SRGB_RED }
};

export const CVD_TYPES = ['protanopia', 'deuteranopia', 'tritanopia'];

function lmsOf(rgb) {
  return [0, 1, 2].map((k) => RGB_TO_LMS[k * 3] * rgb[0]
                      + RGB_TO_LMS[k * 3 + 1] * rgb[1]
                      + RGB_TO_LMS[k * 3 + 2] * rgb[2]);
}

const CACHE = {};

export function simulationMatrix(cvdType) {
  const key = CVD_TYPES.includes(cvdType) ? cvdType : 'protanopia';
  if (CACHE[key]) return CACHE[key].slice();

  const { missing, anchor } = DEFICIENCY[key];
  const retained = [0, 1, 2].filter((k) => k !== missing);
  const W = lmsOf([1, 1, 1]);
  const A = lmsOf(anchor);

  const m00 = W[retained[0]], m01 = W[retained[1]];
  const m10 = A[retained[0]], m11 = A[retained[1]];
  const det = m00 * m11 - m01 * m10;

  if (!isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('Chroma: degenerate anchor fit for ' + key);
  }

  const a = (W[missing] * m11 - m01 * A[missing]) / det;
  const b = (m00 * A[missing] - m10 * W[missing]) / det;

  // The missing cone's diagonal is zeroed: its response is replaced, not kept.
  const S = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  S[missing * 3 + missing] = 0;
  S[missing * 3 + retained[0]] = a;
  S[missing * 3 + retained[1]] = b;

  CACHE[key] = S;
  return S.slice();
}

function apply3(m, v) {
  return [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
}

// --- The entry point -------------------------------------------------------

// What a dichromat perceives for one sRGB colour, in linear light.
//
// Steps: decode sRGB, go to LMS, replace the missing cone, come back to RGB,
// clip to the display gamut. Clipping is not a shortcut -- the display
// physically cannot show an out-of-gamut colour, so that is genuinely what
// they would see.
//
// rgb in:  { r, g, b } 0..255. Returns the same shape.
export function simulateColor(rgb, cvdType) {
  const lin = [srgbToLinear(rgb.r / 255), srgbToLinear(rgb.g / 255), srgbToLinear(rgb.b / 255)];
  const lms = apply3(RGB_TO_LMS, lin);
  const simulated = apply3(simulationMatrix(cvdType), lms);
  const out = apply3(LMS_TO_RGB, simulated);
  const clip = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return { r: clip(out[0]), g: clip(out[1]), b: clip(out[2]) };
}

