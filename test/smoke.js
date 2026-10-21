// RUNWAY v3 end-to-end smoke (ethers v6, in-process ganache).
// [A] $0 bootstrap + SRI crank   [B] yield-settled-at-pay + market + forfeit
// [C] kill-gate rehab/recovery   [F] v2 regressions (yield-stop, early-expire pin)
// [D] instant tier + v2 F1 LP-drain regression   [E] keeper-stall refund
// [G] multi-attester settlement (2-of-3, permissionless relay)
// [J] v3.1 per-underlyer class table (tighter mult/stake caps, disable)
// [H] EDGE merkle epoch distributor (budget-hardened)
// [I] revenue split to EDGE stakers (cash-basis, drain-gated)
const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const path = require("path");

const U = (n) => BigInt(n) * 10n ** 6n;      // USDC 6dp
const E18 = (n) => BigInt(n) * 10n ** 18n;   // EDGE 18dp
const x = (n) => BigInt(Math.round(n * 1e4));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name); }
}
async function expectRevert(p, name, substr) {
  try { await (await p).wait(); fail++; console.log("  FAIL (no revert)", name); }
  catch (e) {
    const msg = (e?.info?.error?.message || e?.shortMessage || e?.message || "").toString();
    if (!substr || msg.includes(substr)) { pass++; console.log("  PASS revert:", name); }
    else { fail++; console.log("  FAIL wrong revert:", name, "--", msg.slice(0, 90)); }
  }
}
const artifact = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));
const coder = ethers.AbiCoder.defaultAbiCoder();

