# RUNWAY → DiamondTrading

> Final consolidated product model: **MODEL.md**. This repo is its on-chain + engine stack.

Two-tier fixed-odds turbo-ticket house for crypto underlyers — papertrade's addictive 1000x
loop re-instrumented so that its audited failure classes **cannot exist as code paths**.

- **INSTANT tier**: every ticket's *full payout* (`M·S`) is locked at sale; oversell reverts;
  wins pay atomically. (The KNOCKOUT engine.)
- **RUNWAY tier**: Martin Galer's zero-cap bootstrap, repaired — bounded flow-based stake caps,
  and wins the treasury can't cover become **Claims**: public FIFO positions that earn real-revenue
  yield while waiting, are tradable on an internal market, and can be exited for principal
  (winnings forfeit → solvency improves for everyone left in line, exactly as the whitepaper
  intended).
- **One house, one ledger.** Every liability is its own object or a counter touched in exactly
  one transition. No side-buckets, no session accumulators, no settlement-mode toggles — the
  pattern surface of all 42 Guardian findings on papertrade is structurally absent.

## Contracts (v3)

| file | role |
|---|---|
| `contracts/RunwayHouse.sol` | Core AMM: pricing, buy/redeem, verifier-settled outcomes, claims queue, internal claim market, LP vault, per-underlyer menu table (v3.1). ~17.3 KB bytecode. |
| `contracts/OutcomeVerifier.sol` | `IOutcomeVerifier` + `MultiAttesterVerifier`: M-of-N EIP-712 attesters (default 2-of-3). Domain binds the *verifier*; the signed struct binds the *house* + ticket + outcome. Threshold setter is hard-floored at 2 — governance can never degrade to 1-of-N. |
| `contracts/RunwayOptions.sol` | Options-flavoured papertrading: capped-vanilla CALL/PUT spreads (payoff ramps linearly from strike, saturates at band edge — graded wins, not digital). Full-reserve book (maxPay locked at sale), European settle via attested close price, minimal LP vault. `MultiPriceVerifier` included in-file. ~10.4 KB + verifier. |
| `contracts/EdgeDistributor.sol` | Epoch NET-LOSS → merkle airdrop of EDGE. Every epoch mint is budget-capped at **30% of a revenue anchor personally signed by a bounded `budgetAttester`** — compromised governance cannot print unbacked emissions. Sorted-pair merkle proofs, 7-day claim window, `MAX_EPOCH_GAP`. |
| `contracts/RevenueSplit.sol` | EDGE staking for a share of house revenue: cumulative USDC reward index (1e18-scaled) per staked EDGE, 7-day unbonding, house-only `notifyRevenue`, sink pulls via allowance. |
| `contracts/EdgeToken.sol` | Plain ERC-20 with a single minter (the distributor in production). |
| `contracts/MockUSDC.sol` | 6-decimal test fixture only — not for production builds. |

## Build & verify

```bash
npm install          # solc, ethers v6, ganache
node compile.js      # solc 0.8.26, viaIR, optimizer 200 runs — zero warnings
node test/smoke.js   # scenario suite (house):  55/55 PASS
node test/smoke-options.js   # scenario suite (options):  33/33 PASS
SEED=1337 node test/fuzz.js   # property fuzz: 251 invariant checks after every op batch
```

Fuzz seeds run to date: **1337 / 42 / 777 × 250 ops each — all 251 invariant checks passed per run**
(`B ≥ locked` never breaks; queue counters never go negative; FIFO head never overflows;
settlement only via valid attestation).

## The drain rule (solvency core)

```
T = balance − instantReserved − yieldPool          [reverts if < 0]
every treasury outflow must leave T ≥ SRI_FLOOR(10%) × queueStack_post
```

`queueStack_post` matters: paying/forfeiting a claim *removes* liabilities, so the rule
evaluates the stack AFTER the action (`_canPayFromTreasury(amount, removedLiability)`).
Call sites: instant-runway win pay, rebate pay, refund, FIFO crank, claim forfeit, LP exit,
and the v3 staker-distribution outflow (`distributeToStakers`) — all drain-gated.

## Settlement (v3): attestation, not a keeper

Tickets settle through `settleWithProof(ticketId, outcome, signatures)` — **permissionless**:
anyone can relay a valid proof. Validity = M-of-N EIP-712 attestations from the
`MultiAttesterVerifier` attester set (shipped default 2-of-3; threshold can only be raised,
never set to 1). Duplicate signers and non-attesters are silently discounted, never
double-counted. `refundAfterStall` (expiry+24h → anyone refunds stake) remains as the final
failsafe if attesters stall entirely. The verifier contract is swappable via
`setOutcomeVerifier`, so a true Hyperliquid L1Read print-proof verifier can drop in later
without touching the house.

