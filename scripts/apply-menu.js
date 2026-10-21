// Apply config/menu.json to a deployed RunwayHouse via setClassCfg.
// Usage: RPC_URL=<url> OWNER_KEY=<0x...> HOUSE_ADDR=<0x...> node scripts/apply-menu.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "menu.json"), "utf8"));
const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", "RunwayHouse.json"), "utf8"));

async function main() {
  const { RPC_URL, OWNER_KEY, HOUSE_ADDR } = process.env;
  if (!RPC_URL || !OWNER_KEY || !HOUSE_ADDR)
    throw new Error("need RPC_URL, OWNER_KEY, HOUSE_ADDR env vars");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const owner = new ethers.Wallet(OWNER_KEY, provider);
  const house = new ethers.Contract(HOUSE_ADDR, artifact.abi, owner);

  if ((await house.owner()) !== owner.address)
    throw new Error(`signer ${owner.address} is not house owner ${await house.owner()}`);

  for (const c of menu.classes) {
    const tx = await house.setClassCfg(c.classId, c.maxMultX1e4, c.stakeDivisor, true);
    const rc = await tx.wait();
    const cfg = await house.classCfg(c.classId);
    const ok = cfg.enabled && cfg.maxMultX1e4 == BigInt(c.maxMultX1e4) &&
               cfg.stakeDivisor == BigInt(c.stakeDivisor);
    console.log(`${ok ? "OK  " : "BAD "} class ${c.classId} ${c.asset.padEnd(9)} ` +
                `mult<=${c.maxMultX1e4 / 1e4}x div=/${c.stakeDivisor}  tx=${rc.hash}`);
    if (!ok) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