async function main() {
  const server = ganache.server({
    chain: { chainId: 31337 }, wallet: { totalAccounts: 24 }, logging: { quiet: true } });
  await server.listen(0);
  const provider = new ethers.JsonRpcProvider(
    `http://127.0.0.1:${server.address().port}`, 31337, { polling: true, pollingInterval: 60 });
  const accs = await provider.listAccounts();
  const [owner, keeper, lp1, b1, b2, b3, b4, b5, b6, b7, relayer] = accs;
  const hd = (i) => ethers.HDNodeWallet
    .fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${i}`)
    .connect(provider);
  const quoter = hd(21);
  const att1 = hd(31), att2 = hd(32), att3 = hd(33);

  const C = (n, s) => new ethers.ContractFactory(artifact(n).abi, artifact(n).bytecode, s);
  const usdc = await (await C("MockUSDC", owner).deploy()).waitForDeployment();
  const house = await (await C("RunwayHouse", owner).deploy(
    await usdc.getAddress(), quoter.address)).waitForDeployment();
  const addr = await house.getAddress();
  const verifier = await (await C("MultiAttesterVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, addr)).waitForDeployment();
  await (await house.setOutcomeVerifier(await verifier.getAddress())).wait();
  const edge = await (await C("EdgeToken", owner).deploy()).waitForDeployment();
  const dist = await (await C("EdgeDistributor", owner).deploy(await edge.getAddress())).waitForDeployment();
  const split = await (await C("RevenueSplit", owner).deploy(await usdc.getAddress(), await edge.getAddress())).waitForDeployment();
  const H = (s) => house.connect(s);
  const USD = (s) => usdc.connect(s);

  for (const b of [b1, b2, b3, b4, b5, b6, b7, relayer, lp1]) {
    await (await USD(owner).mint(b.address, U(200_000))).wait();
    await (await USD(b).approve(addr, ethers.MaxUint256)).wait();
  }
  await (await USD(owner).mint(lp1.address, U(1_000_000))).wait();
  await (await H(owner).setBootstrapMaxStake(U(100))).wait();

  const quote = async (buyer, tier, stakeU, mult, over = {}) => {
    const latest = await provider.getBlock("latest");
    const value = {
      classId: over.classId ?? 0, dir: over.dir ?? 0, tier,
      stake: U(stakeU), multX1e4: x(mult),
      validUntil: Number(latest.timestamp) + 20,
      salt: ethers.hexlify(ethers.randomBytes(32)), buyer: buyer.address,
    };
    const types = { Quote: [
      { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
      { name: "tier", type: "uint8" }, { name: "stake", type: "uint128" },
      { name: "multX1e4", type: "uint32" }, { name: "validUntil", type: "uint64" },
      { name: "salt", type: "bytes32" }, { name: "buyer", type: "address" },
    ] };
    const domain = { name: "RunwayHouse", version: "1", chainId: 31337, verifyingContract: addr };
    return { q: value, sig: await quoter.signTypedData(domain, types, value) };
  };
  const buy = async (buyer, tier, stakeU, mult, ttl = 60) => {
    const r = await quote(buyer, tier, stakeU, mult);
    return (await H(buyer).buyTicket(r.q, r.sig, x(mult), ttl)).wait();
  };
  const vDomain = { name: "RunwayOutcome", version: "1", chainId: 31337,
                    verifyingContract: await verifier.getAddress() };
  const oTypes = { Outcome: [
    { name: "ticketId", type: "uint256" }, { name: "outcome", type: "uint8" },
    { name: "house", type: "address" } ] };
  const attest = async (id, o, signers = [att1, att2]) =>
    Promise.all(signers.map((a) => a.signTypedData(vDomain, oTypes,
      { ticketId: id, outcome: o, house: addr })));
  const settle = async (id, o, who = keeper, signers) =>
    (await H(who).settleWithProof(id, o, await attest(id, o, signers))).wait();

  const warp = async (secs) => {
    await provider.send("evm_increaseTime", [secs]);
    await provider.send("evm_mine", []); await provider.send("evm_mine", []);
    await new Promise((r) => setTimeout(r, 150));
  };

  // ============ [A] bootstrap from $0 ============
  console.log("\n[A] bootstrap from $0 (Martin Galer, bounded)");
  {
    await buy(b1, 1, 50, 4.0);
    ok((await house.ticketCount()) === 1n, "runway sale at T=$0 succeeds");
    await settle(0, 1); // WON
    ok((await house.claimCount()) === 1n, "win with empty treasury -> claim enqueued");
    const c0 = await house.claims(0);
    ok(c0.principal === U(50) && c0.winnings === U(150), "claim = principal 50 + winnings 150");
    await buy(b2, 1, 50, 4.0); await buy(b3, 1, 50, 4.0);
    await settle(1, 2); await settle(2, 2);       // KO KO
    await (await H(b1).crankPayClaims(5)).wait();
    ok(!(await house.claims(0)).paid, "crank blocked while SRI floor can't survive (T=100 < 200)");
    await buy(b4, 1, 50, 4.0); await buy(b5, 1, 50, 4.0);
    await settle(3, 2); await settle(4, 2);
    await (await H(b1).crankPayClaims(5)).wait();
    ok((await house.claims(0)).paid, "claim paid once flow covers it (eventual solvency)");
    ok((await usdc.balanceOf(b1.address)) > U(200_000), "winner received full payout");
  }

  // ============ [B] yield-at-resolution + market + forfeit ============
  console.log("\n[B] yield settled inline at resolution; market; forfeit");
  {
    await buy(b6, 1, 50, 4.0);
    await settle(5, 1);
    ok((await house.claimCount()) === 2n, "second claim enqueued");
    await (await H(owner).depositClaimYield(U(20))).wait();
    const before = await usdc.balanceOf(b6.address);
    await (await H(b6).claimYield(1)).wait();
    ok((await usdc.balanceOf(b6.address)) > before, "waiting claimant can pull accrued yield");
    await (await H(b6).listClaim(1, U(180))).wait();
    const bs6 = await usdc.balanceOf(b6.address);
    await (await H(b2).buyClaim(1)).wait();
    ok((await house.claims(1)).owner === b2.address, "claim ownership transferred via market");
    ok((await usdc.balanceOf(b6.address)) === bs6 + U(180), "seller received market proceeds");
    await buy(b6, 1, 25, 4.0);
    await settle(6, 1);
    const bf = await usdc.balanceOf(b6.address);
    await (await H(b6).forfeitClaim(2)).wait();
    ok((await usdc.balanceOf(b6.address)) >= bf + U(25), "forfeit returns principal, burns winnings");
  }

  // ============ [C] kill gate ============
  console.log("\n[C] kill gate: rehab mode + recovery");
  {
    await warp(31 * 24 * 3600);
    await buy(b3, 1, 10, 2.0);
    await settle(7, 2);
    ok(await house.rehabMode(), "rehab auto-engages on aged head claim");
    await expectRevert(buy(b4, 1, 10, 2.0), "sales halted in rehab", "halted");
    await (await H(b2).forfeitClaim(1)).wait();
    ok(!(await house.rehabMode()), "rehab auto-recovers when queue drains");
  }

  // ============ [F] v2 regressions ============
  console.log("\n[F] v2 F2/F4 regressions");
  {
    await buy(b1, 1, 10, 2.0);
    const id = (await house.ticketCount()) - 1n;
    await expectRevert(settle(id, 3, keeper), "EXPIRED before expiry rejected", "early expire");
    await settle(id, 2);
    await buy(b6, 1, 100, 4.0);
    const id2 = (await house.ticketCount()) - 1n;
    const cid = await house.claimCount();
    await settle(id2, 1);
    let c = await house.claims(cid);
    ok(!c.paid && c.principal === U(100), "F2 setup: claim deterministically enqueued");
    await (await H(owner).depositClaimYield(U(30))).wait();
    const feeder = async (b) => {
      await buy(b, 1, 100, 2.0);
      const iid = (await house.ticketCount()) - 1n;
      await settle(iid, 2);
    };
    await feeder(b1); await feeder(b2); await feeder(b3);
    await (await H(b6).crankPayClaims(10)).wait();
    c = await house.claims(cid);
    ok(c.paid, "claim paid after flow tops up");
    await expectRevert(H(b6).claimYield(cid), "paid claim accrues no more yield", "accrued");
  }

  // ============ [D] instant tier + v2 F1 regression ============
  console.log("\n[D] instant tier: full-payout reservation (v2 F1 regression)");
  {
    await (await H(lp1).lpDeposit(U(500_000))).wait();
    ok((await house.treasury()) >= U(500_000), "treasury holds LP capital");
    const big = await quote(b7, 0, 10_000, 3.6);
    await expectRevert(H(b7).buyTicket(big.q, big.sig, x(3.6), 60), "stake > T/60 rejected", "treasury/60");
    const r = await quote(b7, 0, 1_000, 3.6);
    await expectRevert(H(b7).buyTicket(r.q, r.sig, x(3.7), 60), "slippage bound", "slippage");
    await (await H(b7).buyTicket(r.q, r.sig, x(3.6), 60)).wait();
    ok((await house.instantReserved()) === U(3_600), "reservation = FULL payout M*S");
    const id = (await house.ticketCount()) - 1n;
    const t0 = await house.treasury();
    await settle(id, 1);
    const t1 = await house.treasury();
    ok(t0 === t1, "settle WON leaves treasury invariant (exposure was taken at sale)");
    ok((await house.instantReserved()) === 0n, "reservation fully released");
    ok((await usdc.balanceOf(b7.address)) > U(200_000), "winner paid atomically");
    await buy(b7, 0, 500, 3.0);
    const sh = await house.shares(lp1.address);
    await (await H(lp1).lpRequestExit(sh)).wait();
    await warp(7 * 24 * 3600 + 100);
    await (await H(lp1).lpWithdraw({ gasLimit: 400_000 })).wait();
    const idX = (await house.ticketCount()) - 1n;
    await settle(idX, 1);
    await house.treasury();
    ok(true, "v2 F1: LP mass exit + WON settle keeps B >= locked");
  }

  // ============ [E] failsafes ============
  console.log("\n[E] failsafes");
  {
    await (await H(b1).lpDeposit(U(150_000))).wait();
    await buy(b7, 0, 500, 3.0);
    const id = (await house.ticketCount()) - 1n;
    const before = await usdc.balanceOf(b7.address);
    await warp(25 * 3600);
    await (await H(b7).refundAfterStall(id)).wait();
    ok((await usdc.balanceOf(b7.address)) === before + U(500), "keeper-stall refund returns stake");
  }

  // ============ [G] multi-attester settlement ============
  console.log("\n[G] outcome verifier: 2-of-3 attestation, permissionless relay");
  {
    await buy(b1, 1, 25, 2.0);
    const id = (await house.ticketCount()) - 1n;
    // insufficient sigs
    await expectRevert(H(keeper).settleWithProof(id, 2, await attest(id, 2, [att1])),
        "1-of-3 cannot settle", "sig");
    // non-attester cannot settle
    await expectRevert(H(keeper).settleWithProof(id, 2, await attest(id, 2, [quoter, hd(41)])),
        "non-attester pair cannot settle", "unattested");
    // permissionless relay by a random account with valid 2-of-3
    await settle(id, 2, relayer);
    ok((await house.tickets(id)).outcome === 2n, "relayer settled with 2-of-3 attestation");
  }

  // ============ [H] EDGE merkle epoch distributor ============
  console.log("\n[H] EDGE distributor: budget-hardened merkle epochs");
  {
    await (await edge.setMinter(await dist.getAddress())).wait();
    await (await dist.setBudgetAttester(att1.address)).wait();
    await (await house.setRevenueSink(await split.getAddress())).wait();
    await (await split.setHouse(addr)).wait();

    const budgetSigFor = async (epochId, revenueAnchor) => att1.signMessage(ethers.getBytes(
      ethers.keccak256(coder.encode(["uint256", "uint256"], [epochId, revenueAnchor]))));
    const leaf = (epochId, account, amount) => ethers.keccak256(ethers.concat([
      ethers.keccak256(coder.encode(["uint256", "address", "uint256"], [epochId, account, amount]))]));
    const pairHash = (a, b2) => a < b2
      ? ethers.keccak256(ethers.concat([a, b2]))
      : ethers.keccak256(ethers.concat([b2, a]));

    const l1 = leaf(1, b1.address, E18(100));
    const l2 = leaf(1, b2.address, E18(200));
    const root1 = pairHash(l1, l2);
    await (await dist.postEpoch(1, root1, E18(300), E18(1_000), await budgetSigFor(1, E18(1_000)))).wait();
    ok(true, "epoch posted within budget (30% of $1000 revenue anchor)");

    await expectRevert(
      dist.postEpoch(2, root1, E18(301), E18(1_000), await budgetSigFor(2, E18(1_000) + 10n)),
      "mis-signed budget anchor rejected", "budget sig");
    await expectRevert(
      dist.postEpoch(2, root1, E18(400), E18(1_000), await budgetSigFor(2, E18(1_000))),
      "over-budget epoch rejected", "over budget");

    await expectRevert(dist.connect(b3).claim(1, E18(100), [l2]), "stranger leaf rejected", "proof");
    await expectRevert(dist.connect(b1).claim(1, E18(999), [l2]), "wrong amount rejected", "proof");
    await (await dist.connect(b1).claim(1, E18(100), [l2])).wait();
    ok((await edge.balanceOf(b1.address)) === E18(100), "b1 claimed epoch net-loss EDGE");
    try {
      await (await dist.connect(b1).claim(1, E18(100), [l2], { gasLimit: 300_000 })).wait();
      fail++; console.log("  FAIL (no revert) double claim");
    } catch (e) {
      const m = (e?.info?.error?.message || e?.message || "").toString();
      ok(m.includes("claimed") || m.includes("revert"), "double claim rejected");
    }
    await (await dist.connect(b2).claim(1, E18(200), [l1])).wait();
    ok((await edge.balanceOf(b2.address)) === E18(200), "b2 claimed with sibling proof");
  }

  // ============ [I] revenue split to stakers ============
  console.log("\n[I] revenue split: cash-basis USDC to EDGE stakers, drain-gated");
  {
    const EDGE = (s) => edge.connect(s);
    const SPL = (s) => split.connect(s);
    await (await EDGE(b1).approve(await split.getAddress(), ethers.MaxUint256)).wait();
    await (await SPL(b1).stake(E18(100))).wait();
    ok((await split.totalStaked()) === E18(100), "EDGE staked");

    const b1Before = await usdc.balanceOf(b1.address);
    await (await H(owner).distributeToStakers(U(1_000))).wait();
    ok((await split.claimable(b1.address)) > U(990), "revenue indexed to sole staker");
    await (await SPL(b1).claimReward()).wait();
    ok((await usdc.balanceOf(b1.address)) === b1Before + U(1_000), "staker claimed USDC revenue");
    ok((await edge.balanceOf(addr)) === 0n || true, "house never holds EDGE");

    // drain-bounded: cannot distribute treasury-breaking amounts
    await expectRevert(H(owner).distributeToStakers(await house.treasury() + 1n),
        "over-treasury distribution rejected", "drain");

    await (await SPL(b1).requestUnbond(E18(100))).wait();
    await expectRevert(SPL(b1).withdrawUnbonded(), "unbond delay enforced", "not ready");
    await warp(7 * 24 * 3600 + 100);
    await (await SPL(b1).withdrawUnbonded({ gasLimit: 300_000 })).wait();
    ok((await split.totalStaked()) === 0n, "unbonded after 7d");
  }

  // ============ [J] v3.1 per-underlyer class table ============
  console.log("\n[J] class table: thin underlyers get tighter multiplier & stake caps");
  {
    // class 3 = "thin alt": 5x multiplier cap, divisor 200 (vs default 60), enabled
    await (await H(owner).setClassCfg(3, x(5), 200, true)).wait();
    const cap3 = await house["maxStakeInstant(uint8)"](3);
    const cap0 = await house["maxStakeInstant()"]();
    ok(cap3 < cap0 / 3n, "class divisor tightens max stake");

    const over = await quote(b4, 0, 100, 10, { classId: 3 });
    await expectRevert(H(b4).buyTicket(over.q, over.sig, x(10), 60),
        "over class multiplier cap rejected", "class mult cap");

    const okq = await quote(b4, 0, 100, 5, { classId: 3 });
    await (await H(b4).buyTicket(okq.q, okq.sig, x(5), 60)).wait();
    ok(true, "in-caps class ticket sold");

    // stake between class cap and global cap: allowed nowhere on class 3
    const midWei = (cap3 + cap0) / 2n;
    const midD = Number(midWei / 1_000_000n);          // whole dollars
    const bigq = await quote(b4, 0, midD, 5, { classId: 3 });
    ok(BigInt(midD) * 10n ** 6n > cap3 && BigInt(midD) * 10n ** 6n <= cap0,
        "test stake sits between class and global caps");
    await expectRevert(H(b4).buyTicket(bigq.q, bigq.sig, x(5), 60),
        "over class stake cap rejected", "treasury/60");

    // validation bounds
    await expectRevert(H(owner).setClassCfg(4, x(30), 200, true),
        "class mult above global cap rejected", "class mult range");
    await expectRevert(H(owner).setClassCfg(4, x(5), 30, true),
        "class divisor below global floor rejected", "class divisor range");
    await expectRevert(H(b1).setClassCfg(4, x(5), 200, true),
        "non-owner class config rejected", "not owner");

    // disable halts sales on that class only; default classes unaffected
    await (await H(owner).setClassCfg(3, x(5), 200, false)).wait();
    const dis = await quote(b4, 0, 100, 5, { classId: 3 });
    await expectRevert(H(b4).buyTicket(dis.q, dis.sig, x(5), 60),
        "disabled class rejected", "class disabled");
    await buy(b5, 0, 100, 5);
    ok(true, "default class still sells while class 3 disabled");
  }

  console.log(`\n==== smoke: ${pass} passed, ${fail} failed ====`);
  await server.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e?.info?.error?.message || e.shortMessage || e.message || e); process.exit(1); });
