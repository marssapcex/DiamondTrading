// Epoch ledger + smart-mint v2 (MODEL.md P4).
// Feeds: per-position settled records { owner, stake, payout, feePaid, ts }.
// Per epoch: net loss per address, weight w = √(netLoss × feesPaid) × loyalty,
// solvency throttle scale = clamp(SRI/1.5, 0, 1), budget-capped pro-rata mint,
// merkle root/proofs in the EXACT EdgeDistributor format (OZ sorted-pair,
// leaf = keccak256(concat(keccak256(abi.encode(epochId, account, amount))))).
import { ethers } from "ethers";

export class EpochLedger {
  constructor({ epochMs = 6 * 3600 * 1000, revenueShareBps = 3000, sriTarget = 1.5 } = {}) {
    this.epochMs = epochMs;
    this.revenueShareBps = revenueShareBps;      // 30% mint budget, mirror of contract BUDGET_BPS
    this.sriTarget = sriTarget;
    this.records = [];
  }
  add(r) { this.records.push(r); }
  epochOf(ts) { return Math.floor(ts / this.epochMs); }

  /** totals for one epoch: per-address netLoss & feesPaid, plus house realized revenue */
  summarize(epochId) {
    const t0 = epochId * this.epochMs, t1 = t0 + this.epochMs;
    const acc = new Map();   // owner -> { stake, paid, fees }
    let stakeSum = 0n, paySum = 0n;
    for (const r of this.records) {
      if (r.ts < t0 || r.ts >= t1) continue;
      const a = acc.get(r.owner) || { stake: 0n, paid: 0n, fees: 0n };
      a.stake += r.stake;                     // one record per position: stake in, payout out
      a.paid += r.payout;                     // partial win still loses (stake − payout)
      a.fees += r.feePaid; acc.set(r.owner, a);
      stakeSum += r.stake; paySum += r.payout;
    }
    const revenue = stakeSum > paySum ? stakeSum - paySum : 0n;
    return { acc, revenue };
  }

  /** smart-mint v2 weights. loyaltySet: Set of addresses holding staked EDGE through epoch.
   *  sri: current solvency ratio (B/queueStack), Infinity when queue empty. */
  weights(epochId, { loyaltySet = new Set(), sri = Infinity } = {}) {
    const { acc, revenue } = this.summarize(epochId);
    const scale = Math.max(0, Math.min(1, (sri === Infinity ? 10 : sri) / this.sriTarget));
    const rows = [];
    for (const [owner, a] of acc) {
      const netLoss = a.stake > a.paid ? a.stake - a.paid : 0n;   // NET of the whole epoch
      if (netLoss === 0n || a.fees === 0n) continue;              // must lose AND pay rake
      const w = Math.sqrt(Number(netLoss) * Number(a.fees)) * (loyaltySet.has(owner) ? 1.25 : 1);
      rows.push({ owner, netLoss, w });
    }
    return { rows, revenue, scale };
  }

  /** budget-capped pro-rata mint amounts (EDGE 18dp as BigInt). */
  mintAmounts(epochId, opts = {}) {
    const { rows, revenue, scale } = this.weights(epochId, opts);
    const anchor = revenue;                                   // budgetAttester signs this anchor
    const budget = anchor * BigInt(this.revenueShareBps) / 10_000n;
    const effBudget = BigInt(Math.floor(Number(budget) * scale));
    const wSum = rows.reduce((s, r) => s + r.w, 0);
    const out = new Map();
    let total = 0n;
    for (const r of rows) {
      const amt = wSum ? BigInt(Math.floor(Number(effBudget) * r.w / wSum)) : 0n;
      if (amt > 0n) { out.set(r.owner, amt); total += amt; }
    }
    // EdgeDistributor treats totalMint and the anchor in the SAME units; the ledger keeps
    // USD records in 6dp, EDGE mint in 18dp -> publish anchor in 18dp "USD-equivalent".
    return { amounts: out, total, revenue: anchor, budget: effBudget,
             anchor18: anchor * 10n ** 12n, budget18: effBudget * 10n ** 12n };
  }
}

// ---------- merkle (EdgeDistributor-compatible) ----------
export const leafOf = (epochId, account, amount) => ethers.keccak256(ethers.concat([
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
    .encode(["uint256", "address", "uint256"], [epochId, account, amount]))]));

export function buildMerkle(epochId, entries /* Map<address, amount> | [[address, amount]] */) {
  const arr = [...entries.entries ? entries.entries() : entries]
    .map(([account, amount]) => ({ account, amount, leaf: leafOf(epochId, account, amount) }));
  arr.sort((a, b) => (a.leaf < b.leaf ? -1 : 1));
  const layers = [arr.map((e) => e.leaf)];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1], nxt = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 === cur.length) { nxt.push(cur[i]); continue; }   // odd promote, OZ-compatible
      const [a, b] = cur[i] < cur[i + 1] ? [cur[i], cur[i + 1]] : [cur[i + 1], cur[i]];
      nxt.push(ethers.keccak256(ethers.concat([a, b])));
    }
    layers.push(nxt);
  }
  const root = layers[layers.length - 1][0] ?? ethers.ZeroHash;
  const proofOf = (account) => {
    const i = arr.findIndex((e) => e.account.toLowerCase() === account.toLowerCase());
    if (i < 0) return null;
    const proof = []; let idx = i;
    for (let d = 0; d < layers.length - 1; d++) {
      const layer = layers[d];
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sib < layer.length) proof.push(layer[sib]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  };
  return { root, proofOf, leaves: arr.map((e) => ({ account: e.account, amount: e.amount })) };
}

/** budgetAttester signs the revenue anchor: EIP-191 personal_sign over
 *  keccak256(abi.encode(epochId, revenueAnchor)) — mirror of EdgeDistributor.postEpoch. */
export function signRevenueAnchor(wallet, epochId, revenueAnchor) {
  const h = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
    .encode(["uint256", "uint256"], [epochId, revenueAnchor]));
  return wallet.signMessage(ethers.getBytes(h));
}
