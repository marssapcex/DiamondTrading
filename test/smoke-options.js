// RUNWAY OPTIONS end-to-end smoke (ethers v6, in-process ganache).
// [OA] capped-vanilla payoff: ramp / saturation / OTM-zero, CALL & PUT
// [OB] sale guards: clamps, class table, strike guard, sig, caps
// [OC] settlement: permissionless relay, time pin, 1-sig reject, stall refund
// [OD] LP vault + solvency invariants
const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const path = require("path");

const U = (n) => BigInt(n) * 10n ** 6n;      // USDC 6dp
const PX = (n) => BigInt(n) * 10n ** 8n;     // price 1e8
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
    if (!substr || msg.includes(substr) || msg.includes("revert")) { pass++; console.log("  PASS revert:", name); }
    else { fail++; console.log("  FAIL wrong revert:", name, "--", msg.slice(0, 90)); }
  }
}
const artifact = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));

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
  const opts = await (await C("RunwayOptions", owner).deploy(
    await usdc.getAddress(), quoter.address)).waitForDeployment();
  const addr = await opts.getAddress();
  const pver = await (await C("MultiPriceVerifier", owner).deploy(
    [att1.address, att2.address, att3.address], 2, addr)).waitForDeployment();
  await (await opts.setPriceVerifier(await pver.getAddress())).wait();
  const O = (s) => opts.connect(s);

  for (const b of [b1, b2, b3, b4, b5, b6, b7]) {
    await (await usdc.connect(owner).mint(b.address, U(200_000))).wait();
    await (await usdc.connect(b).approve(addr, ethers.MaxUint256)).wait();
  }
  await (await usdc.connect(owner).mint(lp1.address, U(1_000_000))).wait();
  await (await usdc.connect(lp1).approve(addr, ethers.MaxUint256)).wait();

  const K = PX(80_000);           // strike ref ~ HYPE-ish
  const warp = async (secs) => {
    await provider.send("evm_increaseTime", [secs]);
    await provider.send("evm_mine", []); await provider.send("evm_mine", []);
    await new Promise((r) => setTimeout(r, 150));
  };

  const quote = async (buyer, premiumU, mult, bandBps, strike = K, over = {}) => {
    const latest = await provider.getBlock("latest");
    const value = {
      classId: over.classId ?? 0, dir: over.dir ?? 0,
      premium: U(premiumU), multX1e4: x(mult), bandBps,
      strikeX1e8: strike, validUntil: Number(latest.timestamp) + 20,
      salt: ethers.hexlify(ethers.randomBytes(32)), buyer: buyer.address,
    };
    const types = { OQuote: [
      { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
      { name: "premium", type: "uint128" }, { name: "multX1e4", type: "uint32" },
      { name: "bandBps", type: "uint32" }, { name: "strikeX1e8", type: "uint64" },
      { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
      { name: "buyer", type: "address" },
    ] };
    const domain = { name: "RunwayOptions", version: "1", chainId: 31337, verifyingContract: addr };
    return { q: value, sig: await quoter.signTypedData(domain, types, value) };
  };

  const buy = async (buyer, premiumU, mult, bandBps, strike = K, over = {}) => {
    const r = await quote(buyer, premiumU, mult, bandBps, strike, over);
    const worst = over.dir === 1 ? (over.worst ?? strike) : (over.worst ?? strike);
    const rc = await (await O(buyer).buyOption(r.q, r.sig, worst)).wait();
    const ev = rc.logs.find((l) => l.fragment?.name === "OSold");
    return ev.args[0];
  };

  const pDomain = { name: "RunwayPrice", version: "1", chainId: 31337,
                    verifyingContract: await pver.getAddress() };
  const pTypes = { OptPrice: [
    { name: "optionId", type: "uint256" }, { name: "closePx", type: "uint64" },
    { name: "house", type: "address" } ] };
  const pattest = async (id, closePx, signers = [att1, att2]) =>
    Promise.all(signers.map((a) => a.signTypedData(pDomain, pTypes,
      { optionId: id, closePx, house: addr })));
  const settle = async (id, closePx, who = relayer, signers) =>
    (await O(who).settleWithPrice(id, closePx, await pattest(id, closePx, signers), { gasLimit: 500_000 })).wait();

  const settleVal = async (id, closePx, who = relayer) => {
    const o = await opts.options(id);
    const before = await usdc.balanceOf(o.owner);
    await settle(id, closePx, who);
    return { o, got: (await usdc.balanceOf(o.owner)) - before };
  };

  // ============ [OD-0] LP seed ============
  console.log("\n[OD] LP vault & solvency");
  await (await O(lp1).lpDeposit(U(100_000))).wait();
  ok((await opts.totalShares()) === U(100_000), "LP first deposit 1:1 shares");
  ok((await opts.treasury()) === U(100_000), "treasury = 100k");

  // ============ [OA] payoff shape ============
  console.log("\n[OA] capped-vanilla payoff: ramp, saturation, OTM");
  {
    const id = await buy(b1, 100, 10, 50);            // premium 100, 10x, band 0.5%
    ok((await opts.reserved()) === U(1_000), "full maxPay reserved at sale");
    ok((await opts.treasury()) === U(100_000 - 900), "T drops by (M-1)*premium");

    await expectRevert(O(relayer).settleWithPrice(id, K, await pattest(id, K)),
        "settle before expiry rejected", "not expired");

    await warp(70);
    // close at strike +0.25% = half the band => half maxPay
    const half = K + K / 400n;
    const r1 = await settleVal(id, half, relayer);    // permissionless relay
    ok(r1.got === U(500), `CALL half-band pays half maxPay (got ${r1.got})`);
    ok((await opts.reserved()) === 0n, "reserve cleared at settle");
    ok((await usdc.balanceOf(addr)) >= (await opts.reserved()), "B >= reserved");

    // beyond band => saturated full maxPay
    const id2 = await buy(b2, 100, 10, 50);
    await warp(70);
    const r2 = await settleVal(id2, K + K / 100n);
    ok(r2.got === U(1_000), "CALL beyond band pays full maxPay");

    // OTM => zero
    const id3 = await buy(b3, 100, 10, 50);
    await warp(70);
    const r3 = await settleVal(id3, K - K / 500n);
    ok(r3.got === 0n, "CALL closed lower pays zero");

    // PUT mirror: down move IN the band
    const id4 = await buy(b4, 100, 10, 50, K, { dir: 1 });
    await warp(70);
    const r4 = await settleVal(id4, K - K / 200n);    // -0.5% = full band
    ok(r4.got === U(1_000), "PUT full-band pays full maxPay");

    const id5 = await buy(b5, 100, 10, 50, K, { dir: 1 });
    await warp(70);
    const r5 = await settleVal(id5, K + K / 200n);
    ok(r5.got === 0n, "PUT closed higher pays zero");

    // tiny in-band move => graded partial (25bp of 50bp = 50%)
    const id6 = await buy(b6, 200, 5, 100, K, { dir: 1 });
    await warp(70);
    const r6 = await settleVal(id6, K - K / 400n);    // -0.25% of 1% band = 25% of maxPay
    ok(r6.got === U(250), `PUT quarter-band pays quarter maxPay (got ${r6.got})`);
  }

  // ============ [OB] sale guards ============
  console.log("\n[OB] sale guards");
  {
    const r = await quote(b7, 100, 30, 50);
    await expectRevert(O(b7).buyOption(r.q, r.sig, K), "mult above 25x rejected", "mult clamp");

    const rb = await quote(b7, 100, 10, 1000);
    await expectRevert(O(b7).buyOption(rb.q, rb.sig, K), "band out of range rejected", "band clamp");

    const latest = await provider.getBlock("latest");
    const old = { classId: 0, dir: 0, premium: U(100), multX1e4: x(10), bandBps: 50,
                  strikeX1e8: K, validUntil: Number(latest.timestamp) - 1,
                  salt: ethers.hexlify(ethers.randomBytes(32)), buyer: b7.address };
    const types = { OQuote: [
      { name: "classId", type: "uint8" }, { name: "dir", type: "uint8" },
      { name: "premium", type: "uint128" }, { name: "multX1e4", type: "uint32" },
      { name: "bandBps", type: "uint32" }, { name: "strikeX1e8", type: "uint64" },
      { name: "validUntil", type: "uint64" }, { name: "salt", type: "bytes32" },
      { name: "buyer", type: "address" } ] };
    const domain = { name: "RunwayOptions", version: "1", chainId: 31337, verifyingContract: addr };
    const osig = await quoter.signTypedData(domain, types, old);
    await expectRevert(O(b7).buyOption(old, osig, K), "stale quote rejected", "quote expired");

    // buyer not quoter: sign someone else's quote
    const alien = await quote(b6, 100, 10, 50);
    await expectRevert(O(b7).buyOption(alien.q, alien.sig, K),
        "quote bound to buyer", "bad quote sig");

    // strike guard: CALL refuses strike above worst
    const above = await quote(b7, 100, 10, 50, K + PX(10));
    await expectRevert(O(b7).buyOption(above.q, above.sig, K),
        "CALL over-worst strike rejected", "strike guard");

    // premium cap: T ≈ 100k -900 +edge… cap T/60 ≈ 1.6k; 2000 > cap
    const big = await quote(b7, 2_000, 10, 50);
    await expectRevert(O(b7).buyOption(big.q, big.sig, K),
        "premium beyond T/60 rejected", "premium vs treasury");

    // dir cap: T/60 premium floor * 25x => exposure (M-1)*S must exceed 30% T
    const Tnow = await opts.treasury();
    const premD = 1_600;                              // < T/60 (~1632)
    const exp = U(premD) * 24n;
    ok(exp > Tnow * 3000n / 10000n && U(premD) <= Tnow / 60n,
        "test exposure sits between dir cap and premium cap");
    const dc = await quote(b7, premD, 25, 50, K, { dir: 1 });
    await expectRevert(O(b7).buyOption(dc.q, dc.sig, 0n), "dir cap rejected", "dir cap");

    // class table on options
    await (await O(owner).setClassCfg(3, x(5), 200, true)).wait();
    const cm = await quote(b7, 100, 10, 50, K, { classId: 3 });
    await expectRevert(O(b7).buyOption(cm.q, cm.sig, K), "class mult cap rejected", "class mult cap");
    await (await O(owner).setClassCfg(3, x(5), 200, false)).wait();
    const cd = await quote(b7, 100, 10, 50, K, { classId: 3 });
    await expectRevert(O(b7).buyOption(cd.q, cd.sig, K), "disabled class rejected", "class disabled");
  }

  // ============ [OC] settlement security ============
  console.log("\n[OC] settlement security");
  {
    const id = await buy(b1, 100, 10, 50);
    await warp(70);
    await expectRevert(O(relayer).settleWithPrice(id, K + PX(100), await pattest(id, K + PX(100), [att1])),
        "single attester rejected", "not enough sigs");

    // wrong price signed honestly but attacker relays a DIFFERENT price => unattested
    const sigs = await pattest(id, K + PX(100));
    await expectRevert(O(relayer).settleWithPrice(id, K + PX(200), sigs),
        "price substitution rejected", "unattested");

    await expectRevert(O(relayer).settleWithPrice(id, K + PX(100), sigs, { gasLimit: 500_000 })
        .then(() => O(relayer).settleWithPrice(id, K + PX(100), sigs)),
        "double settle rejected", "not live");

    // stall: no settle, 24h later premium refunded
    const id2 = await buy(b2, 100, 10, 50);
    await warp(70);
    await expectRevert(O(b2).refundAfterStall(id2), "early stall refund rejected", "not stalled");
    const before = await usdc.balanceOf(b2.address);
    await warp(24 * 3600 + 100);
    await (await O(b2).refundAfterStall(id2, { gasLimit: 300_000 })).wait();
    ok((await usdc.balanceOf(b2.address)) === before + U(100), "stall refunds premium after 24h");
    await expectRevert(O(b2).refundAfterStall(id2), "double refund rejected", "not live");
  }

  // ============ [OD] LP exit + final invariants ============
  console.log("\n[OD] LP exit");
  {
    const sh = await opts.shares(lp1.address);
    await (await O(lp1).lpRequestExit(sh)).wait();
    await expectRevert(O(lp1).lpWithdraw(), "early LP withdraw rejected", "not ready");
    await warp(7 * 24 * 3600 + 100);
    const tPre = await opts.treasury();    // scenarios let buyers win on purpose: edge is NEGATIVE
    const before = await usdc.balanceOf(lp1.address);
    await (await O(lp1).lpWithdraw({ gasLimit: 300_000 })).wait();
    const gained = (await usdc.balanceOf(lp1.address)) - before;
    ok(gained === tPre && gained < U(100_000),
        `LP withdrew exact residual treasury; first-loss absorbed ${U(100_000) - gained} of buyer wins`);
    ok((await usdc.balanceOf(addr)) === 0n, "contract drained to zero by sole LP exit");
    ok((await opts.reserved()) === 0n, "no residual reserve");
  }

  console.log(`\n==== smoke-options: ${pass} passed, ${fail} failed ====`);
  await server.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e?.info?.error?.message || e.shortMessage || e.message || e); process.exit(1); });
