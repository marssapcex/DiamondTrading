# DiamondTrading — the final consolidated model

*(Deep-synthesis capstone of the RUNWAY research line. Code: `contracts/`. Engine spec: `ALGORITHM.md`. Venue data: `research/LIQUIDITY.md`. Name: DiamondTrading; token contract stays `EDGE`, branded DIAMOND in UI [ASSUMED: naming decision].)*

## What it is

The papertrade game, exactly — post margin `S`, drag leverage to 1000x, see your bust price,
win or die in 30–300 seconds, get token back when you lose — rebuilt so that every audited
death-trap of the original does not exist as a code path, with **more underlyers, a lower
published fee, three-venue routed settlement (Binance / Hyperliquid), and a smarter
mint**.

## Pillar 1 — Gameplay (identical to the original)

Margin `S`, leverage `L ∈ [1,1000]`, entry = trade-TWAP (2s), bust = entry∓(1/L), payout
linear in the move, capped at max-win `M·S` shown up-front [COMPUTED from ALGORITHM.md §1].
Default mode is the binary bust loop (`RunwayHouse` INSTANT tier); "pro mode" exposes the
same position as a capped-vanilla ramp (`RunwayOptions`) where partial moves pay partially
[COMPUTED: band = M/L mapping]. Full max payout is locked at sale — no solvency queue, no
side-buckets, no mint-to-cover anywhere (G7).

## Pillar 2 — Fees: cheaper, on purpose

- Target house edge `ρ = 2%` embedded in the multiplier, published as a number
  [ASSUMED: launch parameter]; comparable turbo/binary houses run 4–6% effective [RECALLED].
- No deposit/withdraw fee, no funding, no per-trade commission [ASSUMED].
- Losers are partially rebated in EDGE (Pillar 4) → effective net cost < ρ [COMPUTED].
- Revenue waterfall (of realized house revenue): ≤30% mint budget (hard-capped on-chain
  [CITED: EdgeDistributor]), ~60% LP first-loss capital [ASSUMED], ~10% EDGE stakers
  via RevenueSplit [CITED: RevenueSplit.sol], remainder ops. The engine can *afford* 2%
  because G2–G4 cut the adverse-selection tax that forces competitors to 4–6%.

## Pillar 3 — Venue router v2 (3 venues, measured, not vibes)

Adapters: Binance (spot+futures) and Hyperliquid (WSS now, L1Read
proofs later). Every 5s the engine samples per-asset per-venue flow `λ` and book depth
within the ticket band; route = argmax depth [ASSUMED: cadence]. Current measured routing
[CITED: LIQUIDITY.md, 2026-10-22 Binance snapshots; 2026-10-20 HL screenshot]:

| asset | venue(s) | note |
|---|---|---|
| BTC, ETH | Binance (1°) + HL cross-check | HL lists deep BTC/ETH perps ($2.5B/$1.1B 24h [CITED: HL screenshot]); dual-read from day one |
| SOL | Binance + HL dual-read | measured comparable ($190M ≈ $232M/24h) |
| XRP, BNB | Binance | router decides live |
| HYPE | **Hyperliquid** | 6x deeper than Binance spot ($345M vs $56M/24h) |
| SP500, NASDAQ100 | Hyperliquid (HIP-3) | only 24/7 venue; quoter curfew in thin hours |
| DOGE | Binance (tier C, tight caps) | λ floor asset |

Settlement on any dual-listed asset requires two-venue print agreement within 12bp
[ASSUMED tolerance] — an attacker must move BOTH venues or the ticket voids to refund
(G8), which raises manipulation cost beyond either single venue [COMPUTED].

## Pillar 4 — Smart mint v2 ("mint khi thua", but un-farmable)

Per 6h epoch [CITED: EdgeDistributor mechanics]:

- eligible base: address's **net loss** (losses − wins, positive only) [CITED];
- **weight `w = √(netLoss × feesPaid) × loyalty`** [ASSUMED formula]: you must have lost
  AND paid real rake; √ kills linear whale farming; `loyalty = 1.25` if the address holds
  staked EDGE through the epoch [ASSUMED];
- **solvency throttle**: epoch emission scale `= clamp(SRI/1.5, 0, 1)` — mint runs hot only
  while the house is healthy, cools automatically toward rehab [ASSUMED formula];
- **hard budget unchanged**: `mint ≤ 30% × signed revenue anchor` [CITED: EdgeDistributor].
  Pro-rata over a FIXED budget means sybils split the same pie — farming scales nowhere
  [COMPUTED from pro-rata math].

## Pillar 5 — Dynamic manipulation-cost caps (G3, unchanged)

Per-position payout ceiling `P_max = min(T/60, 0.30·T, κ·λ·ω)` on measured routed-venue
flow, `κ = 1/4` single-read / `1/3` dual-read [ASSUMED]; vol-spike breaker G4; TWAP
persistence G2. Ceilings auto-shrink in thin hours — off-hours equity perps protect
themselves without human scheduling.

## Pillar 6 — Launch profile: reserve-only

Launch with INSTANT semantics only (every position fully reserved at sale, oversell =
revert). The claims/runway tier stays in the code base, disabled by config [ASSUMED:
launch decision]. Attesters 2-of-3, threshold hard-floored at 2, owner → Safe+timelock,
stall → refund. See README trust declarations.

## Built vs remaining

| piece | status |
|---|---|
| house, options, verifiers, mint distributor, staker split, class table, menu config | DONE + tested on-chain: 55/55, 33/33, fuzz 3×251 green |
| venue adapters (Binance/HL + Mock twin), quoter (σ-pricing, G3/G4), attester workers | DONE in engine/, 38/38 tests green (live-exchange calls geo-blocked in sandbox — certified offline + ganache interop) |
| epoch ledger indexer (computes P4 weights → merkle → EdgeDistributor) | DONE in engine/ledger.js — root+anchor accepted on-chain in tests |
| frontend (papertrade-parity UX) | after engine |
| L1Read print-proof verifier on HyperEVM | open design item |

## TÓM TẮT (Vietnamese)

DiamondTrading = papertrade y nguyên (margin, kéo đòn bẩy 1000x, hiện giá bust, thắng thua
trong 30–300s, thua được mint token) nhưng: **phí rẻ hơn** (edge công khai 2%, không phí
nạp/rút, thua được rebate bằng EDGE); **nhiều tài sản hơn** (BTC, ETH, SOL, HYPE, XRP, BNB,
SP500, NAS100, DOGE-watchlist); **settle thông minh hơn** — Binance/Hyperliquid, mỗi
tài sản theo sàn đo được sâu nhất, tài sản list 2 nơi phải khớp giá hai sàn mới được ký
(HYPE đi Hyperliquid vì sâu gấp 6 lần Binance); **mint khôn ngoan hơn** — tính lỗ ròng,
trọng số √(lỗ × phí đã trả) × loyalty, tự hạ nhiệt khi nhà cái yếu, trần cứng ≤30% doanh
thu thật nên bot farm không đào được gì; **khó exploit hơn** — không queue không side-bucket,
trần lệnh theo chi phí thao túng đo trực tiếp, giá settle = TWAP lệnh khớp thật, ngắt mạch
khi vol spike.
