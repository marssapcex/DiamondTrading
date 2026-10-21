// DiamondTrading GALE engine — runnable wiring demo (mock mode).
// `node engine/index.js`  → routes a mock 3-venue set, prices a BTC 1000x 60s ticket,
// prints the signed-payload skeleton. Live mode swaps MockVenue for the real adapters
// (engine/venues/live.js) when running on unrestricted infra + funded keys.
import { MockVenue } from "./venues/mock.js";
import { routeAsset, payoutCeiling, SpikeBreaker } from "./caps.js";
import { offerMultiplier, clampMultiplier } from "./pricer.js";

const venues = {
  binance: new MockVenue("binance",    { lambdaUsd: 14_200, depthUsd: 25_000_000 }),
  hyperli: new MockVenue("hyperliq",   { lambdaUsd:  9_500, depthUsd:  9_000_000 }),
};

const route = await routeAsset(Object.values(venues), "BTC");
console.log("G1 route:", route.primary.venue.name,
  "| dual-read:", route.dualRead ? route.crossCheck.venue.name : "none");

const T = 2_000_000;                                   // house treasury $
const omega = 10;
const t0 = Date.now();
const tape = route.primary.venue.startTape("BTC");
route.primary.venue.feedSeries("BTC",
  Array.from({ length: 61 }, (_, i) => [t0 - 30_000 + i * 500, 84_750 + 12 * Math.sin(i / 2.3), 10]));
const sigma = tape.sigma(t0, 30_000) ?? 0.0004;                  // fallback ref vol
const breaker = new SpikeBreaker();
const brk = breaker.allowed("BTC", sigma, 0.0004, t0);

const L = 1000, tau = 60;
const { pBust, mFair, mOffer } = offerMultiplier(L, sigma, tau, 0.02);
const m = clampMultiplier(mOffer, { classMaxX: 25 });
const ceil = payoutCeiling({ treasuryUsd: T, lambdaUsdPerSec: 14_200, omegaSec: omega,
  dualRead: route.dualRead });

console.log(`G4 breaker: ${brk ? "OPEN" : "TRIPPED"} (σ_now=${sigma.toExponential(2)})`);
console.log(`price: L=${L} τ=${tau}s  P(bust)=${pBust.toFixed(3)}  M_fair=${mFair.toFixed(3)}x` +
  `  M_offer=${m ? m.toFixed(3) + "x" : "REFUSED"}  (ρ=2%)`);
console.log(`G3 ceiling: maxPayout ≤ $${ceil.toFixed(0)} per position (T=$${T}, ω=${omega}s)`);
