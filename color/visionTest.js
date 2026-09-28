// ---------------------------------------------------------------------------
// Project Chroma - self-report vision test
//
// WHAT THIS IS NOT
//
// It is not a psychophysical test. It does not measure anything. A real
// pseudo-isochromatic plate is calibrated against measured confusion data from
// human observers, and reproducing that calibration is a research project, not
// a feature. Plates generated from a colour-vision *simulation* would be
// measuring the simulation, not the person, and a user acting on the result
// would be trusting a model this codebase already documents as approximate --
// and as wrong for tritanopia outright.
//
// There is a further reason it cannot work as intended. Under this model a
// protan and a deutan see the same stimulus against the same background:
//     olive #7A7A4A -> protan #323211, deutan #323211
// Identical. So the classic "one colour invisible to protan, visible to
// deutan" plate is not merely unavailable, it is impossible here. The real
// Ishihara plates 26/29 work by a different mechanism entirely -- two colours
// whose protan ordering differs from their deutan ordering -- and that needs
// measured data we do not have.
//
// WHAT THIS IS
//
// A structured way for someone to tell us what they can and cannot
// distinguish. We show colour pairs chosen because the simulation predicts a
// particular deficiency should degrade them, and we ask the user to judge.
// Nothing is measured; everything is reported. The output is a *suggestion*
// with a confidence, always overridable from the dropdown.
//
// That is a weaker claim than "detected", and it is an honest one. For most
// people "which of these two greens can you tell apart" is easier to answer
// reliably than any plate, and the answer is the thing we actually need.
// ---------------------------------------------------------------------------

import { deltaEOk } from './discriminability.js';
import { simulateColor } from './dichromat.js';

