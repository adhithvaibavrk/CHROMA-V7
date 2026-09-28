// ---------------------------------------------------------------------------
// Project Chroma - discriminability engine
//
// The question this answers is not "what colour is it" but "can you tell them
// apart". A dichromat's two working cones produce a 2D colour space, so some
// pairs of colours that are unmistakably different to a trichromat land on
// top of each other for them. That collapse is silent: the page looks fine to
// the designer and unreadable to the user.
//
// Method, per pair of colours:
//
//   1. Undo the sRGB transfer function. Colour difference is only perceptually
//      meaningful on light, and OKLab's whole premise is that it models
//      lightness that way. Skipping this is the same mistake as comparing
//      encoded sRGB values directly.
//   2. Push each colour through the dichromat projection for the selected
//      deficiency. That is the engine's existing simulation matrix, used at
//      full strength -- this asks "what does this person actually see".
//   3. Measure the separation in OKLab.
//   4. Compare against both the original separation and an absolute
//      just-noticeable-difference floor, because they answer different
//      questions. A pair that was always nearly identical is a design fault
//      that has nothing to do with colour vision; a pair that started far apart
//      and collapsed is the specific failure this engine exists to catch.
//
// The pair verdicts roll up to a set verdict by taking the *worst* pair rather
// than an average. An outfit is unusable if any two items blur together, and an
// average would let four good pairs hide one that fails.
// ---------------------------------------------------------------------------

// The sRGB transfer functions live with the simulation rather than beside the
// perceptual maths, so there is one definition of 'what linear light means'
// in the codebase. Duplicating those constants is how the two drift apart.
import { simulateColor, srgbToLinear, linearToSrgb } from '../color/dichromat.js';

// sRGB is gamma-encoded and OKLab expects light, so every conversion in this
// file decodes on the way in and re-encodes on the way out. Skipping that is
// the same mistake as comparing encoded sRGB values directly, and it is the
// single most common way perceptual distance gets done wrong.

// --- OKLab -----------------------------------------------------------------
//
// Bjorn Ottosson's OKLab. Matrix rows come from the reference implementation;
// they are not the cone fundamentals used by the display filter, because OKLab
// is a *perceptual* space for measuring difference rather than a simulation
// of the retina. Using it here is deliberate: the two jobs are different.

function linearSrgbToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  ];
}

function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const L3 = l_ * l_ * l_;
  const M3 = m_ * m_ * m_;
  const S3 = s_ * s_ * s_;

  return [
    +4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3,
    -1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3,
    -0.0041960863 * L3 - 0.7034186147 * M3 + 1.7076147010 * S3
  ];
}

// --- Public conversions ----------------------------------------------------

// rgb in 0..255 -> OKLab {L, a, b}. L is 0..1, a and b are roughly -0.4..0.4.
export function rgbToOklab(r, g, b) {
  const [L, A, B] = linearSrgbToOklab(
    srgbToLinear(r / 255),
    srgbToLinear(g / 255),
    srgbToLinear(b / 255)
  );
  return { L, a: A, b: B };
}

