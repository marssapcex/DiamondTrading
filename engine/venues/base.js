// Venue adapter layer for the GALE engine.
// Every adapter exposes the SAME interface so the router/attester never care which
// exchange they are reading:
//   name                     : string
//   fetchTicker24h(asset)    : -> { quoteVolume: number }        (REST, for λ)
//   fetchDepth(asset, limit) : -> { bids: [[px,qty]], asks: [[px,qty]] } (REST, for G3 depth)
//   startTape(asset)         : -> TradeTape (polling REST trades into a rolling buffer)
// Live adapters are documented but NOT sandbox-live-tested (geo blocks); MockVenue is
// the offline twin used by the test-suite.

export class TradeTape {
  constructor(windowMs = 10 * 60 * 1000) {
    this.windowMs = windowMs;
    this.trades = [];           // { t: ms, px, qty } ascending by t
  }
  add(t, px, qty) {
    const last = this.trades[this.trades.length - 1];
    if (last && t < last.t) return;          // drop out-of-order (exchange replays)
    this.trades.push({ t, px, qty });
    const cut = t - this.windowMs;
    while (this.trades.length && this.trades[0].t < cut) this.trades.shift();
  }
  /** G2 persistence TWAP: volume-weighted mean fill price over [tEnd-window, tEnd]. */
  vwap(tEnd, windowMs) {
    const t0 = tEnd - windowMs;
    let pq = 0, q = 0, n = 0;
    for (const tr of this.trades) {
      if (tr.t >= t0 && tr.t <= tEnd) { pq += tr.px * tr.qty; q += tr.qty; n++; }
    }
    return n ? { px: pq / q, qty: q, n } : null;   // null = NO-PRINT (G8 honest failure)
  }
  /** realized per-second σ from trade-to-trade log returns in [tEnd-window, tEnd] */
  sigma(tEnd, windowMs = 30_000) {
    const t0 = tEnd - windowMs;
    const p = this.trades.filter((tr) => tr.t >= t0 && tr.t <= tEnd).map((tr) => tr.px);
    if (p.length < 6) return null;
    const rs = [];
    for (let i = 1; i < p.length; i++) if (p[i - 1] > 0) rs.push(Math.log(p[i] / p[i - 1]));
    if (rs.length < 5) return null;
    const m = rs.reduce((a, b) => a + b, 0) / rs.length;
    const v = rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1);
    const dt = windowMs / 1000 / rs.length;
    return Math.sqrt(v / dt);                // σ per second
  }
  qtySince(t0) { let s = 0; for (const tr of this.trades) if (tr.t >= t0) s += tr.qty; return s; }
}

/** depth-$ within ±band fraction of mid for a snapshot book (G3 input). */
export function depthWithinBand(book, bandFrac) {
  const bid1 = book.bids[0]?.[0], ask1 = book.asks[0]?.[0];
  if (!bid1 || !ask1) return 0;
  const mid = (bid1 + ask1) / 2;
  let d = 0;
  for (const [px, qty] of book.bids) { if (px >= mid * (1 - bandFrac)) d += px * qty; else break; }
  for (const [px, qty] of book.asks) { if (px <= mid * (1 + bandFrac)) d += px * qty; else break; }
  return d;
}