const hexToRgb = (h) => {
  const n = parseInt(String(h).slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

// --- Probes ---------------------------------------------------------------
//
// Each probe is a pair plus the answer we expect from each kind of observer.
// "expects" is what the simulation predicts, not a claim about the person --
// which is exactly why the result is a suggestion.

const PROBES = [
  {
    id: 'red-green',
    a: '#C0392B', b: '#2E7D32',
    question: 'Can you tell these two apart?',
    note: 'A red and a green at the same brightness.',
    expect: { normal: 'yes', protanopia: 'no', deuteranopia: 'no', tritanopia: 'yes' }
  },
  {
    id: 'blue-purple',
    a: '#1E5AA8', b: '#7B3FA0',
    question: 'Can you tell these two apart?',
    note: 'A blue and a purple of similar brightness.',
    expect: { normal: 'yes', protanopia: 'no', deuteranopia: 'no', tritanopia: 'yes' }
  },
  {
    id: 'teal-blue',
    a: '#137A76', b: '#1B5FA8',
    question: 'Can you tell these two apart?',
    note: 'A teal and a blue.',
    expect: { normal: 'yes', protanopia: 'yes', deuteranopia: 'yes', tritanopia: 'no' }
  },
  {
    id: 'green-brown',
    a: '#4C7A3A', b: '#6B5330',
    question: 'Can you tell these two apart?',
    note: 'A green and a brown of similar brightness.',
    expect: { normal: 'yes', protanopia: 'no', deuteranopia: 'no', tritanopia: 'yes' }
  },
  {
    id: 'green-green',
    a: '#3E8E4A', b: '#8FAE3E',
    question: 'Can you tell these two apart?',
    note: 'Two greens that differ only slightly.',
    expect: { normal: 'yes', protanopia: 'maybe', deuteranopia: 'maybe', tritanopia: 'yes' }
  }
];

export const PROBE_COUNT = PROBES.length;

export function getProbe(index) {
  const p = PROBES[index];
  if (!p) return null;
  return {
    id: p.id, a: p.a, b: p.b,
    question: p.question, note: p.note
  };
}

// How hard the simulation thinks each pair is for each kind of observer. Shown
// to nobody, but asserted in the tests so a probe cannot silently stop being
// diagnostic after a change to the engine.
export function probeDiagnostics(index) {
  const p = PROBES[index];
  if (!p) return null;
  const a = hexToRgb(p.a), b = hexToRgb(p.b);
  const out = { normal: deltaEOk(a, b) };
  for (const t of ['protanopia', 'deuteranopia', 'tritanopia']) {
    out[t] = deltaEOk(simulateColor(a, t), simulateColor(b, t));
  }
  return out;
}

// --- Scoring --------------------------------------------------------------

// Turns a set of yes/no/maybe answers into a suggestion.
//
// The scoring is deliberately blunt and deliberately low-stakes. Every type
// gets a running tally of agreements, and the highest wins. Ties resolve to
// "no confident answer" rather than to a default, because guessing here would
// be the one genuinely harmful thing this feature could do.
export function scoreAnswers(answers) {
  const tallies = { protanopia: 0, deuteranopia: 0, tritanopia: 0, normal: 0 };
  let answered = 0;

  PROBES.forEach((p, i) => {
    const given = answers[i];
    if (given !== 'yes' && given !== 'no' && given !== 'maybe') return;
    answered++;
    for (const [type, expected] of Object.entries(p.expect)) {
      if (expected === 'maybe') {
        // A "maybe" agrees with anyone the simulation says is marginal, and
        // counts against a confident "yes".
        if (given === 'maybe') tallies[type] += 1;
        else if (given === 'yes') tallies[type] -= 1;
        continue;
      }
      if (given === expected) tallies[type] += 1;
      else if (given === 'maybe') tallies[type] += 0.5;
    }
  });

  if (answered < 2) {
    return {
      cvdType: null, confidence: 'none', tallies, answered,
      summary: 'Not enough answers to say anything useful.'
    };
  }

  const ranked = Object.entries(tallies).sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0];
  const runnerUp = ranked[1][1];

  // Protanopia and deuteranopia are not separable by the questions we ask.
  // Saying so is more useful than picking one at random.
  const ambiguous = (topType === 'protanopia' || topType === 'deuteranopia') &&
    tallies.protanopia === tallies.deuteranopia;

  if (ambiguous) {
    return {
      cvdType: null, confidence: 'partial', tallies, answered,
      redGreen: true,
      summary: 'Your answers point to a red–green deficiency, but these ' +
        'questions cannot separate protan from deutan. Pick the closer one ' +
        'below — the difference is small.'
    };
  }

  const margin = topScore - runnerUp;
  const confidence = topScore <= 0 ? 'low' : margin >= 2 ? 'good' : 'partial';

  if (topType === 'normal') {
    return {
      cvdType: null, confidence, tallies, answered,
      summary: 'You distinguished every pair. Either your colour vision is ' +
        'normal, or you are unusually good at this particular task. ' +
        'If you know you have a deficiency, choose it below.'
    };
  }

  const LABEL = { protanopia: 'Protan', deuteranopia: 'Deutan', tritanopia: 'Tritan' };
  return {
    cvdType: topType,
    confidence,
    tallies,
    answered,
    redGreen: topType !== 'tritanopia',
    summary: `Your answers look most like ${LABEL[topType]}. ` +
      `This is a suggestion from what you reported, not a measurement — ` +
      `check it below, and change it if it does not match your experience.`
  };
}

// Maps a result to a starting gain.
//
// Deliberately mid-range. Without a measurement there is no basis for a
// confident number, and guessing high would give a filter stronger than the
// user asked for. They can move the slider.
export function suggestedGain(result) {
  if (!result) return 0.7;
  // The ambiguous red-green case is the common one: cvdType is null because
  // we declined to choose between protan and deutan, but we do know it is a
  // red-green deficiency. Gating on cvdType threw that away and handed back
  // the neutral default instead of the red-green starting point.
  if (result.cvdType === 'tritanopia' || result.redGreen === false) return 0.6;
  if (result.redGreen) return 0.75;
  return 0.7;
}

export { rgbToHex, hexToRgb };