**Why not just reference Binance?** Liquidity depth buys manipulation-resistance; verifiability
buys trustlessness — and settlement needs both, in that order of difficulty. Binance is the
deepest venue, but its prints never touch a chain: any Binance-referenced settlement is an
attester *claiming* what Binance showed, forever 2-of-3-trusted (TLS proofs of API responses
prove what the API returned, not that a trade printed). Pyth/Chainlink medians are on-chain but
heartbeat-lagged and smoothed — for 30–60s tickets a stale median is a textbook latency exploit.
HL prints are consensus-finalized state: the only reference that can eventually delete attesters
from the settle path entirely. Meanwhile the class table (v3.1) pays for HL's shallower books
with tighter multipliers and smaller max bets, and the quoter is free to *price* from Binance
depth even when *settlement* references HL prints. (And for HYPE itself, Hyperliquid IS the
deep venue.)

## v1 findings — found by self-adversarial review + the test harness, fixed in v2

| # | severity | finding | fix |
|---|---|---|---|
| F1 | **critical** | Instant tier locked only `(M−1)·S`; LP mass-exit + live win could drive `B − locked < 0` (invariant would revert = DoS / asset freeze) | reserve the **full payout `M·S`**; user stakes sit inside the lock; settle-WON is now treasury-neutral by construction (regression test [D]) |
| F2 | **high** | Paid/forfeited claims kept accruing yield-index deltas forever → free drain of `yieldPool` | yield settles **at resolution time**, paid inline; post-pay `claimYield` reverts |
| F3 | medium | `depositClaimYield` with an empty queue stranded funds permanently | reverts `no live claims` |
| F4 | low | keeper could settle `EXPIRED` before a ticket's own expiry | time-pinned on-chain |
| F5 | **logic** | `_drainOk` evaluated the PRE-action queue stack, wedging the FIFO crank against its own floor (paying the head that *improves* solvency was blocked) | post-action evaluation everywhere; regression [F] in smoke |

## Trust declarations (in the open, not in comments)

- `quoterSigner` — off-chain quote engine (σ̂→multiplier). On-chain clamps cap its damage to the
  menu envelope (M ∈ [1.05x, 25x], TTL 30s, EIP-712, per-buyer slippage bound — audit KV-14).
- **Attester set** (`MultiAttesterVerifier`) — outcome honesty requires 2-of-3 collusion;
  replaceable by governance; threshold floored at 2; stall failsafe `refundAfterStall` is live
  on-chain. v4 design target: Hyperliquid L1Read proof of trade-print persistence (ω=2s,
  symmetric win/KO), no BBO midpoints (audit KV-01) as a drop-in `IOutcomeVerifier`.
- `budgetAttester` (EdgeDistributor) — bounded: can only *lower* effective emissions (sign a
  small revenue anchor), never exceed realized-revenue accounting or touch principal.
- `owner` — EOA in this testnet build; production = Safe 2-of-3 + OZ TimelockController with
  immutable 7-day `minDelay` (audit L-04 / I-20).

## RUNWAY Options (turbo spreads) — why this is NOT a rename

House tickets are digital (pay M*S or 0). Options pay intrinsic value on a ramp:
`paid = maxPay · min(|close−strike|, band)/band` in the direction, else 0 — a European
vertical spread as one unit. That changes the product's shape: small moves win small (graded
wins keep engagement at sane multipliers), full band wins full, and the max payout is still
bounded, so the book is **fully reserved at sale** — no claims queue needed anywhere in the
options contract. Strike = quoter-signed (TTL 30s + buyer `worstStrike` guard), close =
attester-signed price (2-of-3), European time-pin, 24h stall → premium refund. LP is a minimal
shares vault; scenarios deliberately let buyers win to prove first-loss absorbs a negative edge
and the sole LP drains the exact residual.

## Rule → code map (audit-driven)

| rule | where | kills |
|---|---|---|
| per-ticket full-payout reservation, oversell=revert | `buyTicket` | KV-03/08, H-01/02, M-02/05 queue-vs-ledger class |
| max-bet = T/60 (instant) · max(bootstrapCap,(T+flow)/60) (runway) | `maxStake*` | KV-07, M-02/05 stake-tail; "unconstrained sizing" sin |
| claims: FIFO, yield-bearing, tradable, forfeitable | `claims[]`, `crankPayClaims`, `list/buyClaim`, `forfeitClaim` | Martin Galer repaired: waiting is a priced product |
| kill gate: oldest claim > 30d → rehab (sales halt), auto-recover on drain | `_checkKillGate`, `pokeKillGate` | teeth in code, not promises |
| claim yield from real revenue deposits only, `T ≥ amount` required | `depositClaimYield` | KV-05/06 extraction patterns |
| permissionless settlement via 2-of-3 EIP-712 attestation; threshold floor 2 | `settleWithProof`, `MultiAttesterVerifier` | KV-04 / L-04 single-keeper bottleneck |
| attester-stall → permissionless stake refund | `refundAfterStall` | L-11 stale settlement |
| epoch emissions ≤ 30% of signed revenue anchor | `EdgeDistributor.commitEpoch` | KV-04 / M-05 unbacked-mint class |
| staker revenue via house-pull allowance, drain-gated distribution | `RevenueSplit`, `distributeToStakers` | cross-contract accounting drift |
| pause = sales only; settle/crank/market/refund never pause | `salesPaused` | L-11 |
| EIP-712 quotes + user min-multiplier bound + clamps + TTL | `buyTicket` | KV-14 intent trust |
| 7-day LP exit + drain-rule gate | `lpRequestExit/lpWithdraw` | bank-run blunting |
| 7-day EDGE unbonding; reward accrual via cumulative index | `RevenueSplit` | reward-manipulation flash stake |
| per-underlyer menu: mult cap + stake divisor + enable flag; thin classes lose the bootstrap floor; disable halts sales only, never settlement | `classCfg`, `setClassCfg`, class-aware `maxStake*` | menu expansion (HYPE/SOL/S&P…) without relaxing global bounds; manipulation-cost asymmetry bounded per class |
| all numeric config validated at write | setters | L-06 |

