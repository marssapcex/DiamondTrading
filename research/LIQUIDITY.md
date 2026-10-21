# Liquidity research — venue routing per underlyer

Snapshot source: Binance public market-data mirror (`data-api.binance.vision`, spot),
fetched 2026-10-22 ~18:30 UTC [CITED: api.binance.vision snapshots, closeTime 1792607527].
Binance futures (`fapi`) geo-blocked our fetcher — spot books/volumes are the CONSERVATIVE
floor; USDT-M futures depth is structurally ≥ spot [RECALLED: market structure].

## Measured (24h spot, Binance)

| asset | 24h quote volume | trades 24h | top-of-book bid/ask $ | spread | λ = vol/86400 ($/s) [COMPUTED] |
|---|---|---|---|---|---|
| BTCUSDT | $1.225B [CITED] | 2.87M [CITED] | 118k / 840k [CITED] | ~0.01bp | $14,180/s |
| ETHUSDT | $820.5M [CITED] | 3.49M [CITED] | 148k / 43k [CITED] | ~0.4bp? (0.01/2517) | $9,497/s |
| SOLUSDT | $190.6M [CITED] | 536k [CITED] | 23k / 43k [CITED] | ~0.9bp | $2,206/s |
| XRPUSDT | $124.9M [CITED] | 480k [CITED] | 47k / 47k [CITED] | ~0.7bp | $1,446/s |
| BNBUSDT | $75.4M [CITED] | 442k [CITED] | 1.3k / 71k [CITED] | ~0.13bp | $873/s |
| HYPEUSDT (Binance spot) | $55.9M [CITED] | 192k [CITED] | 2.2k / 3.3k [CITED] | ~1.2bp | $647/s |
| DOGEUSDT | $36.2M [CITED] | 278k [CITED] | 16k / 19k [CITED] | ~1.2bp | $419/s |
| HYPE (Hyperliquid perp) | $345M [CITED: user screenshot app.hyperliquid.xyz 2026-10-20] | — | ~$1–20k per 0.1bp level near touch [CITED: same] | ~0.13bp | $3,993/s |

Notes:
- HYPE IS listed on Binance spot (bid 82.150 / ask 82.160) [CITED: HYPEUSDT depth snapshot],
  but its book within ~1.5% is only ~$0.9M visible [CITED: 100-level HYPEUSDT depth] and its
  24h volume is ~6x smaller than Hyperliquid's HYPE perp ($55.9M vs $345M) [CITED + CITED].
  → Venue routing places HYPE on Hyperliquid, matching the original prior.
- Binance books beyond the visible window are NOT measurable via public REST [CITED: API
  limits]; runtime depth must be re-measured by the quoting engine live (see ALGORITHM.md §G3).

## Dropped: Bybit (router is two-venue at launch)

Bybit v5 tickers (spot + linear, api.bybit.com / api.bytick.com) were geo-blocked at
CloudFront from our infra on 2026-10-22 [CITED: fetch attempts]. Evaluated and dropped
from the launch router: redundant for the launch menu (BTC/ETH/SOL/XRP/BNB/DOGE are
Binance-deepest; HYPE + HIP-3 equity are Hyperliquid-deepest). The router stays
venue-pluggable; any venue may re-enter after runtime measurement.

## Venue routing (deepest measurable venue per asset)

| asset | settlement venue | why |
|---|---|---|
| BTC, ETH | Binance | deepest global venue, prints dominate world price discovery |
| SOL | Binance + HL cross-check | Binance spot $190M ≈ HL perp $232M — comparable; dual-read mandatory |
| XRP, BNB | Binance | Binance-only meaningful depth |
| DOGE | Binance (watchlist — thin λ) | $419/s organic flow is easy to dominate; tight caps only |
| HYPE | Hyperliquid | deepest venue for its own token by ~6x |
| SP500, NASDAQ100 | Hyperliquid (HIP-3) | only 24/7 venue in existence for these perps |
