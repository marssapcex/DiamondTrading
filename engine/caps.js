// G1 venue routing + G3 dynamic manipulation-cost caps + G4 vol-spike breaker.
import { depthWithinBand } from "./venues/base.js";

/** G1: pick the deepest measurable venue per asset; dual-read when the runner-up
 *  carries >= DUAL_MIN_SHARE of the winner's depth. */
export async function routeAsset(venues, asset, { bandFrac = 0.005, dualMinShare = 0.3 } = {}) {
  const rows = [];
  for (const v of venues) {
    try {
      const book = await v.fetchDepth(asset);
      const depth = depthWithinBand(book, bandFrac);
      const tick = await v.fetchTicker24h(asset);
      rows.push({ venue: v, depth, lambda: tick.quoteVolume / 86400 });
    } catch (_) { /* venue does not list asset or is down */ }
  }
  if (!rows.length) throw new Error(`no venue for ${asset}`);
  rows.sort((a, b) => (b.depth - a.depth) || (b.lambda - a.lambda));
  const [best, ...rest] = rows;
  const alt = rest.find((r) => r.depth >= best.depth * dualMinShare) || null;
  return {
    primary: best, crossCheck: alt, all: rows,
    dualRead: !!alt,
  };
}

/** G3: per-position payout ceiling from measured liquidity.
 *  P_max = min(T/60, 0.30·T, κ · λ · ω). κ=1/4 single-read, 1/3 dual-read (attacker must
 *  move both venues). λ in $/s from the ROUTED venue; ω in seconds. */
export function payoutCeiling({ treasuryUsd, lambdaUsdPerSec, omegaSec, dualRead = false }) {
  const kappa = dualRead ? 1 / 3 : 1 / 4;
  const flowCap = kappa * lambdaUsdPerSec * omegaSec;
  return Math.min(treasuryUsd / 60, 0.30 * treasuryUsd, flowCap);
}

/** G4: vol-spike circuit breaker. Trip when σ_30s > mult × σ_ref; cool down `coolMs`. */
export class SpikeBreaker {
  constructor({ mult = 4, coolMs = 60_000 } = {}) { this.mult = mult; this.coolMs = coolMs; this.trippedAt = new Map(); }
  /** returns true if sales are allowed for asset at time now */
  allowed(asset, sigmaNow, sigmaRef, now) {
    if (sigmaNow != null && sigmaRef != null && sigmaRef > 0 && sigmaNow > this.mult * sigmaRef) {
      this.trippedAt.set(asset, now);
      return false;
    }
    const t = this.trippedAt.get(asset);
    if (t != null && now - t < this.coolMs) return false;
    if (t != null) this.trippedAt.delete(asset);
    return true;
  }
}
