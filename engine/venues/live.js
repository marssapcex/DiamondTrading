// Live venue adapters (Binance / Hyperliquid) — endpoint-complete, NOT live-tested
// in this sandbox (both geo-blocked from here — see research/LIQUIDITY.md).
// Runtime hosts without those blocks use these directly; venue set is pluggable.
// Bybit was evaluated and dropped from the launch router (see LIQUIDITY.md).
import { TradeTape } from "./base.js";

const j = (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

export class BinanceVenue {
  constructor({ futures = true } = {}) {
    this.name = futures ? "binance-futures" : "binance";
    this.rest = futures ? "https://fapi.binance.com/fapi/v1" : "https://api.binance.com/api/v3";
  }
  async fetchTicker24h(asset) {
    const d = await fetch(`${this.rest}/ticker/24hr?symbol=${asset}USDT`).then(j);
    return { quoteVolume: Number(d.quoteVolume) };
  }
  async fetchDepth(asset, limit = 1000) {
    const d = await fetch(`${this.rest}/depth?symbol=${asset}USDT&limit=${limit}`).then(j);
    return { bids: d.bids.map(([p, q]) => [Number(p), Number(q)]),
             asks: d.asks.map(([p, q]) => [Number(p), Number(q)]) };
  }
  startTape(asset, { pollMs = 900 } = {}) {
    const tape = new TradeTape();
    let fromId;
    const tick = async () => {
      try {
        const q = fromId ? `&fromId=${fromId + 1}` : "&limit=1000";
        const rows = await fetch(
          `${this.rest}/aggTrades?symbol=${asset}USDT${q}`).then(j);
        for (const t of rows) { tape.add(Number(t.T), Number(t.p), Number(t.q)); fromId = t.a; }
      } catch (_) { /* retry next tick */ }
    };
    const h = setInterval(tick, pollMs); tick(); tape.stop = () => clearInterval(h);
    return tape;
  }
}

export class HyperliquidVenue {
  constructor() { this.name = "hyperliquid"; this.rest = "https://api.hyperliquid.xyz/info"; }
  async _post(body) {
    return fetch(this.rest, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
  }
  async fetchTicker24h(asset) {
    const d = await this._post({ type: "metaAndAssetCtxs" });
    const ix = d[0].universe.findIndex((u) => u.name === asset);
    if (ix < 0) throw new Error(`no HL market ${asset}`);
    return { quoteVolume: Number(d[1][ix].dayNtlVlm) };
  }
  async fetchDepth(asset, _limit = 1000) {
    const d = await this._post({ type: "l2Book", coin: asset });
    return { bids: d.levels[0].map((l) => [Number(l.px), Number(l.sz)]),
             asks: d.levels[1].map((l) => [Number(l.px), Number(l.sz)]) };
  }
  startTape(asset, { pollMs = 900 } = {}) {
    const tape = new TradeTape();
    let lastT = 0;
    const tick = async () => {
      try {
        const rows = await this._post({ type: "recentTrades", coin: asset });
        for (const t of rows.slice().reverse()) {
          if (t.time > lastT) { tape.add(t.time, Number(t.px), Number(t.sz)); lastT = t.time; }
        }
      } catch (_) {}
    };
    const h = setInterval(tick, pollMs); tick(); tape.stop = () => clearInterval(h);
    return tape;
  }
}
