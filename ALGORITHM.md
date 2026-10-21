# The GALE engine — papertrade-exact gameplay, rebuilt to be unexploitable

Goal: play EXACTLY like papertrade (LONG/SHORT, margin, leverage slider up to 1000x,
bust-price shown, mint token on losses), but (a) more underlyers, (b) smarter algorithms,
(c) structurally stronger anti-exploit. Every on-chain substrate needed already exists in
this repo; this document specifies the OFF-CHAIN engine algorithms that make the game hard
to attack. Parameters marked [ASSUMED] are initial governance values, tunable by measurement.

## 1. Position semantics (papertrade-identical)

Player posts margin `S`, picks leverage `L ∈ [1, 1000]` [ASSUMED menu] and direction.
- `entry` = trade-TWAP of the routed venue over `ω_entry = 2s` ending at tx time [ASSUMED]
- `bust price` = entry·(1 − 1/L) LONG / entry·(1 + 1/L) SHORT — shown pre-trade
- close at expiry (30–300s): `close` = trade-TWAP over `ω_exit = 2s` ending at expiry [ASSUMED]
- payoff = `S · (1 + L · (close−entry)/entry)` in direction, floored at 0, capped at
  `maxPay = M · S` where `M` is the player's chosen take-profit class (menu shows "max win").
  With L=1000 the ±0.1% bust band dominates long before M does — same feel as papertrade;
  the cap is what keeps the house book full-reserve (their fatal queue class never exists).

On-chain mapping [COMPUTED from contract code]:
- full-leverage binary bust loop → `RunwayHouse.buyTicket` (INSTANT tier, full M·S reserved)
- ramp payoff (`RunwayOptions`) = the SAME position with band = `M/L` [COMPUTED]:
  a leveraged linear position capped at M·S is a vertical spread capped at band edge.

## 2. Anti-exploit stack G1–G8

### G1 — Venue routing (deepest measurable venue per asset)
Router scores each candidate venue by `D_a = EMA_1h(minute quote volume)` and picks argmax,
re-evaluated hourly [ASSUMED]. classId → venue binding is per-class config; attesters refuse
to sign prints from any other venue. Routing table: research/LIQUIDITY.md.

### G2 — Trade-TWAP persistence, never mid
entry/close are volume-weighted averages of REAL FILLS over the ω windows. Spoofing needs
real executed volume through the whole window (audit KV-01 BBO-mid class eliminated by
construction). Attesters independently ingest the venue trade stream (WSS), build the same
TWAP, and sign; tolerance check in G8.

### G3 — Liquidity-derived dynamic position caps  (the core new algorithm)
Manipulation requires dominating the reference over the measurement window. Lower bound on
attacker spend over window ω [COMPUTED]: organic flow `λ_a·ω` with `λ_a = venue 24h
quoteVolume / 86400` (measured live, EMA-smoothed, floor at 10th percentile [ASSUMED]).
Max allowed maxPay per position:

```
P_max(a, ω, T) = min( T/60 ,  0.30·T (dir risk share) ,  κ · λ_a · ω )     [κ = 1/4 ASSUMED]
```

Instantaneous consequences [COMPUTED from LIQUIDITY.md λ, ω=10s]:
| asset (venue) | λ | κ·λ·10s → per-position payout ceiling |
|---|---|---|
| BTC (Binance) | $14.2k/s | $35.4k |
| ETH (Binance) | $9.5k/s | $23.7k |
| HYPE (HL) | $4.0k/s | $10.0k |
| SOL (Binance) | $2.2k/s | $5.5k |
| XRP (Binance) | $1.4k/s | $3.6k |
| BNB (Binance) | $0.9k/s | $2.2k |
| DOGE (Binance) | $0.4k/s | $1.0k |

Note the asymmetry this creates vs papertrade: their flat sizecap lets a $419/s-flow asset
(DOGE) carry the same 1000x size as BTC — a standing invitation. Here the ceiling scales
with measured manipulation cost, automatically shrinking during thin sessions. The quoter
signs `P_max` per quote; the contract enforces the static tier caps as an outer bound
(never looser) — G3 can only tighten, never loosen [COMPUTED from setClassCfg semantics].

### G4 — Vol-spike circuit breaker
If realized `σ_30s > 4 × σ_median_30d` [ASSUMED], the quoter stops signing new quotes for
60s on that asset; in-flight quotes die by TTL (≤30s, on-chain). Kills stale-quote sniping
around macro prints and flash moves.

### G5 — Quote hygiene (already on-chain)
EIP-712, TTL ≤ 30s, buyer-bound, salt, worst-bound parameters. [CITED: RunwayHouse.sol v3.1]

### G6 — Loss-minted token, audit-hardened ("mint khi thua", papertrade-style)
Per-6h epoch, each address accrues `netLoss = Σ losses − Σ wins` [CITED: EdgeDistributor];
positive netLoss receives EDGE pro-rata, merkle-claimed (7d window). Hard budget:
`epochMint ≤ 30% × realizedRevenue_anchor`, the anchor signed by a bounded `budgetAttester`
[CITED: EdgeDistributor.sol]. Minting can NEVER exceed real revenue and never interacts with
position accounting — the entire H-01..M-05 gross-emission/side-bucket exploit class is
absent as code paths. EDGE accrues house-revenue share via `RevenueSplit` [CITED], giving
the lost-money token real cashflow — the repair of Martin Galer's "+EV emissions" promise.

### G7 — Full-reserve liability (already on-chain)
Every position locks its FULL max payout at open; oversell reverts instead of queueing
[CITED: RunwayHouse.sol]. Papertrade's solvency queue, side-buckets and mint-to-cover
machinery do not exist here at all.

### G8 — Attester quorum with cross-venue tolerance
2-of-3 [CITED: verifiers], each attester reading the routed venue's trade stream
independently. A settle/bust signature is produced iff |p_i − p_j| ≤ 12bp pairwise
[ASSUMED] and prints show ≥ λ_min traded over ω [ASSUMED=0.25·λ·ω]; otherwise the window is
declared NO-PRINT → the on-chain paths are either re-attest next window or stall-refund
(player whole). Honest failure, never a guessed price.

## 3. On-chain/off-chain split (what exists vs what this spec adds)

| piece | status |
|---|---|
| gameplay contracts (tickets, options), reserve accounting, class table | DONE on-chain, tested (55/55, 33/33) |
| loss-mint distributor + budget cap | DONE on-chain (EdgeDistributor) |
| staker rev-share | DONE on-chain (RevenueSplit) |
| G1/G2/G3/G4/G6-ledger/G8 quoting+attestation engine | THIS SPEC → `engine/` (next deliverable) |
| G8 trustless final form (L1Read print proofs on HyperEVM) | open design item |

## 4. Honest limits

- κ·λ·ω is a LOWER bound on manipulation cost, not a proof; books can be thinner than flow
  suggests in stress. Mitigations: κ=1/4, EMA floors, G4 halt, tier caps [ASSUMED].
- Equity perps (SP500/NAS100) have no second venue — G8 tolerance degrades to
  single-venue during HL anomalies; off-hours depth collapse is handled by G3 shrinking
  P_max automatically (λ falls) plus quoter curfews [ASSUMED curfew: US overnight].
- DOGE-class assets sit permanently near the κ·λ·ω floor — acceptable; menu breadth is not
  worth tail risk [ASSUMED: steering decision].
