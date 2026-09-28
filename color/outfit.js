// ---------------------------------------------------------------------------
// Project Chroma - clothing combination grading
//
// WHAT IS MEASURED AND WHAT IS A STYLE RULE
//
// This module returns its findings in two separate lists, and the popup labels
// them separately, because they carry very different weight.
//
//   measured - things this codebase can actually compute. The two garments you
//              cannot tell apart, and the ones that collapse into a single
//              shape because they share a lightness. These come out of the same
//              dichromat engine that drives the rest of the extension, so they
//              are as trustworthy as the colour-vision model itself -- which
//              means approximate for protanopia and deuteranopia, and a
//              single-plane stand-in for tritanopia. See color/dichromat.js.
//
//   style   - rules of thumb about clothes. "Three unrelated hues is busy" is
//              a convention, not a fact. It is a suggestion and it says so.
//
// The grade is driven by the measured list. Style can demote a combination but
// can never promote one, so a heap of tasteful hues that you cannot actually
// tell apart does not come out green just because the palette is nice.
//
// WHAT THIS IS NOT
//
// A diagnosis of taste, and not a recommendation of what anyone should wear.
// It answers one narrow question: can these garments be told apart, and do
// they read as separate pieces? Everything beyond that is convention.
// ---------------------------------------------------------------------------

import { assessPair, rgbToOklch, hexToRgb, THRESHOLDS } from './discriminability.js';

const { JND, COMFORTABLE } = THRESHOLDS;

// Below this chroma a colour reads as grey, black, cream or white rather than
// as a hue, so it is a neutral and does not add to the hue count.
const NEUTRAL_C = 0.045;

// Lightness spread, in OKLCh L (0..1).
//
// Derived rather than looked up: garments within about 0.10 of each other in
// lightness read as one block under daylight, and the boundary is a judgement
// call, not a published constant. Both ends are labelled as such in the UI.
const SPREAD_MERGE = 0.10;   // below this the pieces visibly merge
const SPREAD_THIN = 0.20;    // below this the outfit is flat but legible

// Hue families, in OKLCh degrees. Four broad arcs rather than named colours, so
// "a red belt" and "a rust belt" are not counted as two different things.
const FAMILY_ARCS = [
  { name: 'red–orange', lo: 15, hi: 75 },
  { name: 'yellow–green', lo: 75, hi: 155 },
  { name: 'cyan–blue', lo: 155, hi: 265 },
  { name: 'purple–magenta', lo: 265, hi: 375 }
];

const GRADE_LABEL = { good: 'Good', decent: 'Decent', weak: 'Weak' };

function familyOf(h, C) {
  if (C < NEUTRAL_C) return null;
  const hue = ((h % 360) + 360) % 360;
  for (const f of FAMILY_ARCS) {
    const hi = f.hi > 360 ? f.hi - 360 : f.hi;
    const inArc = f.hi > 360
      ? (hue >= f.lo || hue <= hi)
      : (hue >= f.lo && hue < f.hi);
    if (inArc) return f.name;
  }
  return null;
}

const GRADE_ORDER = { good: 2, decent: 1, weak: 0 };
const demote = (grade, to) => (GRADE_ORDER[to] < GRADE_ORDER[grade] ? to : grade);

