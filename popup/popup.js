import { calculateCadGain } from '../color/gainMapping.js';
import { assessSet, assessPair, rgbToHex } from '../color/discriminability.js';
import { getProbe, scoreAnswers, suggestedGain, PROBE_COUNT } from '../color/visionTest.js';
import { gradeCombination } from '../color/outfit.js';

// Signals popup/boot-guard.js that the UI wired up successfully.
window.__chromaBooted = true;

// This file is an ES module, so it is deferred: it executes after the document
// is parsed, but whether DOMContentLoaded has already fired by then is not
// guaranteed across every Chrome version and popup lifecycle. Listening
// unconditionally means that if the event has already gone by, this handler
// never runs and the entire popup is inert with no visible symptom.
// Checking readyState covers both orderings.
function whenReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

whenReady(() => {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const statusText = document.getElementById('statusText');
  const severitySlider = document.getElementById('severitySlider');
  const severityVal = document.getElementById('severityVal');

  const intakeView = document.getElementById('intakeView');
  const confirmView = document.getElementById('confirmView');
  const typeSelect = document.getElementById('typeSelect');
  const fieldThreshold = document.getElementById('fieldThreshold');
  const fieldChannels = document.getElementById('fieldChannels');
  const channelsRow = document.getElementById('channelsRow');
  const fieldPlate = document.getElementById('fieldPlate');
  const fieldExcess = document.getElementById('fieldExcess');
  const fieldSource = document.getElementById('fieldSource');
  const fieldMatrix = document.getElementById('fieldMatrix');
  const confirmWarn = document.getElementById('confirmWarn');
  const confirmSlider = document.getElementById('confirmSlider');
  const confirmGainVal = document.getElementById('confirmGainVal');
  const confirmBtn = document.getElementById('confirmBtn');
  const cancelBtn = document.getElementById('cancelBtn');

  const twinToggle = document.getElementById('twinToggle');
  const twinDesc = document.getElementById('twinDesc');
  const lensNote = document.getElementById('lensNote');
  const lensRadius = document.getElementById('lensRadius');
  const lensRadiusVal = document.getElementById('lensRadiusVal');
  const segThumb = document.getElementById('segThumb');
  const plateRow = document.getElementById('plateRow');
  const warnText = confirmWarn.querySelector('span');

  // Added in the interface pass.
  const enableToggle = document.getElementById('enableToggle');
  const presetSelect = document.getElementById('presetSelect');
  const severityBadge = document.getElementById('severityBadge');
  const confirmBadge = document.getElementById('confirmBadge');
  const detailsHint = document.getElementById('detailsHint');

  // Vision check.
  const visionTestBtn = document.getElementById('visionTestBtn');
  const visionTestPanel = document.getElementById('visionTestPanel');
  const visionTestBody = document.getElementById('visionTestBody');
  const visionTestStatus = document.getElementById('visionTestStatus');
  const visionTestDone = document.getElementById('visionTestDone');
  const visionTestClose = document.getElementById('visionTestClose');
  const visionResultCard = document.getElementById('visionResultCard');
  const visionResultTitle = document.getElementById('visionResultTitle');
  const visionResultSub = document.getElementById('visionResultSub');
  const visionChoiceSlot = document.getElementById('visionChoiceSlot');

  // Lens, reachable from the intake screen.
  const lensToggle = document.getElementById('lensToggle');
  const lensHint = document.getElementById('lensHint');
  const lensRadiusWrap = document.getElementById('lensRadiusWrap');
  const lensRadius2 = document.getElementById('lensRadius2');
  const lensRadiusVal2 = document.getElementById('lensRadiusVal2');

  // Clothing combination grading.
  const outfitSwatches = document.getElementById('outfitSwatches');
  const outfitQuick = document.getElementById('outfitQuick');
  const outfitHex = document.getElementById('outfitHex');
  const outfitAdd = document.getElementById('outfitAdd');
  const outfitStatus = document.getElementById('outfitStatus');
  const outfitResult = document.getElementById('outfitResult');
  const outfitGrade = document.getElementById('outfitGrade');
  const outfitAs = document.getElementById('outfitAs');
  const outfitSummary = document.getElementById('outfitSummary');
  const outfitMeasured = document.getElementById('outfitMeasured');
  const outfitStyle = document.getElementById('outfitStyle');

  // Common garment colours, so nobody has to know a hex code to try this.
  const GARMENT_SWATCHES = [
    ["#FFFFFF", "White"], ["#F0EADB", "Cream"], ["#C9C4BC", "Light grey"],
    ["#6E6A66", "Grey"], ["#1C1A19", "Black"], ["#1B2A4A", "Navy"],
    ["#3E6BA8", "Denim"], ["#14504A", "Teal"], ["#2E5D3A", "Forest green"],
    ["#8A5A2B", "Tan"], ["#5A3A22", "Brown"], ["#6B2D2D", "Burgundy"],
    ["#B03030", "Red"], ["#B5762A", "Rust"], ["#C9A227", "Mustard"],
    ["#D9A0A8", "Blush"], ["#7B6BA8", "Lavender"], ["#4A5568", "Slate"]
  ];

  // Primary power control.
  const powerCard = document.getElementById('powerCard');
  const powerLabel = document.getElementById('powerLabel');
  const powerSub = document.getElementById('powerSub');

  // Colour audit panel.
  const auditBtn = document.getElementById('auditBtn');
  const auditPanel = document.getElementById('auditPanel');
  const auditStatus = document.getElementById('auditStatus');
  const auditList = document.getElementById('auditList');
  const auditType = document.getElementById('auditType');
  const auditClose = document.getElementById('auditClose');

  let currentType = 'protanopia';
  let pending = null;   // parsed fields awaiting confirmation
  let previewMode = 'corrected';
  // Where the gain currently on the slider came from, so the operator can tell
  // a playbook-derived value from one they set by hand.
  let gainSourceLabel = 'manual';
  // The SN reading from the report, retained so the curve can be re-applied and
  // so a manual override can be fed back through calculateCadGain.
  let parsedSN = null;
  // Deficiency and confidence in force right now. Tracked separately from the
  // select element because the notice copy has to react to a type the operator
  // changed by hand, not only to the one the parser produced.
  let activeType = 'protanopia';
  let activeConfidence = 'low';
  // Two flags rather than one, because they answer different questions.
  //
  // storedProfile  is re-read from storage every time the card is shown, so it
  //                can always be corrected. A preset is NOT written to storage
  //                until Confirm, so storage alone left the card claiming
  //                there was nothing to review right after one was chosen.
  // pendingProfile is a user action in this session and is not persisted.
  //
  // Kept separate rather than merged into one flag because a single merged
  // flag can only ever go false -> true, so it would keep claiming a profile
  // exists after the underlying profile was gone.
  let storedProfile = false;
  let pendingProfile = false;
  const profileAvailable = () => storedProfile || pendingProfile;

  const MODE_DESC = {
    original: 'The page exactly as authored — no correction at all.',
    simulated: 'What the dichromat actually perceives. The gain slider does not affect this view.',
    corrected: 'Your recalibrated profile across the whole page. Not saved until you confirm.',
    spotlight: 'A lens that corrects only the area under your cursor. Hover it to read the colour.'
  };

  // --- Severity vocabulary -----------------------------------------------
  //
  // A bare 0.75 tells an operator nothing actionable. These bands give the
  // number a name, and the boundaries are set so the labels read naturally at
  // the values the interface advertises: 0.25 Mild, 0.50 Moderate, 0.75 Severe,
  // 1.00 Complete.
  const SEVERITY_BANDS = [
    { max: 0.15, label: 'Minimal' },
    { max: 0.375, label: 'Mild' },
    { max: 0.625, label: 'Moderate' },
    { max: 0.875, label: 'Severe' },
    { max: Infinity, label: 'Complete' }
  ];

  function severityLabel(gain) {
    const g = Number(gain);
    if (!Number.isFinite(g)) return 'Unknown';
    for (const band of SEVERITY_BANDS) {
      if (g < band.max) return band.label;
    }
    return 'Complete';
  }

  function setBadges(gain) {
    const label = severityLabel(gain);
    if (severityBadge) severityBadge.textContent = label;
    if (confirmBadge) confirmBadge.textContent = label;
  }

  // --- Presets ------------------------------------------------------------
  //
  // Gains are derived through the same curve the report path uses rather than
  // typed in as literals, so a preset and a report describing the same severity
  // land on the same number. The SN values are the CAD standard-normal readings
  // the playbook is calibrated against.
  const PRESETS = [
    { id: 'mild-protan', label: 'Mild Protan', cvdType: 'protanopia', sn: 3.0 },
    { id: 'mod-protan', label: 'Moderate Protan', cvdType: 'protanopia', sn: 6.0 },
    { id: 'sev-protan', label: 'Severe Protan', cvdType: 'protanopia', sn: 9.0 },
    { id: 'sev-deutan', label: 'Severe Deutan', cvdType: 'deuteranopia', sn: 9.0 },
    { id: 'tritan', label: 'Tritan (approximate)', cvdType: 'tritanopia', sn: 6.0 }
  ];

  function buildPresets() {
    if (!presetSelect) return;
    PRESETS.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      opt.dataset.gain = String(calculateCadGain(p.sn));
      presetSelect.appendChild(opt);
    });
  }

  function loadScriptOnce(path) {
    const url = chrome.runtime.getURL(path);
    if (document.querySelector(`script[data-chroma-src="${path}"]`)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.dataset.chromaSrc = path;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${path}`));
      document.head.appendChild(script);
    });
  }

  // Leaving the confirmation screen must undo any throwaway preview, otherwise
  // Cancel would leave the page stuck in a simulated state.
  function showIntake() {
    confirmView.hidden = true;
    intakeView.hidden = false;
    pending = null;
    setPreviewMode('corrected', true);
    // The power card is only visible on this screen, and its helper copy
    // depends on whether a profile exists yet -- which changes when a report
    // is uploaded or a preset is picked. Re-reading storage here keeps the
    // card honest at the moment it is actually on screen, rather than showing
    // whatever was true when the popup opened.
    syncToggle();
    chrome.runtime.sendMessage({ type: 'RESTORE_PREVIEW' }).catch(() => {});
  }

  function setPreviewMode(mode, silent) {
    previewMode = mode;

    const order = [...twinToggle.querySelectorAll('button')];
    order.forEach((btn, i) => {
      const on = btn.dataset.mode === mode;
      btn.setAttribute('aria-pressed', String(on));
      if (on) segThumb.style.setProperty('--i', i);
    });
    twinDesc.textContent = MODE_DESC[mode];
    lensNote.hidden = mode !== 'spotlight';
    if (typeof renderLensCard === 'function') renderLensCard();

    if (silent) return;
    chrome.runtime.sendMessage({
      type: 'PREVIEW_MODE',
      mode,
      cvdType: typeSelect.value,
      gain: parseFloat(confirmSlider.value),
      radius: parseInt(lensRadius.value, 10)
    }).catch(err => console.error('Chroma: preview mode failed', err));
  }

  // One radius, two sliders.
  //
  // The review screen has had a radius control all along; the intake card
  // added a second. Two independent inputs would be two sources of truth that
  // drift apart, so both write into lensRadius -- the value setPreviewMode
  // actually sends -- and mirror each other from there.
  function applyRadius(value) {
    const v = Math.min(400, Math.max(40, parseInt(value, 10) || 120));
    lensRadius.value = String(v);
    lensRadiusVal.textContent = String(v);
    if (lensRadius2) lensRadius2.value = String(v);
    if (lensRadiusVal2) lensRadiusVal2.textContent = String(v);
    if (previewMode === 'spotlight') setPreviewMode('spotlight', false);
  }

  lensRadius.addEventListener('input', () => applyRadius(lensRadius.value));
  if (lensRadius2) lensRadius2.addEventListener('input', () => applyRadius(lensRadius2.value));

  // Mirror the slider positions on load so the two never start out disagreeing.
  applyRadius(lensRadius.value);

  // The lens is a tool, not part of the correction, so it has to be reachable
  // without configuring a profile and confirming it first. This drives the same
  // PREVIEW_MODE message the review screen's segmented control does, so the
  // page state stays single-valued whichever one is used.
  function renderLensCard() {
    const on = previewMode === 'spotlight';
    if (lensToggle) lensToggle.textContent = on ? 'Close the lens' : 'Open the lens';
    if (lensHint) lensHint.hidden = on;
    if (lensRadiusWrap) lensRadiusWrap.hidden = !on;
  }

  if (lensToggle) {
    lensToggle.addEventListener('click', () => {
      setPreviewMode(previewMode === 'spotlight' ? 'corrected' : 'spotlight', false);
    });
  }

  // --- Clothing combination ------------------------------------------------
  //
  // A red top and a green skirt are the case this exists for. They are two
  // colours to most people and very nearly one to a protan or deutan, and
  // nothing on a shop page is going to tell you that.
  //
  // Session-scoped like the vision check result. These describe what someone
  // is wearing today, so carrying them across a browser restart would be
  // actively wrong.
  let outfitColors = [];

  function renderOutfit() {
    if (!outfitSwatches) return;

    outfitSwatches.innerHTML = '';
    for (const hex of outfitColors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = hex;
      b.setAttribute('aria-label', 'Remove ' + hex);
      b.title = hex;

      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '\u00d7';
      b.appendChild(x);

      b.addEventListener('click', () => {
        outfitColors = outfitColors.filter((c) => c !== hex);
        sessionWrite({ chromaOutfit: outfitColors });
        renderOutfit();
      });
      outfitSwatches.appendChild(b);
    }

    if (outfitResult) outfitResult.hidden = outfitColors.length < 2;
    if (outfitStatus) {
      // Only exactly one colour is worth a prompt. Zero means the user has not
      // started, and two or more means there is a grade to read instead.
      if (outfitColors.length === 1) {
        outfitStatus.hidden = false;
        outfitStatus.textContent = 'Add another colour to see a grade.';
      } else {
        outfitStatus.hidden = true;
      }
    }
    if (outfitColors.length >= 2) gradeOutfit();
  }

  function gradeOutfit() {
    if (!outfitResult) return;
    // Graded for the type the user actually has, not a guessed one.
    const type = typeSelect.value || 'deuteranopia';
    const r = gradeCombination(outfitColors, type);

    if (outfitStatus) outfitStatus.hidden = true;
    if (outfitGrade) {
      outfitGrade.className = 'grade ' + r.grade;
      outfitGrade.textContent = r.gradeLabel;
    }
    if (outfitAs) {
      outfitAs.textContent = 'graded for ' + type;
    }
    if (outfitSummary) outfitSummary.textContent = r.summary;

    const fill = (el, list) => {
      if (!el) return;
      el.innerHTML = '';
      for (const f of list) {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot ' + f.status;
        li.appendChild(dot);
        const body = document.createElement('span');
        const b = document.createElement('b');
        b.textContent = f.label + '. ';
        body.appendChild(b);
        body.appendChild(document.createTextNode(f.detail));
        li.appendChild(body);
        el.appendChild(li);
      }
    };
    fill(outfitMeasured, r.measured);
    fill(outfitStyle, r.style);
  }

  function addOutfitColor(raw) {
    if (!outfitStatus) return;
    let hex = String(raw || '').trim().toUpperCase();
    if (!hex) return;
    if (hex[0] !== '#') hex = '#' + hex;
    if (!/^#[0-9A-F]{6}$/.test(hex)) {
      if (/^#[0-9A-F]{3}$/.test(hex)) {
        hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
      } else {
        outfitStatus.hidden = false;
        outfitStatus.textContent = 'That is not a hex colour. Try #1B2A4A.';
        return;
      }
    }
    if (outfitColors.length >= 8) {
      outfitStatus.hidden = false;
      outfitStatus.textContent = 'Eight is plenty. Remove one before adding another.';
      return;
    }
    outfitColors.push(hex);
    sessionWrite({ chromaOutfit: outfitColors });
    if (outfitHex) outfitHex.value = '';
    renderOutfit();
  }

  if (outfitQuick) {
    for (const pair of GARMENT_SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = pair[0];
      b.title = pair[1];
      b.setAttribute('aria-label', 'Add ' + pair[1]);
      b.addEventListener('click', () => addOutfitColor(pair[0]));
      outfitQuick.appendChild(b);
    }
  }

  if (outfitAdd) outfitAdd.addEventListener('click', () => addOutfitColor(outfitHex ? outfitHex.value : ''));
  if (outfitHex) {
    outfitHex.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addOutfitColor(outfitHex.value);
    });
  }

  // Re-grade when the vision type changes; the whole answer depends on it.
  if (typeSelect) typeSelect.addEventListener('change', () => { if (outfitColors.length >= 2) gradeOutfit(); });

  sessionRead(['chromaOutfit'], (r) => {
    const stored = r && r.chromaOutfit;
    if (Array.isArray(stored) && stored.length) outfitColors = stored.slice();
    renderOutfit();
  });

  // --- Notice -------------------------------------------------------------
  //
  // Context-aware rather than one joined string. The two cases an operator can
  // act on -- "we are unsure of the type" and "this type is only approximate" --
  // are separated, and the trit note is deliberately calm: it is a known limit
  // of the model, not something the operator did wrong.
  function renderNotices(confidence) {
    const lines = [];

    if (confidence === 'low') {
      lines.push({
        text: "We couldn't confirm the exact type from the report. " +
              'Please double-check the selected deficiency before activating.',
        tone: 'warn'
      });
    }

    if (activeType === 'tritanopia') {
      lines.push({
        text: 'Tritanopia uses a single-plane approximation rather than the two-plane ' +
              'model it really needs, so results are indicative rather than calibrated. ' +
              'Protan and Deutan are fully modelled.',
        tone: 'info'
      });
    }

    // Anything the parser raised that is not one of the two above.
    if (pending && Array.isArray(pending.warnings)) {
      for (const w of pending.warnings) {
        if (/Tritanopia is simulated approximately/.test(w)) continue;
        if (/No unambiguous deficiency classification/.test(w)) continue;
        lines.push({ text: w, tone: 'warn' });
      }
    }

    if (!lines.length) {
      confirmWarn.hidden = true;
      return;
    }

    const body = confirmWarn.querySelector('.notice-body');
    body.innerHTML = '';
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line.text;
      body.appendChild(p);
    }
    // A single advisory reads as information; an unresolved type is a warning.
    confirmWarn.classList.toggle('info', lines.every((l) => l.tone === 'info'));
    confirmWarn.hidden = false;
  }

  // Renders the parsed fields and asks the engine for a preview of the exact
  // matrix that Confirm would apply. PREVIEW_MATRIX applies nothing.
  async function showConfirm(parsed) {
    pending = parsed;

    activeType = parsed.cvdType;
    activeConfidence = parsed.typeConfidence;

    typeSelect.value = parsed.cvdType;
    gainSourceLabel = parsed.gainSource || 'manual';
    parsedSN = parsed.sn;
    confirmSlider.value = parsed.gain !== null ? parsed.gain : parseFloat(severitySlider.value);
    confirmGainVal.textContent = parseFloat(confirmSlider.value).toFixed(3);
    setBadges(confirmSlider.value);

    // The details hint is how a hidden section advertises that it has
    // something in it. Without it, "Clinical details" looks like chrome.
    // Keyed on the source rather than on whether numbers exist, because a
    // preset carries a synthetic SN and would otherwise claim to be
    // "from report" when no report was ever opened.
    if (detailsHint) {
      const src = String(parsed.gainSource || '');
      if (src.startsWith('preset')) detailsHint.textContent = 'from preset';
      else if (parsed.threshold || parsed.scoredGain !== null) detailsHint.textContent = 'from report';
      else detailsHint.textContent = 'nothing parsed';
    }

    if (parsed.threshold) {
      fieldThreshold.classList.remove('empty');
      fieldThreshold.innerHTML = `${parsed.threshold.value} <small>${parsed.threshold.unit}</small>`;
    } else {
      fieldThreshold.classList.add('empty');
      fieldThreshold.textContent = 'Not reported';
    }

    // Two-channel reports need both readings visible, otherwise the operator
    // cannot see that a secondary axis was left uncorrected.
    const ch = parsed.channels || {};
    const chKeys = Object.keys(ch);
    if (chKeys.length > 1) {
      channelsRow.hidden = false;
      fieldChannels.innerHTML = chKeys
        .map(k => `${k} ${ch[k]}<small>SN${parsed.mixed ? ' elevated' : ''}</small>`)
        .join('<br>');
    } else {
      channelsRow.hidden = true;
    }

    plateRow.hidden = !parsed.plateClass;
    fieldPlate.innerHTML = parsed.plateClass || '';

    if (parsed.excess !== null && parsed.excess !== undefined) {
      fieldExcess.classList.remove('empty');
      fieldExcess.innerHTML = `${parsed.excess.toFixed(1)} <small>SN over 1.0</small>`;
    } else {
      fieldExcess.classList.add('empty');
      fieldExcess.textContent = 'No threshold';
    }

    // Source and confidence are two different facts, so showing both is
    // right -- but a preset names itself in both fields, and the old code
    // printed "preset · Moderate Protan · Preset". Dedupe the tail.
    const confidence = String(parsed.typeConfidence || 'low');
    const confidenceText = confidence.charAt(0).toUpperCase() + confidence.slice(1);
    const src = String(parsed.gainSource || 'manual');
    const parts = src.toLowerCase().includes(confidence.toLowerCase())
      ? [src]
      : [src, confidenceText];
    fieldSource.innerHTML = `<small>${parts.join(' · ')}</small>`;

    renderNotices(activeConfidence);

    intakeView.hidden = true;
    confirmView.hidden = false;

    // Enter the screen with the page clean. The correction is NOT live yet --
    // confirming is what turns it on, which is the whole point of this screen.
    setPreviewMode('original', true);
    await refreshPreview();
  }

  async function refreshPreview() {
    const gain = parseFloat(confirmSlider.value);
    confirmGainVal.textContent = Number.isFinite(gain) ? gain.toFixed(3) : '—';
    setBadges(gain);

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'PREVIEW_MATRIX',
        payload: { cvdType: typeSelect.value, severity: gain }
      });
      if (res && res.status === 'Preview') {
        fieldMatrix.innerHTML = `${res.matrix.length} values <small>ready</small>`;
        confirmBtn.disabled = false;
      } else {
        fieldMatrix.innerHTML = `<small>${res && res.error ? res.error : 'unavailable'}</small>`;
        confirmBtn.disabled = true;
      }
    } catch (err) {
      console.error('Chroma: preview unreachable', err);
      fieldMatrix.innerHTML = '<small>engine unreachable</small>';
      confirmBtn.disabled = true;
    }

    // Re-apply whichever state is being shown, so the page tracks the slider.
    setPreviewMode(previewMode, false);
  }

  typeSelect.addEventListener('change', () => {
    currentType = typeSelect.value;
    activeType = typeSelect.value;
    renderNotices(activeConfidence);
    refreshPreview();
  });

  twinToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) setPreviewMode(btn.dataset.mode, false);
  });

  confirmSlider.addEventListener('input', () => {
    // Operator override: pushed through the module's manualOverride path so
    // the same clamping rules apply as to a derived value.
    const overridden = calculateCadGain(parsedSN, confirmSlider.value);
    confirmSlider.value = overridden;
    gainSourceLabel = 'manual';
    refreshPreview();
  });

  cancelBtn.addEventListener('click', showIntake);

  confirmBtn.addEventListener('click', () => {
    currentType = typeSelect.value;
    severitySlider.value = confirmSlider.value;
    severityVal.textContent = parseFloat(confirmSlider.value).toFixed(2);
    setBadges(confirmSlider.value);
    // Whatever was on screen, Confirm always commits the corrected profile --
    // a simulated preview must never be what gets saved.
    setPreviewMode('corrected', true);
    sendUpdate(currentType, parseFloat(confirmSlider.value)).then(() => {
      // Turning the filter on is the point of confirming, so the global switch
      // follows rather than leaving the user with a saved profile that is
      // silently not applied.
      if (enableToggle && !enableToggle.checked) {
        enableToggle.checked = true;
        chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: true }).catch(() => {});
      }
      renderPower(true, true);
      showIntake();
    });
  });

  function sendUpdate(cvdType, severity) {
    severityVal.textContent = severity.toFixed(2);
    setBadges(severity);

    return chrome.runtime.sendMessage({
      type: 'PROCESS_REPORT',
      payload: {
        cvdType: cvdType || currentType,
        severity: severity
      }
    }).then(response => {
      if (response && response.status === 'Processing') {
        // Echo what the engine actually produced, so a mis-parsed report is
        // visible instead of silently applying the wrong filter.
        statusText.textContent =
          `${response.cvdType.replace('opia', '')} applied · gain ${response.gain.toFixed(2)}`;
      } else if (response && response.status === 'Error') {
        statusText.textContent = `Engine error: ${response.error}`;
      }
      return response;
    }).catch(err => {
      console.error('Chroma: engine unreachable', err);
      statusText.textContent = 'Engine unreachable — reopen the extension';
    });
  }

  // --- Vision check --------------------------------------------------------
  //
  // Five questions, no right answers. This is a structured way for someone to
  // tell us what they can and cannot distinguish -- it measures nothing, and
  // the result is a suggestion with a confidence, never an override.
  //
  // A real pseudo-isochromatic plate would be better science, and it is
  // deliberately not attempted here: those plates are calibrated against
  // measured human confusion data, and plates derived from a simulation would
  // be measuring the simulation. See the header of color/visionTest.js.
  //
  // Stored in chrome.storage.session, not local. Session storage is dropped
  // when the browser closes and when the extension is reloaded or updated,
  // which is exactly "remembered until the extension is refreshed". Writing to
  // local would leave a stale, possibly wrong, diagnosis sitting on disk
  // indefinitely -- the opposite of what this is for.
  const VISION_KEY = 'chromaVisionResult';

  // chrome.storage.session returns a promise under MV3, but the API is absent
  // entirely on Chrome older than 102 and a storage failure must never be able
  // to abort the flow that called it. Both helpers therefore tolerate a
  // missing API, a callback-style return, or a rejected promise.
  function sessionWrite(obj) {
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      const r = chrome.storage.session.set(obj);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* nothing to do: the result is a convenience, not state */ }
  }

  function sessionRead(keys, cb) {
    try {
      if (!chrome.storage || !chrome.storage.session) return cb({});
      const r = chrome.storage.session.get(keys, cb);
      if (r && typeof r.catch === 'function') r.catch(() => cb({}));
    } catch (e) { cb({}); }
  }
  let visionAnswers = new Array(PROBE_COUNT).fill(null);
  let visionResult = null;
  // Set only when the check narrowed things to "red-green" but declined to
  // split protan from deutan, and the user picks one here. Empty string means
  // they have not chosen yet, which is why the apply button stays off.
  let visionChosenType = '';

  function renderProbe(index) {
    const p = getProbe(index);
    if (!p || !visionTestBody) return;

    visionTestBody.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'probe';

    // Five questions with no counter reads as an endless form.
    const head = document.createElement('div');
    head.className = 'probe-count';
    const answered = visionAnswers.filter((a) => a).length;
    head.textContent = 'Question ' + (index + 1) + ' of ' + PROBE_COUNT +
      (answered > 0 ? '  ·  ' + answered + ' answered' : '');
    wrap.appendChild(head);

    const q = document.createElement('div');
    q.className = 'probe-q';
    q.textContent = p.note;
    wrap.appendChild(q);

    const pair = document.createElement('div');
    pair.className = 'probe-pair';
    for (const hex of [p.a, p.b]) {
      const chip = document.createElement('span');
      chip.className = 'probe-chip';
      chip.style.background = hex;
      pair.appendChild(chip);
    }
    const qm = document.createElement('span');
    qm.className = 'probe-qs';
    qm.textContent = '?';
    pair.appendChild(qm);
    wrap.appendChild(pair);

    const opts = document.createElement('div');
    opts.className = 'probe-opts';
    for (const [val, label] of [['yes', 'Yes'], ['maybe', 'Hard to say'], ['no', 'No']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(visionAnswers[index] === val));
      b.addEventListener('click', () => {
        visionAnswers[index] = val;
        renderProbe(index);
        // The result is derived state, so it is shown as it forms rather than
        // being held back behind a button. The previous version made the user
        // press something just to see what they had already answered.
        refreshVisionPreview();
      });
      opts.appendChild(b);
    }
    wrap.appendChild(opts);
    visionTestBody.appendChild(wrap);

    const nav = document.createElement('div');
    nav.className = 'probe-nav';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = 'Back';
    prev.disabled = index === 0;
    if (prev.disabled) prev.style.opacity = '0.4';
    prev.addEventListener('click', () => { renderProbe(Math.max(0, index - 1)); });
    const next = document.createElement('button');
    next.type = 'button';
    // Navigation only. This used to read "Finish" on the last probe and call
    // the same function as the panel's own button, so there were two identical
    // controls doing the same thing in the same panel.
    next.textContent = index === PROBE_COUNT - 1 ? 'Next' : 'Next';
    next.addEventListener('click', () => {
      if (index < PROBE_COUNT - 1) renderProbe(index + 1);
    });
    nav.appendChild(prev);
    nav.appendChild(next);
    visionTestBody.appendChild(nav);
  }

  function startVisionTest() {
    visionAnswers = new Array(PROBE_COUNT).fill(null);
    visionResult = null;
    visionChosenType = '';
    if (visionChoiceSlot) visionChoiceSlot.innerHTML = '';
    if (visionTestPanel) visionTestPanel.hidden = false;
    if (visionResultCard) visionResultCard.hidden = true;
    if (visionTestDone) { visionTestDone.disabled = true; visionTestDone.textContent = 'Apply to my profile'; }
    if (visionTestStatus) {
      visionTestStatus.textContent = 'Answer what you can actually see. There are no wrong answers.';
    }
    renderProbe(0);
  }

  const TYPE_LABEL = { protanopia: 'Protan', deuteranopia: 'Deutan', tritanopia: 'Tritan' };

  // What the button can act on.
  //
  // cvdType alone is too strict a gate. Red-green deficiency is by far the most
  // common case, and scoreAnswers deliberately refuses to split protan from
  // deutan -- so gating on cvdType left the majority of users staring at a
  // permanently dead button after answering every question. When we know the
  // *direction* is red-green but not which cone, the user's own choice from the
  // dropdown is the authority, and the button carries that through.
  const visionApplies = () =>
    !!visionResult &&
    (!!visionResult.cvdType ||
     (visionResult.redGreen === true && !!visionChosenType));

  function showVisionResult() {
    if (!visionResultCard || !visionResultTitle || !visionResultSub) return;
    if (!visionResult) { visionResultCard.hidden = true; return; }
    visionResultCard.hidden = false;
    visionResultTitle.textContent = visionResult.cvdType
      ? 'Suggested: ' + TYPE_LABEL[visionResult.cvdType]
      : (visionResult.redGreen ? 'Red–green, not split' : 'Not conclusive');
    visionResultSub.textContent = visionResult.summary;

    renderVisionChoice();

    if (visionTestDone) {
      const usable = visionApplies();
      visionTestDone.disabled = !usable;
      visionTestDone.textContent = usable
        ? 'Apply to my profile'
        : (visionResult.redGreen ? 'Choose protan or deutan first' : 'Nothing to apply yet');
    }
  }

  // When the check knows it is red-green but not which cone, it asks the user
  // to decide -- here, inside the panel.
  //
  // The first version of this pointed at the dropdown further down the popup.
  // That was a bad instruction: it is about 800px away, it sits under a heading
  // that reads "Assume" and is part of the page-audit card, so nothing about it
  // reads as "your colour vision profile". The choice belongs where the
  // question was asked.
  const visionComplete = () =>
    visionAnswers.every((a) => a === 'yes' || a === 'maybe' || a === 'no');

  function renderVisionChoice() {
    if (!visionChoiceSlot) return;

    // Only once every question is answered.
    //
    // This used to appear after two answers, with three still to go, sitting
    // below the Back/Next row where it read as "after the check". But the
    // score is still moving at that point, so a choice made there could be
    // silently reused after a later answer flipped the result back to
    // red-green. The question is only worth asking once the answer has stopped
    // changing.
    const needed = visionComplete() &&
      !!visionResult && visionResult.redGreen === true && !visionResult.cvdType;

    if (!needed) {
      // A choice that no longer applies must not survive, or applyVisionResult
      // would use it later.
      visionChosenType = '';
      visionChoiceSlot.innerHTML = '';
      return;
    }

    visionChoiceSlot.innerHTML = '';
    const row = document.createElement('div');
    row.id = 'visionChoice';
    row.className = 'probe-choice';
    visionChoiceSlot.appendChild(row);
    row.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'probe-q';
    label.textContent = 'Which is it? Pick the closer one — the difference is small.';
    row.appendChild(label);

    const opts = document.createElement('div');
    opts.className = 'probe-choice-opts';
    for (const t of ['protanopia', 'deuteranopia']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = TYPE_LABEL[t];
      b.setAttribute('aria-pressed', String(visionChosenType === t));
      b.addEventListener('click', () => {
        visionChosenType = t;
        renderVisionChoice();
        showVisionResult();
      });
      opts.appendChild(b);
    }
    row.appendChild(opts);
  }

  // Scoring is pure derived state, so it runs on every answer rather than
  // waiting for a button. Nothing is stored and nothing is applied here.
  function refreshVisionPreview() {
    visionResult = scoreAnswers(visionAnswers);
    const answered = visionAnswers.filter((a) => a).length;
    if (visionTestStatus) {
      visionTestStatus.textContent = answered < 2
        ? 'Answer at least two and a suggestion appears here.'
        : 'Update any answer — the suggestion below changes as you go.';
    }
    showVisionResult();
  }

  // The one action: put the type and a starting gain into the profile. Labelled
  // for what it does, because the old label promised to "use" a result that had
  // already been used, and applied nothing visible.
  function applyVisionResult() {
    if (!visionApplies()) return;

    // When the check could not name a type, the type is the one the user just
    // chose in the panel -- not whatever the audit's "Assume" dropdown happens
    // to hold, which is a different control for a different purpose.
    const type = visionResult.cvdType || visionChosenType;
    if (!type) return;

    sessionWrite({ [VISION_KEY]: { result: visionResult, answers: visionAnswers } });

    typeSelect.value = type;
    activeType = type;
    const gain = suggestedGain(visionResult);
    severitySlider.value = String(gain);
    severityVal.textContent = gain.toFixed(2);
    setBadges(gain);
    pendingProfile = true;

    // Applying a profile does not turn the correction on or off, so the switch
    // must keep whatever state it was already in. Passing a literal false here
    // -- which is what the preset path does, because it immediately leaves for
    // the review screen -- would show "Correction is off" while the filter is
    // still applied to every page.
    renderPower(enableToggle ? !!enableToggle.checked : false, true);

    if (visionTestPanel) visionTestPanel.hidden = true;
    if (visionResultCard && visionResultTitle) {
      visionResultTitle.textContent = 'Profile set: ' + TYPE_LABEL[type];
      // "Profile set", not "Applied". Nothing is applied until the switch is
      // flipped and the review is confirmed, and saying otherwise would be the
      // same overclaim the old button made.
      visionResultSub.textContent =
        'Your profile is set to ' + TYPE_LABEL[type] +
        ' at gain ' + gain.toFixed(2) + '. Turn the switch on to review and apply it. ' +
        (visionResult.cvdType
          ? 'Change either above if that is wrong.'
          : 'This is the type you picked above, not one the check chose.');
    }
  }

  // Restore a result taken earlier in this session, if there is one.
  function restoreVisionResult() {
    sessionRead([VISION_KEY], (r) => {
      const stored = r && r[VISION_KEY];
      if (!stored || !stored.result) return;
      visionResult = stored.result.result;
      showVisionResult();
    });
  }

  if (visionTestBtn) visionTestBtn.addEventListener('click', startVisionTest);
  if (visionTestClose) {
    visionTestClose.addEventListener('click', () => {
      if (visionTestPanel) visionTestPanel.hidden = true;
    });
  }
  if (visionTestDone) visionTestDone.addEventListener('click', applyVisionResult);

  // --- The power switch ----------------------------------------------------
  //
  // This is the primary control on the intake screen, and it replaced a
  // "Review & Activate" button that said the same thing more slowly.
  //
  // It is a state control, not an action control, and the difference matters:
  //
  //   OFF -> ON   opens the review screen. It does not apply anything. The
  //               switch springs back to off, because the correction really is
  //               still off -- nothing has been applied yet. Confirm is what
  //               turns it on for real.
  //   ON -> OFF   applies immediately, with no review. Disabling is safe and
  //               trivially reversible, and making the user confirm a turn-off
  //               would be absurd.
  //
  // The spring-back reads as broken unless it is explained, so the card's
  // subtitle changes to say what will happen before the tap. The switch state
  // is never allowed to drift from chromaEnabled, which is what the page is
  // actually doing.

  function renderPower(on, hasProfile) {
    if (enableToggle) enableToggle.checked = on;
    if (!powerCard) return;
    const available = hasProfile || profileAvailable();

    if (on) {
      powerLabel.textContent = 'Correction is on';
      powerSub.textContent = 'Applied to every page. Your profile is saved.';
      powerCard.classList.add('on');
    } else if (available) {
      powerLabel.textContent = 'Correction is off';
      powerSub.textContent = 'Turn on to review your saved profile before it is applied.';
      powerCard.classList.remove('on');
    } else {
      powerLabel.textContent = 'Correction is off';
      powerSub.textContent = 'Upload a report or pick a preset, then turn this on.';
      powerCard.classList.remove('on');
    }
  }

  // The manual path, previously reachable only through the removed button.
  // Kept as data so the switch can open review with whatever the slider says.
  function manualPayload() {
    return {
      cvdType: currentType,
      typeConfidence: 'manual',
      threshold: null,
      excess: null,
      sn: null,
      scoredGain: null,
      gain: parseFloat(severitySlider.value),
      gainSource: 'manual',
      channels: {},
      mixed: false,
      plateClass: null,
      warnings: []
    };
  }

  function syncToggle() {
    if (!enableToggle) return;
    chrome.storage.local.get(['chromaEnabled', 'chromaMatrix'], (r) => {
      // No matrix at all means nothing has ever been confirmed, so there is
      // nothing for the switch to turn on yet.
      storedProfile = !!r.chromaMatrix;
      const on = r.chromaEnabled !== false && storedProfile;
      renderPower(on, storedProfile);
    });
  }

  if (enableToggle) {
    enableToggle.addEventListener('change', () => {
      const wantsOn = enableToggle.checked;

      if (!wantsOn) {
        // Off is immediate and non-destructive; the saved matrix is kept.
        renderPower(false, true);
        chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: false }).catch(() => {});
        return;
      }

      // On means "I want this on", which still has to pass review. Spring the
      // switch back, because the correction genuinely is not on yet.
      renderPower(false, true);
      showConfirm(manualPayload());
    });
  }

  // The whole card is the target, not just the 51px switch.
  if (powerCard) {
    const toggleFromCard = () => {
      if (!enableToggle) return;
      enableToggle.checked = !enableToggle.checked;
      enableToggle.dispatchEvent(new Event('change', { bubbles: false }));
    };
    powerCard.addEventListener('click', (e) => {
      // Let the real input handle its own clicks, so there is one code path.
      if (e.target.closest('.switch-lg')) return;
      toggleFromCard();
    });
    powerCard.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleFromCard();
    });
  }

  // --- Preset selection ---------------------------------------------------
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const preset = PRESETS.find((p) => p.id === presetSelect.value);
      if (!preset) return;

      const gain = parseFloat(presetSelect.selectedOptions[0].dataset.gain);
      severitySlider.value = String(gain);
      severityVal.textContent = gain.toFixed(2);
      setBadges(gain);
      statusText.textContent = 'Preset selected — review next';
      pendingProfile = true;
      renderPower(false, false);

      // Straight to review, with no file needed. Still never applies anything:
      // the confirm screen remains the gate.
      showConfirm({
        cvdType: preset.cvdType,
        typeConfidence: 'preset',
        threshold: null,
        excess: null,
        sn: preset.sn,
        scoredGain: null,
        gain: gain,
        gainSource: `preset · ${preset.label}`,
        channels: {},
        mixed: false,
        plateClass: null,
        warnings: []
      });
    });
  }

  severitySlider.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    severityVal.textContent = v.toFixed(2);
    setBadges(v);
  });

  // The manual slider no longer needs its own submit button. Moving it is
  // enough to make the power card read as live -- a number the user cannot act
  // on is the kind of thing this interface pass exists to remove.

  // Drag and Drop interface
  dropZone.addEventListener('click', () => fileInput.click());
  // Keyboard parity: the drop zone is a button in everything but name.
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.add('over');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.remove('over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) processFile(files[0]);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) processFile(e.target.files[0]);
  });

  // Core Processing Routine
  async function processFile(file) {
    statusText.textContent = 'Reading…';

    try {
      let rawText = '';

      if (file.type === 'text/plain') {
        rawText = await file.text();
      } else if (file.type === 'application/pdf') {
        rawText = await extractPdfText(file);
      } else {
        await loadScriptOnce('lib/tesseract.min.js');
        const imageSrc = URL.createObjectURL(file);
        try {
          const { data } = await Tesseract.recognize(imageSrc, 'eng');
          rawText = data.text;
        } finally {
          URL.revokeObjectURL(imageSrc);
        }
      }

      // Parse structured optical metrics from unstructured text
      const parsed = parseClinicalMetrics(rawText);

      // Surface the parse, but apply nothing yet -- the operator confirms first.
      currentType = parsed.cvdType;
      if (parsed.gain !== null) severitySlider.value = parsed.gain;
      pendingProfile = true;
      await showConfirm(parsed);

    } catch (err) {
      console.error('File parsing failure:', err);
      statusText.textContent = 'Could not read this file — try another report';
    }
  }

  // The gain curve itself lives in color/gainMapping.js -- single source of
  // truth for the playbook constants. This module only decides *which* input
  // feeds it, and records where the number came from.
  function resolveGain(sn, scoredGain, manualOverride) {
    if (manualOverride !== null && manualOverride !== undefined) {
      return { gain: Math.min(Math.max(parseFloat(manualOverride), 0.0), 1.0), source: 'manual' };
    }
    if (scoredGain !== null) {
      return { gain: scoredGain, source: 'severity score' };
    }
    if (sn !== null) {
      return { gain: calculateCadGain(sn), source: `SN curve @ ${sn} SN` };
    }
    return { gain: null, source: null };
  }

  // Deficiency classification.
  //
  // Bare colour words are deliberately NOT used as signals. Real reports
  // mention colours constantly in prose -- "Red - Green (RG) Discrimination
  // Threshold" in a *protan* report, "Red - green channels are intact" in a
  // *tritan* one -- and matching on them silently misclassifies the patient.
  //
  // Instead the report's own diagnosis line is read first, which is what
  // clinicians actually key off. Only if there is no such line do we fall back
  // to counting deficiency terms, and a close contest is reported as low
  // confidence rather than guessed.
  // Within a window of text, name the deficiency. If several appear, the one
  // mentioned first wins -- on a diagnosis line the actual class leads, and
  // later mentions are usually side-notes about the other zones.
  //
  // "Dominant" is honoured first: mixed-deficiency reports say things like
  // "MIXED (Deutan Dominant + Mild Tritan)", where document order is not the
  // clinical priority order.
  function classifyByTerms(text) {
    const s = text.toLowerCase();

    const dominant = s.match(/(protan|deuteran|deutan|tritan)\w*\s+dominant/);
    if (dominant) {
      return { type: stemToType(dominant[1]), index: 0 };
    }

    const order = [
      ['protanopia', /protan/],
      // The deutan stem is irregular: "Deutan" has no 'r' but
      // "Deuteranomaly" does, so neither /deutan/ nor /deuteran/ alone
      // matches every spelling. Both are listed.
      ['deuteranopia', /deuteran|deutan/],
      ['tritanopia', /tritan/]
    ];
    let best = null;
    for (const [type, re] of order) {
      const m = s.match(re);
      if (m && (best === null || m.index < best.index)) best = { type, index: m.index };
    }
    return best;
  }

  function stemToType(stem) {
    const s = stem.toLowerCase();
    if (s.startsWith('protan')) return 'protanopia';
    if (s.startsWith('deutan')) return 'deuteranopia';
    if (s.startsWith('tritan')) return 'tritanopia';
    return null;
  }

  function parseDeficiencyType(text) {
    // A named classification line, e.g. "Primary Classification: DEUTERANOMALY".
    //
    // Section *headers* ("CLINICAL CLASSIFICATION ----") match the label just
    // as well as the real field, and the text immediately after a header is
    // separator dashes. So rather than reading only the characters right after
    // the label, scan forward past separator runs for the first deficiency
    // term actually present.
    const labelRe = /(?:primary\s+)?(?:classification|cvd\s+class|diagnosis|impression|clinical\s+diagnosis|diagnostic\s+impression)\s*[:\-–]?\s*/gi;
    let match;
    while ((match = labelRe.exec(text)) !== null) {
      const after = match.index + match[0].length;
      const window = text.slice(after, after + 240).replace(/[-_=\s•·]{2,}/g, ' ');
      const verdict = classifyByTerms(window);
      if (verdict) return { cvdType: verdict.type, typeConfidence: 'high' };
    }

    // Cone-designation fallback: specific enough to be safe in prose.
    const lower = text.toLowerCase();
    if (/\bl-?cone\b/.test(lower)) return { cvdType: 'protanopia', typeConfidence: 'medium' };
    if (/\bm-?cone\b/.test(lower)) return { cvdType: 'deuteranopia', typeConfidence: 'medium' };
    if (/\bs-?cone\b/.test(lower)) return { cvdType: 'tritanopia', typeConfidence: 'medium' };

    // Last resort: whichever deficiency term dominates the document.
    const counts = {
      protanopia: (lower.match(/protan/g) || []).length,
      deuteranopia: (lower.match(/deuteran/g) || []).length,
      tritanopia: (lower.match(/tritan/g) || []).length
    };
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] === 0) {
      return { cvdType: 'protanopia', typeConfidence: 'low' };
    }
    if (ranked[0][1] === ranked[1][1]) {
      return { cvdType: ranked[0][0], typeConfidence: 'low' };
    }
    return { cvdType: ranked[0][0], typeConfidence: 'low' };
  }

  // Parses clinical data into continuous variables.
  //
  // Distinguishes two kinds of number, because conflating them is how a
  // mis-calibrated filter happens:
  //
  //   gain      - a 0..1 severity score (or an explicit percentage). Only
  //               these are used to drive the engine directly.
  //   threshold - an absolute clinical reading, e.g. "8.5 SN" on the
  //               Shneierson scale, which runs 0..25. There is no standard
  //               conversion to an engine gain, so it is reported for the
  //               operator to read and never silently rescaled.
  function parseClinicalMetrics(text) {
    const lower = text.toLowerCase();
    const warnings = [];

    let cvdType = 'protanopia';
    let typeConfidence = 'low';

    ({ cvdType, typeConfidence } = parseDeficiencyType(text));

    if (typeConfidence === 'low') {
      warnings.push('No unambiguous deficiency classification found. Verify the type before confirming.');
    }

    // Tritanopia is the one deficiency the engine cannot simulate faithfully.
    // The published simplification covers protanopia and deuteranopia only, and
    // the accurate model needs a per-pixel branch that a single colour matrix
    // cannot express. Saying so here is the difference between an operator
    // knowing the filter is approximate and them believing it is calibrated.
    if (cvdType === 'tritanopia') {
      warnings.push('Tritanopia is simulated approximately.');
    }

    // Threshold readings, recorded verbatim for display.
    //
    // Two-channel CAD reports list BOTH a red-green and a yellow-blue
    // threshold, and only the one matching the deficiency is clinically
    // meaningful. Taking whichever appears first would feed a tritan patient
    // their red-green reading, so the channel is labelled and selected against
    // the detected deficiency.
    // Reports write the channel three ways: "(RG)", a bare "RG Threshold:",
    // or spelled out "Red - Green ... Threshold:". All three must match.
    const CHANNEL_PATTERNS = [
      { key: 'RG', re: /(?:\(\s*rg\s*\)|\brg\b|\bred[\s-]*-?\s*green\b)[^0-9%]{0,48}?([0-9]+(?:\.[0-9]+)?)\s*sn\b/gi },
      { key: 'YB', re: /(?:\(\s*yb\s*\)|\byb\b|\b(?:yellow|blue)[\s-]*-?\s*(?:yellow|blue)\b)[^0-9%]{0,48}?([0-9]+(?:\.[0-9]+)?)\s*sn\b/gi }
    ];

    const channels = {};
    for (const { key, re } of CHANNEL_PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m) channels[key] = parseFloat(m[1]);
    }

    const relevantChannel = cvdType === 'tritanopia' ? 'YB' : 'RG';

    let threshold = null;
    if (channels[relevantChannel] !== undefined) {
      threshold = { value: channels[relevantChannel], unit: 'SN' };
    } else {
      const snMatch = lower.match(/([0-9]+(?:\.[0-9]+)?)\s*sn\b/);
      const thresholdMatch = lower.match(/threshold[\s:=]*([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)?/i);
      if (snMatch) {
        threshold = { value: parseFloat(snMatch[1]), unit: 'SN' };
      } else if (thresholdMatch) {
        threshold = {
          value: parseFloat(thresholdMatch[1]),
          unit: (thresholdMatch[2] || '').toUpperCase() || 'unlabelled'
        };
      }
    }

    // Plate group the threshold was read on. Two-channel reports name both.
    let plateClass = null;
    if (threshold && channels[relevantChannel] !== undefined) {
      plateClass = relevantChannel;
    } else {
      // Only genuine colour-channel names. The word "total error" is a scoring
      // metric on hue tests, not a plate group, so it is not treated as one;
      // the short code "TR" still is, and cannot collide with "TES".
      const plateMatch = lower.match(/\b(rg|bg|yb|tr)\b\s*[:=]/i) ||
                         lower.match(/\b(red-green|blue-green|yellow-blue)\b/i);
      if (plateMatch) plateClass = plateMatch[1].toUpperCase();
    }

    // Excess over the normal-hearing baseline (1.0 SN is the cutoff). Reported
    // for the operator; the gain curve that consumes it lives in the module.
    const SN_BASELINE = 1.0;
    const excess = threshold ? Math.max(threshold.value - SN_BASELINE, 0) : null;

    // Both channels elevated means a mixed deficiency. The engine corrects a
    // single blind axis, so this must be surfaced rather than quietly reduced
    // to the dominant type.
    const rgDeficient = channels.RG !== undefined && channels.RG > SN_BASELINE;
    const ybDeficient = channels.YB !== undefined && channels.YB > SN_BASELINE;
    const mixed = rgDeficient && ybDeficient;
    if (mixed) {
      warnings.push(
        `Mixed deficiency: RG ${channels.RG} SN and YB ${channels.YB} SN are both elevated. ` +
        'Correcting for the dominant type only — the secondary channel is not separately corrected.'
      );
    }

    // A directly-measured gain is only read from numbers already on a 0..1
    // scale, or one carrying an explicit percent sign. Everything else is left
    // to the SN curve.
    let scoredGain = null;
    let scoredSource = null;

    const percentMatch = lower.match(/([0-9.]+)\s*%/);
    if (percentMatch) {
      scoredGain = parseFloat(percentMatch[1]) / 100.0;
      scoredSource = 'percentage';
    } else {
      const scoreMatch = lower.match(/(?:severity|deficit|score|val)\s*[:=]?\s*([0-9.]+)/i);
      if (scoreMatch) {
        const v = parseFloat(scoreMatch[1]);
        if (v <= 1.0) {
          scoredGain = v;
          scoredSource = 'severity score';
        } else {
          warnings.push(`Severity score ${v} is not on a 0..1 scale and was not converted. Set gain manually.`);
        }
      }
    }

    // Precedence: an explicit 0..1 score or percentage outranks the SN curve,
    // because it is a directly usable measurement rather than a derived one.
    // The mapping itself is delegated to color/gainMapping.js.
    const sn = threshold && threshold.unit === 'SN' ? threshold.value : null;
    const { gain, source: gainSource } = resolveGain(sn, scoredGain, null);

    if (gain === null && threshold) {
      warnings.push(`Threshold ${threshold.value} ${threshold.unit} (excess ${excess.toFixed(1)} over ${SN_BASELINE.toFixed(1)}) has no playbook gain mapping. Set gain manually.`);
    }

    if (gain === null && !threshold) {
      warnings.push('This report carries no SN threshold or 0..1 severity score, so no gain could be derived. Set it manually before confirming.');
    }

    return { cvdType, typeConfidence, plateClass, threshold, excess, sn, scoredGain, gain, gainSource, channels, mixed, warnings };
  }

  // Extracts plain text from standard PDF pages
  async function extractPdfText(file) {
    await loadScriptOnce('lib/pdf.min.js');
    if (!window.pdfjsLib) {
      throw new Error('PDF.js failed to load');
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      disableWorker: true,
      isEvalSupported: false
    }).promise;
    let textContent = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      textContent += content.items.map(item => item.str).join(' ') + ' ';
    }
    return textContent;
  }

  // --- Colour audit --------------------------------------------------------
  //
  // The question this answers is the one the filter cannot: the filter changes
  // what a dichromat sees, but it cannot tell them *where* the page depends on
  // a distinction that no longer exists. So this walks the current tab for text
  // and its background, projects both through the same simulation, and reports
  // the pairs that collapse.
  //
  // Results are grouped by the (foreground, background) colour pair rather than
  // listed per element. A site with forty links in the same blue produces one
  // finding, not forty, and "forty instances" is itself the useful number.
  const VERDICT_COPY = {
    collapsed:       { dot: '\u{1F534}', label: 'Unreadable',  weight: 0 },
    'hue-collapsed': { dot: '\u{1F7E1}', label: 'Colour cue lost', weight: 1 },
    marginal:        { dot: '\u{1F7E1}', label: 'Borderline',   weight: 2 },
    'always-close':  { dot: '\u{1F7E1}', label: 'Too close for anyone', weight: 1 },
    distinct:        { dot: '\u{1F7E2}', label: 'Readable',    weight: 3 }
  };

  function groupAuditPairs(pairs) {
    const groups = new Map();
    for (const p of pairs) {
      const key = p.fg.join(',') + '|' + p.bg.join(',');
      if (!groups.has(key)) groups.set(key, { fg: p.fg, bg: p.bg, count: 0, sample: p.sample, selector: p.selector });
      const g = groups.get(key);
      g.count++;
      if (!g.sample) g.sample = p.sample;
    }
    return [...groups.values()];
  }

  function renderAudit(result) {
    if (!auditPanel || !auditList) return;

    if (!result || result.status !== 'Ok') {
      auditStatus.textContent = 'Could not read this page: ' +
        ((result && result.error) || 'no response');
      auditList.innerHTML = '';
      auditPanel.hidden = false;
      return;
    }

    const cvdType = auditType ? auditType.value : 'deuteranopia';
    const groups = groupAuditPairs(result.pairs || []);

    if (!groups.length) {
      auditStatus.textContent = 'No coloured text found on this page.';
      auditList.innerHTML = '';
      auditPanel.hidden = false;
      return;
    }

    const assessed = groups.map((g) => ({
      ...g,
      ...assessPair({ r: g.fg[0], g: g.fg[1], b: g.fg[2] },
                    { r: g.bg[0], g: g.bg[1], b: g.bg[2] },
                    cvdType)
    }));

    // Worst first. A page with one unreadable pairing is broken regardless of
    // how many others are fine, so the summary is driven by the worst finding
    // and never by an average.
    const rank = { collapsed: 0, 'hue-collapsed': 1, 'always-close': 2, marginal: 3, distinct: 4 };
    assessed.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.projectedDelta - b.projectedDelta));

    const worst = assessed[0];
    const problems = assessed.filter((a) => a.verdict === 'collapsed' || a.verdict === 'hue-collapsed' || a.verdict === 'always-close');

    // Set findings come first because they are the ones that actually fail.
    // Text on a background is dominated by lightness, which survives a
    // deficiency intact, so a page can have perfectly readable text and still
    // be unusable -- a chart whose series are told apart only by hue.
    const setResult = renderAuditSets(result.sets, cvdType);
    const setBad = setResult && setResult.worst.result.score <= 60;

    const summary = setBad ? setResult.summary : VERDICT_COPY[worst.verdict];
    const line = setBad
      ? `A group of ${setResult.worst.count} marks is told apart by colour alone and ` +
        `does not survive ${typeName(cvdType)}.`
      : (problems.length
          ? `${problems.length} of ${assessed.length} text colour ${problems.length === 1 ? 'pair' : 'pairs'} problem${problems.length === 1 ? 's' : ''} for someone with ${typeName(cvdType)}.`
          : `All ${assessed.length} text colour pairs stay distinguishable.`);

    auditStatus.innerHTML =
      `<strong>${summary.dot} ${summary.label}</strong> — ` + line +
      `<br><small>${setBad ? setResult.worst.result.worst.reason : worst.reason}</small>`;

    auditList.innerHTML = '';
    if (setResult) auditList.appendChild(setResult.list);
    for (const a of assessed.slice(0, 12)) {
      const copy = VERDICT_COPY[a.verdict];
      const row = document.createElement('div');
      row.className = 'audit-row';

      const sw = document.createElement('span');
      sw.className = 'audit-swatch';
      sw.style.background = rgbToHex(a.fg[0], a.fg[1], a.fg[2]);

      const mid = document.createElement('span');
      mid.className = 'audit-mid';
      mid.textContent = 'Aa';

      const bg = document.createElement('span');
      bg.className = 'audit-swatch';
      bg.style.background = rgbToHex(a.bg[0], a.bg[1], a.bg[2]);

      const label = document.createElement('span');
      label.className = 'audit-label';
      label.innerHTML = `<strong>${copy.dot} ${rgbToHex(a.fg[0],a.fg[1],a.fg[2])} on ${rgbToHex(a.bg[0],a.bg[1],a.bg[2])}</strong>` +
        `<small>${a.count} element${a.count === 1 ? '' : 's'}` +
        (a.hueSurvival !== null ? ` · hue ${Math.round(a.hueSurvival * 100)}% kept` : '') +
        ` · ${a.projectedDelta.toFixed(1)} apart after simulation</small>`;

      row.appendChild(sw);
      row.appendChild(mid);
      row.appendChild(bg);
      row.appendChild(label);
      auditList.appendChild(row);
    }
    if (assessed.length > 12) {
      const more = document.createElement('p');
      more.className = 't-cap';
      more.style.padding = '8px 0 0';
      more.textContent = `+ ${assessed.length - 12} more colour pairs`;
      auditList.appendChild(more);
    }

    auditPanel.hidden = false;
  }

  function typeName(t) {
    return t === 'protanopia' ? 'protanopia' : t === 'tritanopia' ? 'tritanopia' : 'deuteranopia';
  }

  // chrome.tabs.sendMessage is (tabId, message, ...) -- the tab id is the first
  // argument, not an option. Passing the message on its own made Chrome try to
  // read {type:'AUDIT_COLORS'} as a tab id and throw "No matching signature".
  function runAudit() {
    if (auditPanel) {
      auditPanel.hidden = false;
      auditStatus.textContent = 'Scanning this page…';
      auditList.innerHTML = '';
    }

    const fail = (msg) => {
      if (auditStatus) auditStatus.textContent = msg;
      if (auditList) auditList.innerHTML = '';
    };

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id === undefined || tab.id === null) {
        fail('No active tab to audit.');
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'AUDIT_COLORS' })
        .then((res) => {
          if (res && res.status === 'Ok') renderAudit(res);
          else fail('Could not read this page. Browser and extension pages are not accessible to extensions — try a normal web page.');
        })
        .catch(() => {
          // The content script is not present, or the page refused it. Both
          // mean the same thing to the user, so say that rather than leaking
          // a Chrome error string.
          fail('Chroma cannot read this page. Browser settings, the Web Store and PDF viewers are not accessible to extensions.');
        });
    });
  }

  if (auditBtn) auditBtn.addEventListener('click', runAudit);
  if (auditClose) {
    auditClose.addEventListener('click', () => {
      if (auditPanel) auditPanel.hidden = true;
    });
  }
  if (auditType) {
    auditType.addEventListener('change', runAudit);
  }

  function renderAuditSets(sets, cvdType) {
    if (!sets || !sets.length) return null;

    const assessed = sets.map((s) => {
      const rgs = s.colors.map((c) => ({ r: c[0], g: c[1], b: c[2] }));
      // assessSet deliberately reports the WORST pair, not an average.
      const result = assessSet(rgs, cvdType);
      return { ...s, result };
    });

    assessed.sort((a, b) => a.result.score - b.result.score);
    const worst = assessed[0];
    const summary = VERDICT_COPY[worst.result.worst.verdict];

    const list = document.createElement('div');
    for (const a of assessed) {
      const w = a.result.worst;
      const copy = VERDICT_COPY[w.verdict];
      const row = document.createElement('div');
      row.className = 'audit-row';

      const strip = document.createElement('span');
      strip.className = 'audit-strip';
      for (const c of a.colors.slice(0, 6)) {
        const chip = document.createElement('i');
        chip.style.background = rgbToHex(c[0], c[1], c[2]);
        strip.appendChild(chip);
      }

      const label = document.createElement('span');
      label.className = 'audit-label';
      label.innerHTML =
        `<strong>${copy.dot} ${a.count} marks, ${a.colors.length} colours</strong>` +
        `<small>${a.label} · worst pair ` +
        `${rgbToHex(w.a.r, w.a.g, w.a.b)} / ${rgbToHex(w.b.r, w.b.g, w.b.b)}` +
        (w.hueSurvival !== null ? ` · hue ${Math.round(w.hueSurvival * 100)}% kept` : '') +
        '</small>';

      row.appendChild(strip);
      row.appendChild(label);
      list.appendChild(row);
    }
    return { summary, worst, list };
  }

  // --- Boot ---------------------------------------------------------------
  buildPresets();
  syncToggle();
  setBadges(severitySlider.value);
  severityVal.textContent = parseFloat(severitySlider.value).toFixed(2);
  restoreVisionResult();
  statusText.textContent = 'PDF, image or text';
});
