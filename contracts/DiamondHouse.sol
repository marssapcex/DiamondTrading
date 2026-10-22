// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title DiamondHouse — whitepaper §4/§5: full-reserve DIGITAL tickets.
/// One invariant: T = balance − reserved ≥ 0, where reserved is the sum of maximal payouts
/// over live tickets (theorem of §4: every live claim payable in full at all times).
/// No queues, no side buckets, no claims — those states are unrepresentable here.
///
/// Ticket (§5 digital shape): stake S, multiplier M (1.05x–25x envelope, class-tightened),
/// ttl 30/60/120/300s. Settlement (§8): 2-of-3 attested outcome {WON, KNOCKED, EXPIRED} —
/// WON pays M·S, KNOCKED pays 0, EXPIRED (no resolved print in window) rebates 15% of stake.
/// Attester stall > 24h ⇒ permissionless stake refund (§8 failsafe).
/// Pause halts SALES only (§4 C2); settle/refund/LP-exit never pause.

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}
interface IOutcomeVerifier {
    function verify(uint256 ticketId, uint8 outcome, bytes[] calldata sigs) external view returns (bool);
}
interface IRevenueSink {
    function notifyRevenue(uint256 amount) external;
}

contract DiamondHouse {
    enum Outcome { UNSETTLED, WON, KNOCKED, EXPIRED }

    struct Ticket {
        address owner;
        uint128 stake;
        uint32  multX1e4;
        uint64  expiry;
        uint8   classId;
        uint8   dir;
        Outcome outcome;
    }

    struct Quote {
        uint8   classId;
        uint8   dir;
        uint128 stake;
        uint32  multX1e4;
        uint64  validUntil;
        bytes32 salt;
        address buyer;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MULT_X1E4 = 250_000;      // 25x envelope (whitepaper §5)
    uint256 public constant MIN_MULT_X1E4 = 10_500;       // 1.05x floor
    uint256 public constant REBATE_BPS = 1_500;           // EXPIRED pays 15% of stake (§5)
    uint256 public constant MAX_BET_DIVISOR = 60;         // max stake = T/60
    uint256 public constant DIR_CAP_BPS = 3_000;          // per-(class,dir) exposure ≤ 30% T (G3)
    uint256 public constant QUOTE_TTL = 30;               // seconds
    uint256 public constant STALL_DELAY = 24 hours;
    uint256 public constant LP_EXIT_DELAY = 7 days;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 classId,uint8 dir,uint128 stake,uint32 multX1e4,uint64 validUntil,bytes32 salt,address buyer)");

    IERC20Min public immutable usdc;
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public owner;
    address public quoterSigner;
    address public outcomeVerifier;   // §8 pluggable (MultiAttesterVerifier now, L1Read later)
    address public revenueSink;       // RevenueSplit; gets distributable revenue by allowance

    bool public salesPaused;

    Ticket[] public tickets;
    uint256 public reserved;                                  // Σ M·S over live tickets
    mapping(uint8 => mapping(uint8 => uint256)) public riskByDir; // (M−1)·S live exposure

    /// §6 on-chain class table — governance can only TIGHTEN vs global envelope
    struct ClassCfg { uint32 maxMultX1e4; uint16 stakeDivisor; bool enabled; }
    mapping(uint8 => ClassCfg) public classCfg;

    uint256 public totalShares;
    mapping(address => uint256) public shares;
    struct ExitReq { uint256 sharesAmt; uint64 availableAt; }
    mapping(address => ExitReq) public exits;

    uint256 private _locked = 1;
    modifier nonReentrant() { require(_locked == 1, "reentrancy"); _locked = 2; _; _locked = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Sold(uint256 indexed id, address indexed buyer, uint8 classId, uint8 dir,
               uint256 stake, uint32 multX1e4, uint64 expiry);
    event Settled(uint256 indexed id, Outcome outcome, uint256 paid);
    event Refunded(uint256 indexed id, uint256 stake);
    event ClassSet(uint8 indexed classId, uint32 maxMultX1e4, uint16 stakeDivisor, bool enabled);
    event LpDeposit(address indexed lp, uint256 amount, uint256 shares);
    event LpExitRequested(address indexed lp, uint256 shares, uint64 availableAt);
    event LpWithdrawn(address indexed lp, uint256 amount);
    event SalesPaused(bool paused);
    event ParamSet(string what, uint256 value);

    constructor(address _usdc, address _quoter) {
        require(_usdc != address(0) && _quoter != address(0), "zero addr");
        usdc = IERC20Min(_usdc);
        owner = msg.sender;
        quoterSigner = _quoter;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DiamondHouse"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // ---------------- views ----------------
    function balance() public view returns (uint256) { return usdc.balanceOf(address(this)); }

    /// §4 solvency invariant: T = B − R ≥ 0
    function treasury() public view returns (uint256) {
        uint256 b = balance();
        require(b >= reserved, "insolvent!");
        return b - reserved;
    }

    function _stakeDivisor(uint8 classId) internal view returns (uint256) {
        ClassCfg memory cc = classCfg[classId];
        return (cc.enabled && cc.stakeDivisor > MAX_BET_DIVISOR) ? cc.stakeDivisor : MAX_BET_DIVISOR;
    }

    function maxStake(uint8 classId) public view returns (uint256) {
        return treasury() / _stakeDivisor(classId);
    }

    // ---------------- sales ----------------
    function buyTicket(Quote calldata q, bytes calldata sig, uint32 minMultX1e4, uint64 ttl)
        external nonReentrant returns (uint256 id)
    {
        require(!salesPaused, "sales halted");
        require(ttl == 30 || ttl == 60 || ttl == 120 || ttl == 300, "bad ttl");
        require(q.validUntil >= block.timestamp, "quote expired");
        require(q.validUntil <= block.timestamp + QUOTE_TTL, "quote too far ahead");
        require(q.multX1e4 >= MIN_MULT_X1E4 && q.multX1e4 <= MAX_MULT_X1E4, "mult clamp");
        require(q.multX1e4 >= minMultX1e4, "slippage: mult");

        ClassCfg memory cc = classCfg[q.classId];
        if (cc.maxMultX1e4 != 0 || cc.stakeDivisor != 0 || cc.enabled) {
            require(cc.enabled, "class disabled");
            require(q.multX1e4 <= cc.maxMultX1e4, "class mult cap");
        }

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(QUOTE_TYPEHASH, q.classId, q.dir, q.stake,
                                 q.multX1e4, q.validUntil, q.salt, msg.sender))));
        require(_recoverSig(digest, sig) == quoterSigner, "bad quote sig");
        require(q.buyer == msg.sender, "quote not yours");

        uint256 stake = q.stake;
        uint256 fullPay = uint256(q.multX1e4) * stake / 10_000;   // M·S — reserved in full
        uint256 exposure = fullPay - stake;                       // (M−1)·S
        require(stake > 0 && stake <= maxStake(q.classId), "stake vs treasury/60");
        require(treasury() >= exposure, "oversell");
        require(riskByDir[q.classId][q.dir] + exposure
                <= treasury() * DIR_CAP_BPS / BPS, "dir cap");

        require(usdc.transferFrom(msg.sender, address(this), stake), "pay in");
        reserved += fullPay;
        riskByDir[q.classId][q.dir] += exposure;

        id = tickets.length;
        tickets.push(Ticket({
            owner: msg.sender,
            stake: uint128(stake),
            multX1e4: q.multX1e4,
            expiry: uint64(block.timestamp + ttl),
            classId: q.classId,
            dir: q.dir,
            outcome: Outcome.UNSETTLED
        }));
        emit Sold(id, msg.sender, q.classId, q.dir, stake, q.multX1e4, uint64(block.timestamp + ttl));
    }

    // ---------------- settlement (§8) ----------------
    /// Permissionless: anyone may relay an attested outcome; EXPIRED requires expiry reached.
    function settleWithProof(uint256 id, Outcome o, bytes[] calldata sigs) external nonReentrant {
        Ticket storage t = tickets[id];
        require(t.outcome == Outcome.UNSETTLED, "settled");
        require(o == Outcome.WON || o == Outcome.KNOCKED || o == Outcome.EXPIRED, "bad outcome");
        if (o == Outcome.EXPIRED) require(block.timestamp >= t.expiry, "not expired");
        require(IOutcomeVerifier(outcomeVerifier).verify(id, uint8(o), sigs), "unattested");
        t.outcome = o;

        uint256 fullPay = uint256(t.multX1e4) * t.stake / 10_000;
        reserved -= fullPay;
        riskByDir[t.classId][t.dir] -= fullPay - t.stake;

        uint256 paid;
        if (o == Outcome.WON) paid = fullPay;
        else if (o == Outcome.EXPIRED) paid = uint256(t.stake) * REBATE_BPS / BPS;
        if (paid > 0) require(usdc.transfer(t.owner, paid), "pay out");
        emit Settled(id, o, paid);
    }

    /// §8 attester-stall failsafe: expiry + 24h ⇒ stake back to anyone who calls.
    function refundAfterStall(uint256 id) external nonReentrant {
        Ticket storage t = tickets[id];
        require(t.outcome == Outcome.UNSETTLED, "settled");
        require(block.timestamp >= t.expiry + STALL_DELAY, "not stalled");
        t.outcome = Outcome.EXPIRED;   // tombstone; refund is full stake by design
        reserved -= uint256(t.multX1e4) * t.stake / 10_000;
        riskByDir[t.classId][t.dir] -= (uint256(t.multX1e4) * t.stake / 10_000) - t.stake;
        require(usdc.transfer(t.owner, t.stake), "refund");
        emit Refunded(id, t.stake);
    }

    // ---------------- LP first-loss vault ----------------
    function lpDeposit(uint256 amount) external nonReentrant {
        require(amount > 0, "zero");
        uint256 nav = balance() - reserved;
        uint256 s = totalShares == 0 ? amount : amount * totalShares / nav;
        require(s > 0, "dust");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        shares[msg.sender] += s;
        totalShares += s;
        emit LpDeposit(msg.sender, amount, s);
    }

    function lpRequestExit(uint256 sharesAmt) external {
        require(shares[msg.sender] >= sharesAmt && sharesAmt > 0, "bad shares");
        shares[msg.sender] -= sharesAmt;
        totalShares -= sharesAmt;
        exits[msg.sender] = ExitReq(sharesAmt, uint64(block.timestamp + LP_EXIT_DELAY));
        emit LpExitRequested(msg.sender, sharesAmt, uint64(block.timestamp + LP_EXIT_DELAY));
    }

    function lpWithdraw() external nonReentrant {
        ExitReq memory r = exits[msg.sender];
        require(r.sharesAmt > 0, "no exit");
        require(block.timestamp >= r.availableAt, "not ready");
        uint256 nav = balance() - reserved;
        uint256 amount = r.sharesAmt * nav / (totalShares + r.sharesAmt);
        delete exits[msg.sender];
        require(amount <= treasury(), "drain");   // §4 invariant as the whole drain rule
        require(usdc.transfer(msg.sender, amount), "pay out");
        emit LpWithdrawn(msg.sender, amount);
    }

    // ---------------- governance ----------------
    function setClassCfg(uint8 classId, uint32 maxMultX1e4, uint16 stakeDivisor, bool enabled)
        external onlyOwner
    {
        require(maxMultX1e4 >= MIN_MULT_X1E4 && maxMultX1e4 <= MAX_MULT_X1E4, "class mult range");
        require(stakeDivisor == 0 || (stakeDivisor >= MAX_BET_DIVISOR && stakeDivisor <= 1_000),
            "class divisor range");
        classCfg[classId] = ClassCfg(maxMultX1e4, stakeDivisor, enabled);
        emit ClassSet(classId, maxMultX1e4, stakeDivisor, enabled);
    }

    function setQuoter(address qa) external onlyOwner { require(qa != address(0), "zero"); quoterSigner = qa; emit ParamSet("quoter", uint256(uint160(qa))); }
    function setOutcomeVerifier(address v) external onlyOwner { require(v != address(0), "zero"); outcomeVerifier = v; emit ParamSet("verifier", uint256(uint160(v))); }
    function setRevenueSink(address s) external onlyOwner {
        revenueSink = s;
        require(usdc.approve(s, type(uint256).max), "approve");
        emit ParamSet("revenueSink", uint256(uint160(s)));
    }
    function pauseSales(bool p) external onlyOwner { salesPaused = p; emit SalesPaused(p); }

    /// §10 waterfall: move realized revenue to the sink (RevenueSplit) — invariant-gated.
    /// Pull-based: the sink takes `amount` via transferFrom (approved in setRevenueSink),
    /// so exactly `amount` leaves the house and treasury() stays ≥ what was promised to tickets.
    function distributeRevenue(uint256 amount) external onlyOwner {
        require(revenueSink != address(0), "no sink");
        require(amount <= treasury(), "drain");
        IRevenueSink(revenueSink).notifyRevenue(amount);
        require(usdc.balanceOf(address(this)) >= reserved, "post-dist cover");
    }

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
