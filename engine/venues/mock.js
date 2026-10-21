// MockVenue — offline twin of a live adapter for the engine test-suite.
// Synthetic GBM-ish walk tapes + configurable depth/flow so every algorithm
// (G1 routing, G2 TWAP, G3 caps, G4 breaker, G8 tolerance) is testable offline.
import { TradeTape } from "./base.js";

export class MockVenue {
  constructor(name, { lambdaUsd = 1000, depthUsd = 100_000 } = {}) {
    this.name = name;
    this.lambdaUsd = lambdaUsd;     // organic $/s this venue reports
    this.depthUsd = depthUsd;       // $ depth within ±0.5% band
    this.tapes = new Map();
  }
  async fetchTicker24h() { return { quoteVolume: this.lambdaUsd * 86400 }; }
  async fetchDepth() {
    const per = this.depthUsd / 50; // 50 pseudo-levels each side
    const mk = (side) => Array.from({ length: 50 }, (_, i) =>
      [side === "bid" ? 100 * (1 - 0.0001 * (i + 1)) : 100 * (1 + 0.0001 * (i + 1)), per / 100]);
    return { bids: mk("bid"), asks: mk("ask") };   // px*qty = per level `$`
  }
  startTape(asset = "MOCK") {
    const tape = new TradeTape();
    this.tapes.set(asset, tape);
    tape.stop = () => {};
    return tape;
  }
  /** drive a tape deterministically: constant-price organic flow */
  feed(asset, t0, t1, px, qtyPerSec = 100, stepMs = 500) {
    const tape = this.tapes.get(asset);
    for (let t = t0; t <= t1; t += stepMs) tape.add(t, px, qtyPerSec * stepMs / 1000);
  }
  /** inject an outlier series (manipulator/DUMP), e.g. for G8 tolerance tests */
  feedSeries(asset, points) {
    const tape = this.tapes.get(asset);
    for (const [t, px, qty] of points) tape.add(t, px, qty);
  }
}
