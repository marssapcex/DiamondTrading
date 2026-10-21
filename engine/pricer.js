// GALE pricer: turn measured σ into a fair multiplier, then shave by the published edge ρ.
// Model [ASSUMED]: zero-drift absorbing-barrier first-passage (reflection principle):
//   P_bust(L, σ, τ) ≈ 2·Φ(−(1/L)/(σ·√τ))        (touch of the ∓1/L band within τ)
// Fair digital multiplier M_fair = 1/(1−P_bust); offered M = M_fair·(1−ρ), ρ = 2% default.
// The clamp table (1.05x–25x global, per-class on-chain) bounds everything again on-chain.

function erf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                  - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

export function bustProb(leverage, sigmaPerSec, tauSec) {
  const z = (1 / leverage) / (sigmaPerSec * Math.sqrt(tauSec));
  return Math.min(0.9999, 2 * Phi(-z));
}

export function offerMultiplier(leverage, sigmaPerSec, tauSec, rho = 0.02) {
  const pBust = bustProb(leverage, sigmaPerSec, tauSec);
  const mFair = 1 / (1 - pBust);
  return { pBust, mFair, mOffer: mFair * (1 - rho) };
}

/** clamp to on-chain envelope and class cap; returns null if below the 1.05x floor
 *  (engine refuses to sell a product it cannot price). */
export function clampMultiplier(m, { minX = 1.05, maxX = 25, classMaxX = 25 } = {}) {
  const c = Math.min(m, maxX, classMaxX);
  return c >= minX ? c : null;
}
