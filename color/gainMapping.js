/**
 * Maps CAD Standard Normal (SN) thresholds to an assistive gain (0.0 to 1.0).
 * Playbook Formula: g = 1 - exp(-0.23 * max(SN - 1.0, 0))
 */
export function calculateCadGain(snValue, manualOverride = null) {
  // If user sets gain manually or mapping is explicitly overridden
  if (manualOverride !== null && manualOverride !== undefined) {
    return Math.min(Math.max(parseFloat(manualOverride), 0.0), 1.0);
  }

  const sn = parseFloat(snValue);
  if (isNaN(sn) || sn <= 1.0) {
    return 0.0; // Normal visual threshold, no gain needed
  }

  const excess = sn - 1.0;
  const k = 0.23; // Product tuning constant (Playbook v1)
  const derivedGain = 1.0 - Math.exp(-k * excess);

  // Clamp gain strictly between 0.0 and 0.95 to prevent extreme color clipping
  return Math.min(Math.max(derivedGain, 0.0), 0.95);
}