export function gradeCombination(hexList, cvdType) {
  const swatches = (hexList || [])
    .map((h) => ({ hex: String(h).toUpperCase(), rgb: hexToRgb(h) }))
    .filter((s) => s.rgb);

  if (swatches.length < 2) {
    return {
      grade: null,
      measured: [],
      style: [],
      pairs: [],
      summary: 'Add at least two colours to grade the combination.',
      swatches
    };
  }

  const measured = [];
  const style = [];

  // --- measured 1: can the two garments be told apart at all? --------------
  const pairs = [];
  for (let i = 0; i < swatches.length; i++) {
    for (let j = i + 1; j < swatches.length; j++) {
      const a = assessPair(swatches[i].rgb, swatches[j].rgb, cvdType);
      pairs.push({ a: swatches[i], b: swatches[j], ...a });
    }
  }
  pairs.sort((p, q) => p.projectedDelta - q.projectedDelta);
  const worst = pairs[0];

  const collapsed = pairs.filter((p) => p.verdict === 'collapsed' || p.verdict === 'always-close');

  measured.push({
    key: 'separation',
    status: collapsed.length ? 'fail' : worst.projectedDelta < COMFORTABLE ? 'warn' : 'ok',
    label: 'Separating the pieces',
    // worst.a and worst.b are the swatch objects themselves, not indices.
    detail: collapsed.length
      ? collapsed.length + ' of ' + pairs.length + ' pair' +
        (pairs.length === 1 ? '' : 's') + ' collapse to the same colour for a ' +
        cvdLabel(cvdType) + '. The worst is ' + collapsed[0].a.hex + ' against ' +
        collapsed[0].b.hex + '.'
      : 'The closest pair, ' + worst.a.hex + ' against ' + worst.b.hex +
        ', stays ' + worst.projectedDelta.toFixed(1) + ' apart for a ' + cvdLabel(cvdType) +
        ' (comfortable is ' + COMFORTABLE + ').'
  });

  // --- measured 2: do they read as separate shapes? ------------------------
  const ls = swatches.map((s) => rgbToOklch(s.rgb.r, s.rgb.g, s.rgb.b).L);
  const spread = Math.max(...ls) - Math.min(...ls);
  measured.push({
    key: 'lightness',
    status: spread < SPREAD_MERGE ? 'fail' : spread < SPREAD_THIN ? 'warn' : 'ok',
    label: 'Lightness range',
    detail: 'The garments span ' + spread.toFixed(2) + ' in lightness' +
      (spread < SPREAD_MERGE
        ? ', which is close enough that they read as one block.'
        : spread < SPREAD_THIN
          ? ', so the outfit looks flat even though the pieces are distinct.'
          : ', so each garment reads as its own shape.')
  });

  // --- style: how many hue families are in play ----------------------------
  const fams = new Set();
  let neutrals = 0;
  for (const s of swatches) {
    const o = rgbToOklch(s.rgb.r, s.rgb.g, s.rgb.b);
    const f = familyOf(o.h, o.C);
    if (f) fams.add(f); else neutrals++;
  }
  style.push({
    key: 'hues',
    status: fams.size > 3 ? 'warn' : 'ok',
    label: 'Hue count',
    detail: fams.size
      ? fams.size + ' hue ' + (fams.size === 1 ? 'family' : 'families') + ' (' +
        [...fams].join(', ') + ')' + (neutrals ? ' plus ' + neutrals + ' neutral' + (neutrals === 1 ? '' : 's') : '') + '.'
      : 'Every colour here is a neutral, so there is no hue clash to weigh.'
  });

  // --- style: a neutral to anchor the outfit -------------------------------
  style.push({
    key: 'anchor',
    status: neutrals > 0 ? 'ok' : 'warn',
    label: 'Neutral anchor',
    detail: neutrals
      ? neutrals + ' neutral' + (neutrals === 1 ? '' : 's') + ' to sit the others against.'
      : 'No neutrals. A common convention is to anchor a busy palette with one.'
  });

  // --- the grade -----------------------------------------------------------
  // Measured findings decide it. Style can only pull a grade down.
  let grade = 'good';
  for (const m of measured) {
    if (m.status === 'fail') grade = demote(grade, 'weak');
    else if (m.status === 'warn') grade = demote(grade, 'decent');
  }
  for (const s of style) {
    if (s.status === 'warn') grade = demote(grade, 'decent');
  }

  // The summary has to name the finding that actually caused the grade.
  //
  // An earlier version said "at least two of these are the same colour to a
  // <type>" for every weak result. That is only true when separation failed.
  // A red top and a green skirt also grade weak, but for a tritan -- who can
  // tell those apart perfectly well -- the cause is that they sit at the same
  // lightness, which has nothing to do with colour vision. Telling a tritan
  // wearer their outfit is indistinguishable would be plainly wrong.
  const separation = measured.find((m) => m.key === 'separation');
  const lightness = measured.find((m) => m.key === 'lightness');
  const onlyStyle = grade !== 'good' && separation.status === 'ok' && lightness.status === 'ok';

  let summary;
  if (grade === 'good') {
    summary = 'Every piece reads separately, for you as well as for anyone looking.';
  } else if (separation.status === 'fail') {
    summary = 'Two of these are the same colour to a ' + cvdLabel(cvdType) + '.';
  } else if (lightness.status === 'fail') {
    summary = 'These sit at almost the same lightness, so the pieces read as one block ' +
      '-- that is true for everyone, not just for a ' + cvdLabel(cvdType) + '.';
  } else if (onlyStyle) {
    summary = 'The pieces come apart cleanly. What holds it back is a style convention, not a legibility problem.';
  } else {
    summary = 'The pieces come apart, but with less to spare than you would want.';
  }

  return { grade, gradeLabel: GRADE_LABEL[grade], measured, style, pairs, summary, swatches };
}

function cvdLabel(cvdType) {
  return { protanopia: 'protan', deuteranopia: 'deutan', tritanopia: 'tritan' }[cvdType] || 'simulated viewer';
}

export { JND, COMFORTABLE, GRADE_LABEL };