## Initial underlyer menu (class table v3.1)

Source of truth: `config/menu.json` — applied post-deploy with
`RPC_URL=.. OWNER_KEY=.. HOUSE_ADDR=.. node scripts/apply-menu.js`.

| classId | underlyer | HL market | mult cap | max-bet | settlement reference |
|---|---|---|---|---|---|
| 0 | BTC | BTC-USDC | 25x | T/60 | Binance+HL attester cross-check |
| 1 | ETH | ETH-USDC | 25x | T/60 | Binance+HL attester cross-check |
| 2 | SOL | SOL-USDC | 10x | T/120 | Binance+HL attester cross-check |
| 3 | HYPE | HYPE-USDC | 10x | T/120 | HL print — HL is the deep venue for HYPE |
| 4 | S&P500 | S&P500-USDC (HIP-3) | 10x | T/120 | HL print — only 24/7 venue; quoter halts/haircuts off-hours |
| 5 | NASDAQ100 | XYZ100-USDC (HIP-3) | 10x | T/120 | HL print — only 24/7 venue; same off-hours rule |
| 6 | ZEC | ZEC-USDC | 10x | T/120 | HL print — watchlist tier |

Caps follow the admission rule (manipulation cost ≥ 20x class max payout); tier B pays for
shallower books with smaller multipliers and stakes. Equity-index classes (4, 5) are only as
safe as the HIP-3 book during the ticket window — off-hours thinness is handled at the quoter
(off-chain refusal/haircut), because the on-chain table is a static hard ceiling, not a meter.

## GALE engine (papertrade-exact gameplay, unexploitable rebuild)

See `ALGORITHM.md` (venue routing G1, trade-TWAP persistence G2, liquidity-derived dynamic
position caps G3 `P_max = min(T/60, 0.30T, κ·λ·ω)`, vol-spike breaker G4, loss-mint budget G6,
full-reserve liability G7, attester tolerance G8) and `research/LIQUIDITY.md` (measured venue
data, 2026-10-22 Binance snapshots + HL). The leverage/bust loop maps onto the INSTANT tier &
capped-vanilla spreads with zero new on-chain attack surface; the quoter/attester engine lives in `engine/`
(venue adapters Binance/HL + Mock, router G1, TWAP G2, caps G3, breaker G4, pricer ρ=2%,
EIP-712 quoter/attester, smart-mint ledger + EdgeDistributor-compatible merkle):
`node engine/index.js` demo, `node test/engine.test.js` → 38/38 PASS including ganache interop
(engine-signed quotes/attestations/mint roots accepted by the deployed contracts).

## Deploy checklist (prod)

1. Replace owner with immutable-floor timelock + Safe 2-of-3.
2. Real USDC; drop `MockUSDC` from build (it is a test fixture).
3. Production attester set: 3+ independent bonded operators + monitoring on solvency views.
4. EdgeDistributor as `EdgeToken.minter` with bonded `budgetAttester` (already implemented —
   needs production keys).
5. Two external reviews + public contest; scope: drain-rule edge cases, EIP-712 replay inside the
   TTL window (economically neutral by construction — same terms), attestation replay across
   houses (house-bound struct hash — verify), crank griefing, market UX front-runs, fuzz seeds drift.

## Honest gaps (not done yet)

- Underlyer admission policy (which classIds map to which asset, with what caps) is
  governance configuration, not code — the on-chain table enforces bounds once set.
  Recommended admission rule: cost to move the HL print by the ticket's win-band sustained
  over the ω window ≥ 20x max payout for that class (measurable from L1Read book depth).
- Outcome verification is attester-quorum, not cryptographic trade-print proof. The L1Read
  verifier is the biggest open item and is a drop-in `IOutcomeVerifier` replacement.
- LP shares are non-transferable ledger entries (MVP choice).
- `claims[]` is unbounded storage (fine at MVP scale; production wants head-pointer compaction
  or an enumerable-paged view layer off-chain).
