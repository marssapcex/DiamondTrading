// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RunwayOptions — options-flavoured papertrading: short-dated CAPPED VANILLA spreads.
///
/// Distinct from RunwayHouse tickets (digital: full payout or zero). Here the payoff is a
/// European vertical spread sold as one unit:
///   - CALL pays maxPay * min(close - strike, bandEdge) / bandEdge   (0 if close <= strike)
///   - PUT  pays maxPay * min(strike - close, bandEdge) / bandEdge   (0 if close >= strike)
/// i.e. intrinsic value that RAMPS linearly from the strike and saturates at the band edge —
/// graded wins, convex payoff: options economics, papertrade-style 30s–5min expiry.
///
/// Solvency is the INSTANT-tier pattern: full max payout (M * premium) is reserved at sale,
/// so every live option is always payable in full — no queue, no claims, no runway tier needed.
/// Strike comes from the quoter (EIP-712, TTL-clamped, buyer worst-strike guard); settlement
/// price comes from an M-of-N price attestation (mirror of the house's attester design).
///
/// Prices are scaled 1e8 (uint64). Premiums/payouts in USDC (6dp).
interface IERC20MinO {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPriceVerifier {
    /// @return true if `closePx` (1e8-scaled) for `optionId` is validly attested.
    function verifyOpt(uint256 optionId, uint64 closePx, bytes[] calldata sigs) external view returns (bool);
}

/// @notice M-of-N EIP-712 price attestation verifier (threshold floored at 2, dup-signers
/// discounted — identical security shape to MultiAttesterVerifier, different payload).
contract MultiPriceVerifier is IPriceVerifier {
    bytes32 public constant PRICE_TYPEHASH =
        keccak256("OptPrice(uint256 optionId,uint64 closePx,address house)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public immutable house; // the RunwayOptions this verifier serves (bound in struct)

    mapping(address => bool) public isAttester;
    address[] public attesterList;
    uint256 public threshold;
    address public owner;

    event AttesterSet(address indexed who, bool on);
    event ThresholdSet(uint256 t);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address[] memory attesters, uint256 _threshold, address _house) {
        require(_house != address(0), "house");
        house = _house;
        require(_threshold >= 2 && _threshold <= attesters.length, "bad threshold");
        owner = msg.sender;
        for (uint256 i; i < attesters.length; i++) {
            require(attesters[i] != address(0), "zero");
            require(!isAttester[attesters[i]], "dup");
            isAttester[attesters[i]] = true;
            attesterList.push(attesters[i]);
        }
        threshold = _threshold;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("RunwayPrice"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function setAttester(address who, bool on) external onlyOwner {
        isAttester[who] = on;
        if (on) attesterList.push(who);
        emit AttesterSet(who, on);
    }

    function setThreshold(uint256 t) external onlyOwner {
        require(t >= 2, "min 2"); // never governable to 1 (single-signer sin, audit L-04)
        threshold = t;
        emit ThresholdSet(t);
    }

    function digestOf(uint256 optionId, uint64 closePx) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(PRICE_TYPEHASH, optionId, closePx, house))));
    }

    function verifyOpt(uint256 optionId, uint64 closePx, bytes[] calldata sigs)
        external view returns (bool)
    {
        require(sigs.length >= threshold, "not enough sigs");
        bytes32 digest = digestOf(optionId, closePx);
        address[] memory seen = new address[](sigs.length);
        uint256 valid;
        for (uint256 i; i < sigs.length; i++) {
            address rec = _recover(digest, sigs[i]);
            if (!isAttester[rec]) continue;
            bool dup;
            for (uint256 j; j < valid; j++) if (seen[j] == rec) { dup = true; break; }
            if (dup) continue;
            seen[valid] = rec;
            valid++;
        }
        return valid >= threshold;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

contract RunwayOptions {
    uint8 public constant CALL = 0;
    uint8 public constant PUT  = 1;

    struct OQuote {
        uint8   classId;
        uint8   dir;            // 0 CALL / 1 PUT
        uint128 premium;        // USDC in (6dp)
        uint32  multX1e4;       // maxPay = premium * multX1e4 / 1e4
        uint32  bandBps;        // band edge distance from strike, in bps of strike
        uint64  strikeX1e8;
        uint64  validUntil;
        bytes32 salt;
        address buyer;
    }

    struct Option_ {
        address owner;
        uint128 premium;
        uint128 maxPay;         // reserved in full at sale
        uint64  strikeX1e8;
        uint64  openTime;
        uint64  expiry;
        uint32  bandBps;
        uint8   classId;
        uint8   dir;
        bool    live;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MULT_X1E4 = 250_000;   // 25x cap, same menu envelope as the house
    uint256 public constant MIN_MULT_X1E4 = 10_500;    // 1.05x floor
    uint256 public constant MIN_BAND_BPS  = 5;         // 0.05% — below this the ramp is dust
    uint256 public constant MAX_BAND_BPS  = 500;       // 5%
    uint256 public constant MIN_STRIKE_X1E8 = 1e4;     // $0.0001 sanity floor
    uint256 public constant MAX_BET_DIVISOR = 60;      // max premium = T/60
    uint256 public constant DIR_CAP_BPS = 3_000;       // per-(class,dir) exposure <= 30% T
    uint256 public constant QUOTE_TTL = 30;            // seconds
    uint256 public constant STALL_DELAY = 24 hours;
    uint256 public constant LP_EXIT_DELAY = 7 days;

    bytes32 public constant OQUOTE_TYPEHASH = keccak256(
        "OQuote(uint8 classId,uint8 dir,uint128 premium,uint32 multX1e4,uint32 bandBps,"
        "uint64 strikeX1e8,uint64 validUntil,bytes32 salt,address buyer)");

    IERC20MinO public immutable usdc;
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public owner;
    address public quoterSigner;
    address public priceVerifier;

    bool public salesPaused; // halts sales ONLY; settle/refund/exit never pause

    Option_[] public options;
    uint256 public reserved;                       // sum of maxPay over LIVE options
    mapping(uint8 => mapping(uint8 => uint256)) public riskByDir; // (mult-1)*premium exposure

    struct ClassCfg { uint32 maxMultX1e4; uint16 stakeDivisor; bool enabled; }
    mapping(uint8 => ClassCfg) public classCfg;

    // minimal LP vault, same shape as the house (shares accrue the quote edge)
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    struct ExitReq { uint256 sharesAmt; uint64 availableAt; }
    mapping(address => ExitReq) public exits;

    uint256 private _locked = 1;
    modifier nonReentrant() { require(_locked == 1, "reentrancy"); _locked = 2; _; _locked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event OSold(uint256 indexed id, address indexed buyer, uint8 classId, uint8 dir,
                uint256 premium, uint256 maxPay, uint64 strikeX1e8, uint32 bandBps, uint64 expiry);
    event OSettled(uint256 indexed id, uint64 closePx, uint256 paid);
    event ORefunded(uint256 indexed id, uint256 premium);
    event OLpDeposit(address indexed lp, uint256 amount, uint256 shares);
    event OLpExitRequested(address indexed lp, uint256 shares, uint64 availableAt);
    event OLpWithdrawn(address indexed lp, uint256 amount);
    event ClassSet(uint8 indexed classId, uint32 maxMultX1e4, uint16 stakeDivisor, bool enabled);
    event SalesPaused(bool paused);
    event ParamSet(string what, uint256 value);

    constructor(address _usdc, address _quoter) {
        require(_usdc != address(0) && _quoter != address(0), "zero addr");
        usdc = IERC20MinO(_usdc);
        owner = msg.sender;
        quoterSigner = _quoter;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("RunwayOptions"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // ----------------------------------------------------------------- views
    function balance() public view returns (uint256) { return usdc.balanceOf(address(this)); }

    /// Invariant: balance >= reserved always (full-reserve book).
    function treasury() public view returns (uint256) {
        uint256 b = balance();
        require(b >= reserved, "insolvent!");
        return b - reserved;
    }

    function _stakeDivisor(uint8 classId) internal view returns (uint256) {
        ClassCfg memory cc = classCfg[classId];
        return (cc.enabled && cc.stakeDivisor > MAX_BET_DIVISOR) ? cc.stakeDivisor : MAX_BET_DIVISOR;
    }

    function maxPremium(uint8 classId) public view returns (uint256) {
        return treasury() / _stakeDivisor(classId);
    }

    /// theoretical payout for (dir, strike, band, close) — pure pricing, mirror-checked in tests
    function payoutOf(uint8 dir, uint64 strikeX1e8, uint32 bandBps, uint64 closePx, uint256 maxPay)
        public pure returns (uint256)
    {
        uint256 edge = (uint256(strikeX1e8) * bandBps) / BPS;
        if (closePx <= strikeX1e8) {
            if (dir == 0) return 0; // CALL: not in the money
            uint256 diff = uint256(strikeX1e8) - closePx;
            return maxPay * (diff >= edge ? edge : diff) / edge;
        } else {
            if (dir == 1) return 0; // PUT: not in the money
            uint256 diff = uint256(closePx) - uint256(strikeX1e8);
            return maxPay * (diff >= edge ? edge : diff) / edge;
        }
    }

    // ----------------------------------------------------------------- sales
    function buyOption(OQuote calldata q, bytes calldata sig, uint64 worstStrikeX1e8)
        external nonReentrant returns (uint256 id)
    {
        require(!salesPaused, "sales halted");
        require(q.dir <= PUT, "bad dir");
        require(q.validUntil >= block.timestamp, "quote expired");
        require(q.validUntil <= block.timestamp + QUOTE_TTL, "quote too far ahead");
        require(q.multX1e4 >= MIN_MULT_X1E4 && q.multX1e4 <= MAX_MULT_X1E4, "mult clamp");
        require(q.bandBps >= MIN_BAND_BPS && q.bandBps <= MAX_BAND_BPS, "band clamp");
        require(q.strikeX1e8 >= MIN_STRIKE_X1E8, "strike floor");
        // buyer strike protection: CALL wants strike not ABOVE worst, PUT not BELOW
        if (q.dir == CALL) require(q.strikeX1e8 <= worstStrikeX1e8, "strike guard");
        else require(q.strikeX1e8 >= worstStrikeX1e8, "strike guard");

        ClassCfg memory cc = classCfg[q.classId];
        if (cc.maxMultX1e4 != 0 || cc.stakeDivisor != 0 || cc.enabled) {
            require(cc.enabled, "class disabled");
            require(q.multX1e4 <= cc.maxMultX1e4, "class mult cap");
        }

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(OQUOTE_TYPEHASH, q.classId, q.dir, q.premium, q.multX1e4,
                                 q.bandBps, q.strikeX1e8, q.validUntil, q.salt, msg.sender))));
        require(_recoverSig(digest, sig) == quoterSigner, "bad quote sig");
        require(q.buyer == msg.sender, "quote not yours");

        uint256 premium = q.premium;
        uint256 maxPay = uint256(q.multX1e4) * premium / 10_000;
        uint256 exposure = maxPay - premium;       // (M-1)*S
        require(premium > 0 && premium <= maxPremium(q.classId), "premium vs treasury/60");
        require(treasury() >= exposure, "oversell");
        require(riskByDir[q.classId][q.dir] + exposure
                <= treasury() * DIR_CAP_BPS / BPS, "dir cap");

        require(usdc.transferFrom(msg.sender, address(this), premium), "pay in");
        reserved += maxPay;
        riskByDir[q.classId][q.dir] += exposure;

        id = options.length;
        uint64 expiry = uint64(block.timestamp) + 60; // one standard window; attester signs close @expiry
        options.push(Option_({
            owner: msg.sender,
            premium: uint128(premium),
            maxPay: uint128(maxPay),
            strikeX1e8: q.strikeX1e8,
            openTime: uint64(block.timestamp),
            expiry: expiry,
            bandBps: q.bandBps,
            classId: q.classId,
            dir: q.dir,
            live: true
        }));
        emit OSold(id, msg.sender, q.classId, q.dir, premium, maxPay, q.strikeX1e8, q.bandBps, expiry);
    }

    // ----------------------------------------------------------------- settlement
    /// European: settle at/after expiry with an attested close print. ANYONE may relay
    /// (permissionless, same as the house). Pays by ramp; the unearned reserve remainder
    /// stays in treasury by construction.
    function settleWithPrice(uint256 id, uint64 closePx, bytes[] calldata sigs)
        external nonReentrant
    {
        Option_ storage o = options[id];
        require(o.live, "not live");
        require(block.timestamp >= o.expiry, "not expired");
        require(closePx >= MIN_STRIKE_X1E8, "bad px");
        require(IPriceVerifier(priceVerifier).verifyOpt(id, closePx, sigs), "unattested");
        o.live = false;
        reserved -= o.maxPay;
        uint256 exposure = uint256(o.maxPay) - o.premium;
        riskByDir[o.classId][o.dir] -= exposure;

        uint256 paid = payoutOf(o.dir, o.strikeX1e8, o.bandBps, closePx, o.maxPay);
        if (paid > 0) require(usdc.transfer(o.owner, paid), "pay out");
        emit OSettled(id, closePx, paid);
    }

    /// Attester-stall failsafe: expiry + 24h with no valid print => premium back.
    function refundAfterStall(uint256 id) external nonReentrant {
        Option_ storage o = options[id];
        require(o.live, "not live");
        require(block.timestamp >= o.expiry + STALL_DELAY, "not stalled");
        o.live = false;
        reserved -= o.maxPay;
        riskByDir[o.classId][o.dir] -= uint256(o.maxPay) - o.premium;
        require(usdc.transfer(o.owner, o.premium), "refund");
        emit ORefunded(id, o.premium);
    }

    // ----------------------------------------------------------------- LP vault (minimal)
    function lpDeposit(uint256 amount) external nonReentrant {
        require(amount > 0, "zero");
        uint256 nav = balance() - reserved;
        uint256 s = totalShares == 0 ? amount : amount * totalShares / nav;
        require(s > 0, "dust");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        shares[msg.sender] += s;
        totalShares += s;
        emit OLpDeposit(msg.sender, amount, s);
    }

    function lpRequestExit(uint256 sharesAmt) external {
        require(shares[msg.sender] >= sharesAmt && sharesAmt > 0, "bad shares");
        shares[msg.sender] -= sharesAmt;
        totalShares -= sharesAmt;
        exits[msg.sender] = ExitReq(sharesAmt, uint64(block.timestamp + LP_EXIT_DELAY));
        emit OLpExitRequested(msg.sender, sharesAmt, uint64(block.timestamp + LP_EXIT_DELAY));
    }

    function lpWithdraw() external nonReentrant {
        ExitReq memory r = exits[msg.sender];
        require(r.sharesAmt > 0, "no exit");
        require(block.timestamp >= r.availableAt, "not ready");
        uint256 nav = balance() - reserved;   // includes this caller's pending slice
        uint256 amount = r.sharesAmt * nav / (totalShares + r.sharesAmt);
        delete exits[msg.sender];
        require(amount <= treasury(), "drain");  // full-reserve book => this is the whole drain rule
        require(usdc.transfer(msg.sender, amount), "pay out");
        emit OLpWithdrawn(msg.sender, amount);
    }

    // ----------------------------------------------------------------- governance
    function setClassCfg(uint8 classId, uint32 maxMultX1e4, uint16 stakeDivisor, bool enabled)
        external onlyOwner
    {
        require(maxMultX1e4 >= MIN_MULT_X1E4 && maxMultX1e4 <= MAX_MULT_X1E4, "class mult range");
        require(stakeDivisor == 0 || (stakeDivisor >= MAX_BET_DIVISOR && stakeDivisor <= 1_000),
            "class divisor range");
        classCfg[classId] = ClassCfg(maxMultX1e4, stakeDivisor, enabled);
        emit ClassSet(classId, maxMultX1e4, stakeDivisor, enabled);
    }

    function setQuoter(address q) external onlyOwner { require(q != address(0), "zero"); quoterSigner = q; emit ParamSet("quoter", uint256(uint160(q))); }
    function setPriceVerifier(address v) external onlyOwner { require(v != address(0), "zero"); priceVerifier = v; emit ParamSet("verifier", uint256(uint160(v))); }
    function pauseSales(bool p) external onlyOwner { salesPaused = p; emit SalesPaused(p); }

    function _recoverSig(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