export function rgbToOklch(r, g, b) {
  const { L, a, b: B } = rgbToOklab(r, g, b);
  const C = Math.hypot(a, B);
  let h = (Math.atan2(B, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

export function oklabToRgb(L, a, b) {
  const [lr, lg, lb] = oklabToLinearSrgb(L, a, b);
  return {
    r: Math.round(Math.min(1, Math.max(0, linearToSrgb(lr))) * 255),
    g: Math.round(Math.min(1, Math.max(0, linearToSrgb(lg))) * 255),
    b: Math.round(Math.min(1, Math.max(0, linearToSrgb(lb))) * 255)
  };
}

export function hexToRgb(hex) {
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

// --- Difference ------------------------------------------------------------

// Euclidean distance in OKLab, on a 0..100 scale. OKLab's L is 0..1 while a
// and b are an order of magnitude smaller, so scaling by 100 puts a typical
// "clearly different" pair in the tens and a JND around 2-3, which is the
// range the thresholds below are quoted against.
export function deltaEOk(rgb1, rgb2) {
  const c1 = rgbToOklab(rgb1.r, rgb1.g, rgb1.b);
  const c2 = rgbToOklab(rgb2.r, rgb2.g, rgb2.b);
  return 100 * Math.hypot(c1.L - c2.L, c1.a - c2.a, c1.b - c2.b);
}

// --- Thresholds ------------------------------------------------------------
//
// 2.0 is a conservative just-noticeable difference for OKLab at this scaling.
// 5.0 is where a difference starts being comfortable to read rather than merely
// detectable. Both are deliberately higher than the textbook JND: this tool
// exists to catch problems, so a borderline pair should be reported rather
// than waved through.
const JND = 2.0;
const COMFORTABLE = 5.0;

// Below this chroma a colour is achromatic and its hue angle is numerical noise:
// atan2 of two near-zero components swings wildly, which produced a nonsense
// "261 degrees became 90 degrees" for navy against black. Hue is only read
// above this floor, and a pair that falls under it is treated as having no hue
// signal rather than a random one.
const CHROMA_FLOOR = 0.03;

// The share of the original hue separation a dichromat keeps. A quarter is the
// point below which the colour cue is gone.
//
// This threshold exists because total deltaE is the wrong instrument for the
// most famous case in the whole field. Google's red and green measure 31 apart
// to a trichromat and still 6.9 apart to a deuteranope -- comfortably over the
// "comfortable" line -- because the two colours differ in *lightness* and
// lightness survives. Their hue, though, goes from 119 degrees apart to 1
// degree. Scoring that pair as distinct would tell a deuteranope their brand
// colours are fine when the colour information has been entirely removed and
// they are relying on a luminance cue that will not survive a different
// monitor, a different room, or a bad panel.
const HUE_SURVIVAL = 0.25;

function hueGap(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

// --- Pair assessment -------------------------------------------------------

// Assesses two colours for one deficiency.
//   originalDelta  - separation as a trichromat sees it
//   projectedDelta - separation as the dichromat sees it
//   ratio          - fraction of the original separation that survived
//   verdict        - 'distinct' | 'marginal' | 'collapsed'
//   reason         - short explanation, for the UI to show verbatim
export function assessPair(rgb1, rgb2, cvdType) {
  const originalDelta = deltaEOk(rgb1, rgb2);
  const sim1 = simulateColor(rgb1, cvdType);
  const sim2 = simulateColor(rgb2, cvdType);
  const projectedDelta = deltaEOk(sim1, sim2);
  const ratio = originalDelta > 1e-6 ? projectedDelta / originalDelta : 1;

  // Hue survival, guarded on chroma so an achromatic pair is never scored on
  // noise. null means "this pair carries no hue signal to lose", which is a
  // different thing from "the hue signal survived".
  const o1 = rgbToOklch(rgb1.r, rgb1.g, rgb1.b);
  const o2 = rgbToOklch(rgb2.r, rgb2.g, rgb2.b);
  const p1 = rgbToOklch(sim1.r, sim1.g, sim1.b);
  const p2 = rgbToOklch(sim2.r, sim2.g, sim2.b);

  const originalHueGap = hueGap(o1.h, o2.h);
  const chromaticPair = o1.C > CHROMA_FLOOR && o2.C > CHROMA_FLOOR && originalHueGap > 5;

  let hueSurvival = null;
  if (chromaticPair) {
    if (p1.C <= CHROMA_FLOOR || p2.C <= CHROMA_FLOOR) {
      // The simulation drained the colour out of one of them entirely.
      hueSurvival = 0;
    } else {
      hueSurvival = hueGap(p1.h, p2.h) / originalHueGap;
    }
  }

  // Two independent failure modes, and the difference matters. "always too
  // close" is a design problem that exists with or without colour vision, and
  // blaming it on the deficiency would send people looking in the wrong place.
  const wasClose = originalDelta < JND;

  let verdict;
  let reason;

  if (wasClose) {
    verdict = 'always-close';
    reason = 'Already nearly identical before the deficiency is applied. ' +
      'This is a design problem, not a colour-vision one.';
  } else if (projectedDelta < JND) {
    verdict = 'collapsed';
    reason = 'Clearly different colours that become indistinguishable for ' +
      'someone with this deficiency.';
  } else if (hueSurvival !== null && hueSurvival < HUE_SURVIVAL) {
    verdict = 'hue-collapsed';
    reason = 'The lightness difference survives, so these can be told apart on ' +
      'screen -- but the colour cue is gone. That cue is what most people ' +
      'actually rely on, and it does not survive a different monitor, a ' +
      'different room, or an uncalibrated panel.';
  } else if (projectedDelta < COMFORTABLE) {
    verdict = 'marginal';
    reason = 'Still distinguishable, but close enough to be hard to tell apart ' +
      'reliably.';
  } else {
    verdict = 'distinct';
    reason = 'Remains clearly distinguishable, in colour as well as lightness.';
  }

  return {
    originalDelta, projectedDelta, ratio, verdict, reason, cvdType,
    hueSurvival,
    hueGapBefore: chromaticPair ? originalHueGap : null,
    hueGapAfter: chromaticPair ? hueGap(p1.h, p2.h) : null,
    original: rgb1, projected: sim1
  };
}

// --- Set assessment --------------------------------------------------------
//
// Rolls a collection of colours up to one answer. The headline number is the
// worst pair, never an average: four comfortable pairs must not be allowed to
// average away one that fails, because a garment or a chart series that
// collides with another is unusable regardless of how good the rest are.

// Ordered worst to best. hue-collapsed outranks marginal on purpose: a pair
// that still measures "fine" on total difference but has lost all its colour
// information is the more dangerous one, because it looks acceptable in every
// automated check and only fails for the person using it.
const WEIGHTS = {
  collapsed: 0,
  'hue-collapsed': 25,
  marginal: 60,
  'always-close': 40,
  distinct: 100
};

export function assessSet(rgbList, cvdType) {
  const colors = (rgbList || []).filter(Boolean);
  if (colors.length < 2) {
    return {
      score: 100, worst: null, pairs: [], collisionCount: 0,
      note: 'Fewer than two colours.'
    };
  }

  const pairs = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const assessment = assessPair(colors[i], colors[j], cvdType);
      pairs.push({ a: colors[i], b: colors[j], ...assessment });
    }
  }

  // Worst = lowest weight, ties broken by the most severe collapse ratio.
  pairs.sort((p, q) => {
    const d = WEIGHTS[p.verdict] - WEIGHTS[q.verdict];
    return d !== 0 ? d : p.ratio - q.ratio;
  });

  const worst = pairs[0];
  const score = Math.round(WEIGHTS[worst.verdict] * 100) / 100;
  const collisionCount = pairs.filter((p) => p.verdict === 'collapsed' || p.verdict === 'always-close').length;

  return {
    score: Math.round(score * 100) / 100,
    worst,
    pairs,
    collisionCount,
    // The ratio of the single worst pair, kept for the "how close did it come"
    // line in the UI.
    note: worst.reason
  };
}

// --- Convenience -----------------------------------------------------------

// Hex-list entry point, since that is what a DOM scan produces.
export function assessHexList(hexList, cvdType) {
  return assessSet(
    hexList.map(hexToRgb).filter(Boolean),
    cvdType
  );
}

export const THRESHOLDS = { JND, COMFORTABLE };
