// GALE engine offline test-suite.
// Pure-algorithm blocks run on MockVenue; interop blocks run against the real contracts
// on in-process ganache (quote -> buyOption, attestation -> settleWithPrice,
// ledger merkle + budgetSig -> EdgeDistributor postEpoch/claim).
const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const path = require("path");

const { TradeTape, depthWithinBand } = require("../engine/venues/base.js");
const { MockVenue } = require("../engine/venues/mock.js");
const { routeAsset, payoutCeiling, SpikeBreaker } = require("../engine/caps.js");
const { bustProb, offerMultiplier, clampMultiplier } = require("../engine/pricer.js");
const { Quoter, Attester, agreePrice } = require("../engine/quoter.js");
const { EpochLedger, buildMerkle, signRevenueAnchor, leafOf } = require("../engine/ledger.js");

const U = (n) => BigInt(n) * 10n ** 6n;
const E18 = (n) => BigInt(n) * 10n ** 18n;
const x = (n) => BigInt(Math.round(n * 1e4));
const PX = (n) => BigInt(Math.round(n * 1e8));

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name); } }

async function algos() {
  console.log("\n[EA] G1 routing + G3 caps + G4 breaker + G8 tolerance (mock venues)");
  {
    const deep = new MockVenue("deep", { lambdaUsd: 14_000, depthUsd: 3_000_000 });
    const thin = new MockVenue("thin", { lambdaUsd: 400, depthUsd: 100_000 });
    const lone = new MockVenue("lone", { lambdaUsd: 4_000, depthUsd: 900_000 });
    deep.fetchTicker24h = async () => ({ quoteVolume: 14_000 * 86400 });
    thin.fetchTicker24h = async () => ({ quoteVolume: 400 * 86400 });
    lone.fetchTicker24h = async () => ({ quoteVolume: 4_000 * 86400 });

    const r1 = await routeAsset([deep, thin], "BTC");
    ok(r1.primary.venue === deep, "router picks deepest venue");
    ok(r1.dualRead === false, "no dual-read when runner-up < 30% depth");

    const r2 = await routeAsset([deep, lone], "SOL");
    ok(r2.dualRead === true && r2.crossCheck.venue === lone, "dual-read when runner-up >= 30%");

    // G3: ceiling = min(T/60, 30%T, κλω)
    const c1 = payoutCeiling({ treasuryUsd: 6_000_000, lambdaUsdPerSec: 14_000, omegaSec: 10 });
    ok(c1 === Math.min(6_000_000 / 60, 1_800_000, 14_000 * 10 / 4),
        "G3 flow binds for deep venue: ~$35k");
    ok(Math.abs(c1 - 35_000) < 1, `BTC-class ceiling = ${c1}`);
    const c2 = payoutCeiling({ treasuryUsd: 1_000_000, lambdaUsdPerSec: 400, omegaSec: 10 });
    ok(Math.abs(c2 - 1_000) < 1, `DOGE-class ceiling = ${c2} (flow floor)`);
    const c3 = payoutCeiling({ treasuryUsd: 1_000, lambdaUsdPerSec: 14_000, omegaSec: 10 });
    ok(Math.abs(c3 - 1_000 / 60) < 1e-9, "tiny treasury binds via T/60");
    const c4 = payoutCeiling({ treasuryUsd: 1_000_000, lambdaUsdPerSec: 400, omegaSec: 10, dualRead: true });
    ok(Math.abs(c4 - 400 * 10 / 3) < 1e-6, "dual-read relaxes κ to 1/3");

    // G4 breaker
    const br = new SpikeBreaker({ mult: 4, coolMs: 60_000 });
    ok(br.allowed("BTC", 0.001, 0.001, 0) === true, "normal vol allowed");
    ok(br.allowed("BTC", 0.01, 0.001, 1_000) === false, "spike trips breaker");
    ok(br.allowed("BTC", 0.001, 0.001, 30_000) === false, "cooldown holds");
    ok(br.allowed("BTC", 0.001, 0.001, 70_000) === true, "breaker resets after cooldown");
  }

  console.log("\n[EB] G2 TWAP persistence (TradeTape)");
  {
    const tape = new TradeTape();
    // window [9000,11000]: 2 trades 10@1, 30@3 -> vwap = (10+90)/(1+3)=25
    tape.add(8_999, 50, 100);                    // outside window, must be excluded
    tape.add(9_100, 10, 1); tape.add(10_500, 30, 3);
    const v = tape.vwap(11_000, 2_000);
    ok(Math.abs(v.px - 25) < 1e-12, "vwap volume-weighted inside window only");
    ok(tape.vwap(5_000, 1_000) === null, "empty window = NO-PRINT (null)");
    tape.add(10_600, 88, 1);
    tape.add(10_400, 99, 1);                               // late arrival: must be dropped
    const v2 = tape.vwap(11_000, 2_000);
    ok(Math.abs(v2.px - (10 + 30 * 3 + 88) / 5) < 1e-12, "out-of-order trade dropped");
  }

  console.log("\n[EC] pricer");
  {
    const m1 = offerMultiplier(1000, 0.001, 60);
    const m2 = offerMultiplier(1000, 0.002, 60);
    ok(m1.mFair > 1 && m2.mFair > m1.mFair, "higher σ => larger fair multiplier (bust likelier)");
    const m3 = offerMultiplier(10, 0.001, 60);
    ok(Math.abs(m3.pBust - bustProb(10, 0.001, 60)) < 1e-12 && m3.pBust < 0.02,
        "low leverage rarely busts");
    ok(Math.abs(m1.mOffer - m1.mFair * 0.98) < 1e-12, "ρ=2% haircut applied");
    ok(clampMultiplier(0.5) === null && clampMultiplier(30) === 25 && clampMultiplier(5) === 5,
        "on-chain envelope clamp");
  }

  console.log("\n[ED] G8 agreePrice");
  {
    ok(agreePrice(100, 100.1) !== null, "venues within 12bp agree");
    ok(agreePrice(100, 100.2) === null, "venues beyond 12bp refuse");
    ok(agreePrice(100, null) === 100, "single-read passes through");
  }
}

