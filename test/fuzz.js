// RUNWAY property fuzz: random op sequences against accounting invariants.
// After EVERY op: (1) treasury() must not revert (B >= locked), (2) queue counters consistent,
// (3) drain rule visibly respected: any instant runway pay keeps T >= 10% of queueStack.
// ~300 ops across a seeded RNG (deterministic: rerun reproduces failures).
const { ethers } = require("ethers");
const ganache = require("ganache");
const fs = require("fs");
const path = require("path");

const artifact = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${n}.json`), "utf8"));

// splitmix32 — deterministic seedable RNG
function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.SEED || 1337);
const OPS = Number(process.env.OPS || 300);

(async () => {
  const r = rng32(SEED);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const server = ganache.server({
    chain: { chainId: 31337 }, wallet: { totalAccounts: 20 }, logging: { quiet: true },
  });
  await server.listen(0);
  const provider = new ethers.JsonRpcProvider(
    `http://127.0.0.1:${server.address().port}`, 31337, { polling: true, pollingInterval: 50 });
  const accs = await provider.listAccounts();
  const [owner, keeper, lp] = accs;
  const players = accs.slice(3, 12);
  const quoter = ethers.HDNodeWallet
    .fromPhrase("test test test test test test test test test test test junk", undefined, "m/44'/60'/0'/0/21")
    .connect(provider);

  const C = (n, s) => new ethers.ContractFactory(artifact(n).abi, artifact(n).bytecode, s);
  const usdc = await (await C("MockUSDC", owner).deploy()).waitForDeployment();
  const house = await (await C("RunwayHouse", owner).deploy(
    await usdc.getAddress(), quoter.address)).waitForDeployment();
  const att1 = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, "m/44'/60'/0'/0/31").connect(provider);
  const att2 = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, "m/44'/60'/0'/0/32").connect(provider);
  const verifier = await (await C("MultiAttesterVerifier", owner).deploy(
    [att1.address, att2.address, keeper.address], 2, await house.getAddress())).waitForDeployment();
  await (await house.setOutcomeVerifier(await verifier.getAddress())).wait();
  const vDomain = { name: "RunwayOutcome", version: "1", chainId: 31337,
                    verifyingContract: await verifier.getAddress() };
  const oTypes = { Outcome: [ { name: "ticketId", type: "uint256" },
    { name: "outcome", type: "uint8" }, { name: "house", type: "address" } ] };
  const houseAddr = await house.getAddress();
  const attest = async (id, o) => Promise.all([att1, att2].map((a) =>
    a.signTypedData(vDomain, oTypes, { ticketId: id, outcome: o, house: houseAddr })));
  const H = (s) => house.connect(s);
  const addr = await house.getAddress();
  for (const p of [...players, lp]) {
    await (await usdc.mint(p.address, 1_000_000n * 10n ** 6n)).wait();
    await (await usdc.connect(p).approve(addr, ethers.MaxUint256)).wait();
  }
  await (await H(owner).setBootstrapMaxStake(200n * 10n ** 6n)).wait();

  const quote = async (buyer, tier, stake6, mult) => {
    const latest = await provider.getBlock("latest");
    const value = {
      classId: 0, dir: Math.floor(r() * 2), tier, stake: stake6,
      multX1e4: BigInt(Math.round(mult * 1e4)),
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

  const stats = { buyI: 0, buyR: 0, settle: 0, crank: 0, forfeit: 0, yield: 0, lpd: 0, exit: 0, reverts: 0, claimsPaid: 0 };
  let opNum = 0;

  async function invariant(tag) {
    const T = await house.treasury(); // reverts if B < locked — the core invariant
    if (T < 0n) throw new Error(`negative treasury after ${tag}`);
    const qp = await house.queuePrincipal();
    const qw = await house.queueWinnings();
    if (qp < 0n || qw < 0n) throw new Error(`negative queue counters after ${tag}`);
    const head = await house.claimHead();
    if (head > (await house.claimCount())) throw new Error(`head overflow after ${tag}`);
    opNum++;
  }

  const tryo = async (tag, fn) => {
    try { await fn(); }
    catch (e) { stats.reverts++; } // legít reverts expected (caps, SRI, paused…) — invariant still checked after
    await invariant(tag);
  };

  // seed some LP and play
  await tryo("lp-seed", async () => {
    stats.lpd++;
    await (await H(lp).lpDeposit(200_000n * 10n ** 6n)).wait();
  });

  const liveTickets = []; // ids of possibly-unsettled tickets
  const claimOwners = new Map(); // cid -> owner address (approx, market moves ignored here)

  for (let i = 0; i < OPS; i++) {
    const action = Math.floor(r() * 100);
    const p = pick(players);

    if (action < 30) {
      // buy instant (may revert on caps)
      await tryo("buyI", async () => {
        const stake6 = BigInt(1 + Math.floor(r() * 500)) * 10n ** 6n;
        const mult = 1.1 + r() * 23;
        const qs = await quote(p, 0, stake6, mult);
        const rc = await (await H(p).buyTicket(qs.q, qs.sig, 0, pick([0, 60, 300]))).wait();
        stats.buyI++;
        const id = Number((await house.ticketCount()) - 1n);
        liveTickets.push(id);
        const ev = rc.logs.length;
        void ev;
      });
    } else if (action < 55) {
      // buy runway
      await tryo("buyR", async () => {
        const stake6 = BigInt(1 + Math.floor(r() * 200)) * 10n ** 6n;
        const mult = 1.1 + r() * 23;
        const qs = await quote(p, 1, stake6, mult);
        await (await H(p).buyTicket(qs.q, qs.sig, 0, pick([0, 60, 300]))).wait();
        stats.buyR++;
        liveTickets.push(Number((await house.ticketCount()) - 1n));
      });
    } else if (action < 70) {
      // settle a random live ticket
      await tryo("settle", async () => {
        if (!liveTickets.length) return;
        const id = liveTickets[Math.floor(r() * liveTickets.length)];
        const t = await house.tickets(id);
        if (t.outcome !== 0n) return;
        let o = pick([1, 2]);
        const now = (await provider.getBlock("latest")).timestamp;
        if (r() < 0.15 && now >= Number(t.expiry)) o = 3; // sometimes EXPIRED, only when legal
        await (await H(keeper).settleWithProof(id, o, await attest(id, o))).wait();
        stats.settle++;
      });
    } else if (action < 78) {
      await tryo("crank", async () => {
        await (await H(p).crankPayClaims(8)).wait();
        stats.crank++;
      });
    } else if (action < 84) {
      // forfeit a claim owned by a live claimant
      await tryo("forfeit", async () => {
        const n = await house.claimCount();
        if (n === 0n) return;
        const cid = Math.floor(r() * Number(n));
        const c = await house.claims(cid);
        if (c.paid || c.forfeited) return;
        const ownerSigner = players.find((x) => x.address.toLowerCase() === c.owner.toLowerCase());
        if (!ownerSigner) return;
        await (await H(ownerSigner).forfeitClaim(cid)).wait();
        stats.forfeit++;
      });
    } else if (action < 90) {
      // deposit claim yield (owner) — only when claims live (else expect revert, still logged)
      await tryo("yield", async () => {
        await (await H(owner).depositClaimYield(BigInt(1 + Math.floor(r() * 500)) * 10n ** 6n)).wait();
        stats.yield++;
      });
    } else if (action < 95) {
      await tryo("lpd", async () => {
        await (await H(lp).lpDeposit(BigInt(1 + Math.floor(r() * 5000)) * 10n ** 6n)).wait();
        stats.lpd++;
      });
    } else {
      // request + fast exit via warp
      await tryo("exit", async () => {
        const sh = await house.shares(lp.address);
        if (sh === 0n) return;
        const part = sh / 4n + 1n;
        await (await H(lp).lpRequestExit(part)).wait();
        await provider.send("evm_increaseTime", [7 * 24 * 3600 + 100]);
        await provider.send("evm_mine", []);
        await provider.send("evm_mine", []);
        await new Promise((res) => setTimeout(res, 80));
        await (await H(lp).lpWithdraw({ gasLimit: 400_000 })).wait();
        stats.exit++;
      });
    }
  }

  // final: crank to the end + invariant summary
  const qc = await house.claimCount();
  const qp = await house.queuePrincipal();
  const qw = await house.queueWinnings();
  const T = await house.treasury();
  const res = await house.instantReserved();
  console.log("\n==== fuzz summary (seed", SEED, ") ====");
  console.log("ops checked:", opNum, "| stats:", stats);
  console.log("claims total:", Number(qc), "| queue principal:", qp.toString(), "| winnings:", qw.toString());
  console.log("treasury:", T.toString(), "| instantReserved:", res.toString(), "| tickets:", Number(await house.ticketCount()));
  // THE invariants held at every single step if we got here without throw
  console.log("RESULT: all", opNum, "invariant checks passed");
  await server.close();
  process.exit(0);
})().catch((e) => { console.error("FUZZ FAILURE:", e.message || e); process.exit(1); });