async function interop() {
  console.log("\n[EE] interop: engine signatures vs contracts on ganache");
  const artifact = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));
  const server = ganache.server({
    chain: { chainId: 31337 }, wallet: { totalAccounts: 24 }, logging: { quiet: true } });
  await server.listen(0);
  const provider = new ethers.JsonRpcProvider(
    `http://127.0.0.1:${server.address().port}`, 31337, { polling: true, pollingInterval: 60 });
  const [owner, relayer, lp1, b1, b2, b3] = await provider.listAccounts();
  const hd = (i) => ethers.HDNodeWallet
    .fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`)
    .connect(provider);
  const quoterW = hd(21), att1 = hd(31), att2 = hd(32), att3 = hd(33), budgeter = hd(41);

  const C = (n, s) => new ethers.ContractFactory(artifact(n).abi, artifact(n).bytecode, s);
  const usdc = await (await C("MockUSDC", owner).deploy()).waitForDeployment();
  const opts = await (await C("RunwayOptions", owner).deploy(
    await usdc.getAddress(), quoterW.address)).waitForDeployment();
  const optAddr = await opts.getAddress();
  const pver = await (await C("MultiPriceVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, optAddr)).waitForDeployment();
  await (await opts.setPriceVerifier(await pver.getAddress())).wait();

  for (const b of [b1, b2, b3]) {
    await (await usdc.connect(owner).mint(b.address, U(100_000))).wait();
    await (await usdc.connect(b).approve(optAddr, ethers.MaxUint256)).wait();
  }
  await (await usdc.connect(owner).mint(lp1.address, U(200_000))).wait();
  await (await usdc.connect(lp1).approve(optAddr, ethers.MaxUint256)).wait();
  await (await opts.connect(lp1).lpDeposit(U(100_000))).wait();

  // --- engine quoter -> on-chain buyOption
  const Q = new Quoter(quoterW, { optionsAddr: optAddr, chainId: 31337 });
  const K = PX(78);
  const now = Number((await provider.getBlock("latest")).timestamp);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const { q, sig } = await Q.signOption({
    classId: 0, dir: 0, premium: U(100), multX1e4: x(3), bandBps: 50,
    strikeX1e8: K, validUntil: now + 20, salt, buyer: b1.address });
  const rc = await (await opts.connect(b1).buyOption(q, sig, K)).wait();
  const sold = rc.logs.find((l) => l.fragment?.name === "OSold");
  ok(!!sold, "engine-quoted OQuote passes contract EIP-712 and sells");
  ok((await opts.reserved()) === U(300), "maxPay reserved from engine quote");

  // --- engine attesters -> on-chain settleWithPrice (single-read venue)
  const tape = new TradeTape();
  const tC = now * 1000;
  tape.feed = null;
  for (let t = tC; t <= tC + 2_000; t += 500) tape.add(t, 78.39, 75); // close ≈ +0.5% = band edge
  const v = tape.vwap(tC + 2_000, 2_000);
  const closeX = PX(v.px);
  const A1 = new Attester(att1, { priceVerifierAddr: await pver.getAddress(), chainId: 31337, houseAddr: optAddr });
  const A2 = new Attester(att2, { priceVerifierAddr: await pver.getAddress(), chainId: 31337, houseAddr: optAddr });
  const sigs = [await A1.signOptPrice(0n, closeX), await A2.signOptPrice(0n, closeX)];
  const before = await usdc.balanceOf(b1.address);
  await provider.send("evm_increaseTime", [75]);
  await provider.send("evm_mine", []); await provider.send("evm_mine", []);
  await (await opts.connect(relayer).settleWithPrice(0n, closeX, sigs, { gasLimit: 500_000 })).wait();
  ok((await usdc.balanceOf(b1.address)) === before + U(300),
      "engine-attested price settles on-chain, full band pays maxPay");

  // --- G8 two-venue: agree signs, disagree refuses (no signature produced)
  const agr = agreePrice(78.391, 78.392);
  ok(agr !== null, "dual venues agree within tolerance -> signable");
  ok(agreePrice(78.39, 78.55) === null, "dual venues 20bp apart -> NO-SIGN");

  // --- ledger smart-mint -> EdgeDistributor end-to-end
  const edge = await (await C("EdgeToken", owner).deploy()).waitForDeployment();
  const dist = await (await C("EdgeDistributor", owner).deploy(await edge.getAddress())).waitForDeployment();
  await (await edge.setMinter(await dist.getAddress())).wait();
  await (await dist.setBudgetAttester(budgeter.address)).wait();

  const epochMs = 6 * 3600 * 1000;
  const L = new EpochLedger({ epochMs });
  const ep = (who, ts) => ({ owner: who, ts });
  const t0 = 0;
  // b1 loser: stake 1000, wins 0, paid fees 30 (ρ on traded notionals)
  L.add({ ...ep(b1.address, t0 + 10), stake: U(1_000), payout: 0n, feePaid: U(30) });
  // b2 loser, loyal (staked): stake 2000, payout 500 (net 1500), fees 60
  L.add({ ...ep(b2.address, t0 + 20), stake: U(2_000), payout: U(500), feePaid: U(60) });
  // b3 winner: stake 1000, payout 2100 -> net win, excluded
  L.add({ ...ep(b3.address, t0 + 30), stake: U(1_000), payout: U(2_100), feePaid: U(30) });
  // farmer: zero fees -> excluded despite losses
  L.add({ ...ep(owner.address, t0 + 40), stake: U(9_000), payout: 0n, feePaid: 0n });

  const mm = L.mintAmounts(0, { loyaltySet: new Set([b2.address]), sri: 2.0 });
  const revenue = U(1_000) + U(2_000) + U(1_000) + U(9_000) - (U(500) + U(2_100)); // 10400
  ok(mm.revenue === revenue, `ledger revenue = ${mm.revenue}`);
  ok(mm.total <= mm.budget && mm.budget === mm.revenue * 3_000n / 10_000n,
      "mint within 30% signed-anchor budget");
  ok(!mm.amounts.has(b3.address), "net winner gets no mint");
  ok(!mm.amounts.has(owner.address), "zero-fee loss farmer gets no mint");
  const w1 = Math.sqrt(1_000 * 30), w2 = Math.sqrt(1_500 * 60) * 1.25;
  const a1 = mm.amounts.get(b1.address), a2 = mm.amounts.get(b2.address);
  ok(a1 > 0n && a2 > a1, "loyal bigger-loser earns more");
  ok(Math.abs(Number(a2) / Number(a1) - w2 / w1) < 0.01, "weights follow √(loss×fees)×loyalty");

  const throttled = L.mintAmounts(0, { loyaltySet: new Set([b2.address]), sri: 0.3 });
  ok(throttled.budget === mm.budget * 20n / 100n || Number(throttled.budget) ===
      Math.floor(Number(mm.budget) * 0.3 / 1.5),
      "SRI throttle cools emission (0.3/1.5 = 20% of budget)");

  const mk = buildMerkle(1, mm.amounts);
  const anchorSig = await signRevenueAnchor(budgeter, 1n, mm.anchor18);
  await (await dist.postEpoch(1, mk.root, mm.total, mm.anchor18, anchorSig)).wait();
  ok(true, "engine merkle root + anchor accepted by EdgeDistributor");

  const proof1 = mk.proofOf(b1.address);
  await (await dist.connect(b1).claim(1, mm.amounts.get(b1.address), proof1)).wait();
  ok((await edge.balanceOf(b1.address)) === mm.amounts.get(b1.address),
      "b1 claimed engine-weighted EDGE on-chain");
  const proof2 = mk.proofOf(b2.address);
  await (await dist.connect(b2).claim(1, mm.amounts.get(b2.address), proof2)).wait();
  ok((await edge.balanceOf(b2.address)) === mm.amounts.get(b2.address),
      "b2 claimed with sorted-pair proof");
  ok(mk.leaves.length === 2, "tree contains exactly the two eligible losers");

  await server.close();
}

(async () => {
  await algos();
  await interop();
  console.log(`\n==== engine: ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e?.info?.error?.message || e.shortMessage || e.message || e); process.exit(1); });
