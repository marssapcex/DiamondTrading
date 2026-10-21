// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RUNWAY — two-tier fixed-odds turbo-ticket house with a public, yield-bearing
///        claim queue ("the runway"). One contract, one ledger: every liability is a
///        first-class object or a counter updated in exactly one transition each.
///
/// v2 — fixes found by adversarial self-review of v1 (see README §"v1 findings"):
///  F1 [critical] instant tier now reserves the FULL payout M*S (was (M-1)*S): user stakes sit
///     inside the lock, so LP exits can never break balance >= locked while tickets are live.
///  F2 [high] claim yield settles AT payout/forfeit time and is paid inline — a paid claim can
///     no longer keep accruing index deltas forever (free-money leak).
///  F3 [medium] depositClaimYield reverts when no live claims exist (funds would be stuck
///     forever in yieldPool).
///  F4 [low] settlement of EXPIRED outcomes is time-pinned on-chain: keeper cannot expire a
///     ticket before its own expiry.
///
/// Design sources (see README):
///  * Martin Galer whitepaper (papertrade team): zero-capital bootstrap payout queue with a
///    solvency-ratio invariant (SRI) and principal-withdraw-forfeit-winnings.
///  * Guardian audit of papertrade (42 findings): kills the shared-cursor accounting class by
///    construction — per-ticket reservations, per-claim ledger entries, no sideBuckets, no
///    session accumulators, no queue-toggle fee paths.
///
/// Accounting model (treasury T = LP first-loss capital):
///      T = USDC.balance - instantReserved - yieldPool          [>= 0 always, reverts if broken]
/// Queue liabilities are tracked SEPARATELY (claims are conditional debt); their payment passes
/// the single drain rule `_drainOk`: after any treasury outflow, T >= SRI_FLOOR * queueStack.
/// That rule has exactly four call sites: instant runway pay, FIFO crank, claim forfeit, LP exit.

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

contract RunwayHouse {
    // ----------------------------------------------------------------- types
    enum Outcome { UNSETTLED, WON, KNOCKED_OUT, EXPIRED, REFUNDED }
    enum Tier { INSTANT, RUNWAY }

    struct Ticket {
        address owner;
        uint128 stake;          // USDC (6 decimals)
        uint32  multX1e4;       // payout multiplier M * 1e4 (3.6x = 36000)
        uint64  openTime;
        uint64  expiry;
        uint8   classId;
        uint8   dir;            // 0 = LONG, 1 = SHORT
        Tier    tier;
        Outcome outcome;
    }

    struct Claim {              // seniority by queue order; separate ledger line per claim
        address owner;
        uint128 principal;      // owed stake (paid on payout/forfeit)
        uint128 winnings;       // owed profit
        uint64  birthTime;
        uint96  listPrice;      // 0 = not listed on the internal market
        uint256 yieldIndexAtBirth; // per-claim checkpoint (audit-safe accrual pattern)
        bool    paid;
        bool    forfeited;
    }

    struct Quote {              // EIP-712 signed by the off-chain quoter (trust declared)
        uint8   classId;
        uint8   dir;
        uint8   tier;
        uint128 stake;
        uint32  multX1e4;
        uint64  validUntil;
        bytes32 salt;
    }

    // ----------------------------------------------------------------- constants
    IERC20Min public immutable usdc;               // USDC, 6 decimals
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MULT_X1E4 = 250_000;      // 25x menu cap
    uint256 public constant MIN_MULT_X1E4 = 10_500;       // 1.05x floor
    uint256 public constant REBATE_BPS = 1_500;           // expire pays 15% of stake
    uint256 public constant MAX_BET_DIVISOR = 60;         // max stake = base/60  (KO-K3 bankroll rule)
    uint256 public constant DIR_CAP_BPS = 3_000;          // per-(class,dir) instant exposure <= 30% T
    uint256 public constant RUNWAY_RISK_BPS = 50_000;     // spam-throttle: live runway potential
                                                          // liability <= 5x (T + todayFlow)
    uint64  public constant RESOLVE_GRACE = 24 hours;     // keeper-stall -> user refund
    uint64  public constant LP_EXIT_DELAY = 7 days;
    uint64  public constant MAX_CLAIM_AGE = 30 days;      // kill gate: rehab mode
    uint256 public constant SRI_FLOOR_BPS = 1_000;        // T >= 10% of queueStack after any drain
    uint64  public constant QUOTE_TTL = 30 seconds;
    uint256 public constant KG_SCAN_LIMIT = 256;          // bounded kill-gate scan

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint8 classId,uint8 dir,uint8 tier,uint128 stake,uint32 multX1e4,uint64 validUntil,bytes32 salt,address buyer)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ----------------------------------------------------------------- governance-lite
    // Production: `owner` = OZ TimelockController (immutable 7-day minDelay) gated by a Safe
    // 2-of-3. Here owner is an EOA for testnet; param setters are validated (audit L-06).
    address public owner;
    address public quoterSigner;      // off-chain quote engine key (clamped on-chain)
    address public outcomeVerifier;   // pluggable attestation verifier (multi-attester now,
                                      //  L1Read print-proof later) — no single-keeper trust

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    bool public salesPaused;  // halts sales ONLY; settle/payout/market never pause (audit L-11)
    bool public rehabMode;    // kill gate engaged: sales halted + wind-down path open

    // ----------------------------------------------------------------- house accounting
    uint256 public instantReserved;      // FULL payouts M*S over LIVE instant tickets (v2 F1)
    uint256 public queuePrincipal;       // claim.principal over unpaid claims
    uint256 public queueWinnings;        // claim.winnings over unpaid claims
    uint256 public yieldPool;            // USDC earmarked for claim yield
    uint256 public runwayOpenPotential;  // (M-1)*S over LIVE runway tickets (pre-outcome)

    mapping(uint8 => mapping(uint8 => uint256)) public instantRiskByDir; // (M-1)*S exposure

    /// v3.1 per-underlyer menu table (classId = underlyer id).
    /// Unset class => legacy global clamps. Set class => tighter, owner-governed bounds.
    struct ClassCfg { uint32 maxMultX1e4; uint16 stakeDivisor; bool enabled; }
    mapping(uint8 => ClassCfg) public classCfg;

    // ----------------------------------------------------------------- bootstrap flow caps
    // runway tier max-bet keys off FLOW, not current treasury — restores Martin Galer's
    // $0 bootstrap WITHOUT "unconstrained bet sizing" (their fatal sin):
    //      maxStakeRunway = max(bootstrapMaxStake, (treasury + todayFlow)/60)
    uint256 public bootstrapMaxStake;    // governance-set, validated
    uint256 public todayFlow;
    uint256 public flowDay;

    // ----------------------------------------------------------------- tickets & claims
    Ticket[] public tickets;
    Claim[]  public claims;
    uint256  public claimHead;           // FIFO pointer (oldest unpaid claim)

    // ----------------------------------------------------------------- claim yield index
    uint256 public claimYieldIndex;      // 1e18-scaled cumulative USDC per unit principal

    // ----------------------------------------------------------------- LP (treasury first-loss)
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    struct ExitReq { uint256 sharesAmt; uint64 availableAt; }
    mapping(address => ExitReq) public exitReq;

    // ----------------------------------------------------------------- reentrancy
    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    // ----------------------------------------------------------------- events
    event ClassSet(uint8 indexed classId, uint32 maxMultX1e4, uint16 stakeDivisor, bool enabled);
    event Sold(uint256 indexed id, address indexed buyer, Tier tier, uint8 classId, uint8 dir,
               uint256 stake, uint32 multX1e4, uint64 expiry);
    event Settled(uint256 indexed id, Outcome outcome, uint256 paid, uint256 claimId);
    event ClaimEnqueued(uint256 indexed cid, address indexed owner, uint256 principal, uint256 winnings);
    event ClaimPaid(uint256 indexed cid, address indexed to, uint256 amount);
    event ClaimForfeited(uint256 indexed cid, uint256 principalPaid);
    event ClaimListed(uint256 indexed cid, uint256 price);
    event ClaimBought(uint256 indexed cid, address indexed from, address indexed to, uint256 price);
    event YieldDeposited(uint256 amount, uint256 newIndex);
    event YieldClaimed(uint256 indexed cid, address indexed to, uint256 amount);
    event LPDeposit(address indexed lp, uint256 amount, uint256 sharesMinted);
    event LPExitRequested(address indexed lp, uint256 sharesAmt, uint64 availableAt);
    event LPWithdrawn(address indexed lp, uint256 amount, uint256 sharesBurned);
    event RehabSet(bool on, string reason);
    event SalesPaused(bool paused);
    event ParamSet(string what, uint256 value);

    constructor(address _usdc, address _quoter) {
        require(_usdc != address(0) && _quoter != address(0), "zero addr");
        usdc = IERC20Min(_usdc);
        owner = msg.sender;
        quoterSigner = _quoter;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("RunwayHouse"), keccak256("1"), block.chainid, address(this)
        ));
    }

    // ----------------------------------------------------------------- views
    function balance() public view returns (uint256) { return usdc.balanceOf(address(this)); }

    /// @notice LP first-loss capital. Invariant: balance >= instantReserved + yieldPool.
    function treasury() public view returns (uint256) {
        uint256 b = balance();
        uint256 locked = instantReserved + yieldPool;
        require(b >= locked, "INVARIANT: negative treasury");
        return b - locked;
    }

    /// @notice the single drain rule: after ANY treasury outflow, T must still cover
    ///         SRI_FLOOR of the queue stack projected AFTER the action's own liability
    ///         removal (crank/forfeit remove liabilities; LP exit and instant pays do not).
    function _drainOk(uint256 treasuryAfter, uint256 queueAfter) internal pure returns (bool) {
        return queueAfter == 0 || treasuryAfter * BPS >= SRI_FLOOR_BPS * queueAfter;
    }

    function solvencyRatioBps() public view returns (uint256) {
        uint256 q = queuePrincipal + queueWinnings;
        if (q == 0) return type(uint256).max;
        return (treasury() + queuePrincipal) * BPS / q; // Martin Galer SRI shape
    }

    function _flowToday() internal view returns (uint256) {
        return block.timestamp / 1 days == flowDay ? todayFlow : 0;
    }

    /// INSTANT tier: stake cap is pure treasury-based (needs capital; launch floor per
    /// the solvency model in the KNOCKOUT round).
    function _stakeDivisor(uint8 classId) internal view returns (uint256) {
        ClassCfg memory cc = classCfg[classId];
        return (cc.enabled && cc.stakeDivisor > MAX_BET_DIVISOR) ? cc.stakeDivisor : MAX_BET_DIVISOR;
    }

    function maxStakeInstant() public view returns (uint256) { return treasury() / MAX_BET_DIVISOR; }

    /// class-aware: thin underlyers get a larger divisor (smaller max bet).
    function maxStakeInstant(uint8 classId) public view returns (uint256) {
        return treasury() / _stakeDivisor(classId);
    }

    /// RUNWAY tier: cap = f(flow) — bootstraps from $0 with a bounded seed cap.
    function maxStakeRunway() public view returns (uint256) {
        uint256 flowCap = (treasury() + _flowToday()) / MAX_BET_DIVISOR;
        return flowCap > bootstrapMaxStake ? flowCap : bootstrapMaxStake;
    }

    /// class-aware: tightened classes also lose the bootstrap floor — no seed privilege
    /// for underlyers whose prints are cheap to move.
    function maxStakeRunway(uint8 classId) public view returns (uint256) {
        uint256 div = _stakeDivisor(classId);
        uint256 flowCap = (treasury() + _flowToday()) / div;
        if (div > MAX_BET_DIVISOR) return flowCap;
        return flowCap > bootstrapMaxStake ? flowCap : bootstrapMaxStake;
    }

    function _runwayBudget() internal view returns (uint256) {
        return (treasury() + _flowToday()) * RUNWAY_RISK_BPS / BPS;
    }

    function claimCount() external view returns (uint256) { return claims.length; }
    function ticketCount() external view returns (uint256) { return tickets.length; }

    // ----------------------------------------------------------------- sale
    /// @param minMultX1e4 user-side slippage bound on the multiplier (audit KV-14: intents
    ///        must carry a price bound).
    function buyTicket(Quote calldata q, bytes calldata sig, uint32 minMultX1e4, uint64 ttl)
        external nonReentrant returns (uint256 id)
    {
        require(!salesPaused && !rehabMode, "sales halted");
        require(q.tier <= uint8(Tier.RUNWAY), "bad tier");
        require(q.multX1e4 >= minMultX1e4, "slippage: mult");
        require(ttl == 0 || ttl == 60 || ttl == 300, "bad ttl");

        require(q.validUntil >= block.timestamp, "quote expired");
        require(q.validUntil <= block.timestamp + QUOTE_TTL, "quote too far ahead");
        require(q.multX1e4 >= MIN_MULT_X1E4 && q.multX1e4 <= MAX_MULT_X1E4, "mult clamp");
        ClassCfg memory _cc = classCfg[q.classId];           // v3.1 per-underlyer table
        if (_cc.maxMultX1e4 != 0 || _cc.stakeDivisor != 0 || _cc.enabled) {
            require(_cc.enabled, "class disabled");          // listed but switched off
            require(q.multX1e4 <= _cc.maxMultX1e4, "class mult cap");
        }
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(QUOTE_TYPEHASH, q.classId, q.dir, q.tier, q.stake,
                                 q.multX1e4, q.validUntil, q.salt, msg.sender))));
        require(_recoverSig(digest, sig) == quoterSigner, "bad quote sig");

        uint256 stake = q.stake;
        uint256 liability = (uint256(q.multX1e4) - 10_000) * stake / 10_000; // (M-1)*S exposure
        uint256 fullPayout = uint256(q.multX1e4) * stake / 10_000;           // M*S — lock amount

        require(usdc.transferFrom(msg.sender, address(this), stake), "pay in");

        if (block.timestamp / 1 days != flowDay) { flowDay = block.timestamp / 1 days; todayFlow = 0; }
        todayFlow += stake;

        if (q.tier == uint8(Tier.INSTANT)) {
            require(stake > 0 && stake <= maxStakeInstant(q.classId), "stake vs treasury/60");
            // admission control: treasury must cover the EXPOSURE; with stake in B, locking M*S
            // keeps B - locked >= 0 iff T >= (M-1)*S — one condition covers both checks.
            require(treasury() >= liability, "oversell");
            require(instantRiskByDir[q.classId][q.dir] + liability
                    <= treasury() * DIR_CAP_BPS / BPS, "dir cap");
            instantReserved += fullPayout;   // v2 F1: lock full payout (stake inside the lock)
            instantRiskByDir[q.classId][q.dir] += liability;
        } else {
            require(stake > 0 && stake <= maxStakeRunway(q.classId), "stake vs flow/60");
            require(runwayOpenPotential + liability <= _runwayBudget(), "runway budget");
            runwayOpenPotential += liability;
        }

        id = tickets.length;
        uint64 expiry = uint64(block.timestamp + (ttl == 0 ? 60 : ttl));
        tickets.push(Ticket({
            owner: msg.sender,
            stake: uint128(stake),
            multX1e4: q.multX1e4,
            openTime: uint64(block.timestamp),
            expiry: expiry,
            classId: q.classId,
            dir: q.dir,
            tier: Tier(q.tier),
            outcome: Outcome.UNSETTLED
        }));
        emit Sold(id, msg.sender, Tier(q.tier), q.classId, q.dir, stake, q.multX1e4, expiry);
    }

    // ----------------------------------------------------------------- settlement
    /// Outcomes are ATTESTED (multi-attester EIP-712 by default) and relayed permissionlessly:
    /// anyone may submit a validly-attested outcome. No single keeper can settle alone, and
    /// no keeper can censor — a second relayer always exists (the user himself).
    function settleWithProof(uint256 id, Outcome o, bytes[] calldata sigs) external nonReentrant {
        Ticket storage t = tickets[id];
        require(t.outcome == Outcome.UNSETTLED, "settled");
        require(o == Outcome.WON || o == Outcome.KNOCKED_OUT || o == Outcome.EXPIRED, "bad outcome");
        if (o == Outcome.EXPIRED) {
            require(block.timestamp >= t.expiry, "early expire"); // v2 F4: time-pinned
        }
        require(outcomeVerifier != address(0), "no verifier");
        require(IOutcomeVerifier(outcomeVerifier).verify(id, uint8(o), sigs), "unattested");
        _settle(id, o);
    }

    /// Keeper-stall failsafe: after expiry + grace ANYONE may refund the ticket (stake back,
    /// no win/loss). Never settles on stale data (audit L-11).
    function refundAfterStall(uint256 id) external nonReentrant {
        Ticket storage t = tickets[id];
        require(t.outcome == Outcome.UNSETTLED, "settled");
        require(block.timestamp > uint256(t.expiry) + RESOLVE_GRACE, "too early");
        uint256 stake = t.stake;
        if (t.tier == Tier.INSTANT) {
            uint256 full = uint256(t.multX1e4) * stake / 10_000;
            instantReserved -= full;
            instantRiskByDir[t.classId][t.dir] -= (uint256(t.multX1e4) - 10_000) * stake / 10_000;
            _pay(t.owner, stake);
        } else {
            runwayOpenPotential -= (uint256(t.multX1e4) - 10_000) * stake / 10_000;
            if (_canPayFromTreasury(stake, 0)) {
                _pay(t.owner, stake);
            } else {
                _enqueue(t.owner, uint128(stake), 0); // principal-only refund claim
            }
        }
        t.outcome = Outcome.REFUNDED;
        emit Settled(id, Outcome.REFUNDED, stake, type(uint256).max);
    }

    function _settle(uint256 id, Outcome o) internal {
        Ticket storage t = tickets[id];
        uint256 stake = t.stake;
        uint256 full = uint256(t.multX1e4) * stake / 10_000;
        uint256 payout;
        uint256 claimId = type(uint256).max;

        if (t.tier == Tier.INSTANT) {
            instantReserved -= full;
            instantRiskByDir[t.classId][t.dir] -= full - stake;
            if (o == Outcome.WON) {
                payout = full;
                _pay(t.owner, payout); // fully locked at sale — always payable, no queue anywhere
            } else if (o == Outcome.EXPIRED) {
                payout = stake * REBATE_BPS / BPS;
                _pay(t.owner, payout); // rebate bounded inside the locked payout
            }
        } else {
            runwayOpenPotential -= full - stake;
            if (o == Outcome.WON) {
                if (_canPayFromTreasury(full, 0)) {
                    payout = full;
                    _pay(t.owner, payout);
                } else {
                    claimId = _enqueue(t.owner, uint128(stake), uint128(full - stake));
                }
            } else if (o == Outcome.EXPIRED) {
                uint256 rebate = stake * REBATE_BPS / BPS;
                if (_canPayFromTreasury(rebate, 0)) {
                    payout = rebate;
                    _pay(t.owner, payout);
                } else {
                    claimId = _enqueue(t.owner, uint128(rebate), 0);
                }
            }
        }
        t.outcome = o;
        emit Settled(id, o, payout, claimId);
        _checkKillGate();
    }

    /// Treasury outflow `amount` allowed only if the SRI floor survives it, evaluated against
    /// the queue stack AFTER `removedLiability` (0 for LP exit / instant runway win).
    function _canPayFromTreasury(uint256 amount, uint256 removedLiability) internal view returns (bool) {
        uint256 T = treasury();
        return T >= amount && _drainOk(T - amount, queuePrincipal + queueWinnings - removedLiability);
    }

    // ----------------------------------------------------------------- claims (the runway)
    function _enqueue(address to, uint128 principal, uint128 winnings) internal returns (uint256 cid) {
        cid = claims.length;
        claims.push(Claim({
            owner: to,
            principal: principal,
            winnings: winnings,
            birthTime: uint64(block.timestamp),
            listPrice: 0,
            yieldIndexAtBirth: claimYieldIndex,
            paid: false,
            forfeited: false
        }));
        queuePrincipal += principal;
        queueWinnings += winnings;
        emit ClaimEnqueued(cid, to, principal, winnings);
        _checkKillGate();
    }

    /// Permissionless crank: pay the head of the queue while the SRI floor survives.
    function crankPayClaims(uint256 maxCount) external nonReentrant {
        uint256 paid = 0;
        while (paid < maxCount && claimHead < claims.length) {
            Claim storage c = claims[claimHead];
            if (c.paid || c.forfeited) { claimHead++; continue; }
            uint256 amt = uint256(c.principal) + c.winnings;
            if (!_canPayFromTreasury(amt, amt)) break; // paying the head REMOVES its liability

            _settleYield(claimHead); // v2 F2: accrual STOPS at payout; owed yield paid inline
            queuePrincipal -= c.principal;
            queueWinnings  -= c.winnings;
            c.paid = true;
            _pay(c.owner, amt);
            emit ClaimPaid(claimHead, c.owner, amt);
            claimHead++;
            paid++;
        }
        _clearRehabIfDrained();
    }

    /// Martin Galer freedom: stuck claimant withdraws principal, forfeits winnings.
    /// Forfeited winnings return to solvency of the remaining queue.
    function forfeitClaim(uint256 cid) external nonReentrant {
        Claim storage c = claims[cid];
        require(msg.sender == c.owner, "not owner");
        require(!c.paid && !c.forfeited, "done");
        require(_canPayFromTreasury(c.principal, uint256(c.principal) + c.winnings),
                "principal not payable yet");
        _settleYield(cid); // v2 F2
        queuePrincipal -= c.principal;
        queueWinnings  -= c.winnings;
        c.forfeited = true;
        _pay(c.owner, c.principal);
        emit ClaimForfeited(cid, c.principal);
        _clearRehabIfDrained();
    }

    // ---- internal claim market (waiting is a product; priced, not hidden) ----
    function listClaim(uint256 cid, uint96 price) external {
        Claim storage c = claims[cid];
        require(msg.sender == c.owner, "not owner");
        require(!c.paid && !c.forfeited, "done");
        c.listPrice = price;
        emit ClaimListed(cid, price);
    }

    function buyClaim(uint256 cid) external nonReentrant {
        Claim storage c = claims[cid];
        uint256 price = c.listPrice;
        require(price > 0, "not listed");
        require(!c.paid && !c.forfeited, "done");
        address seller = c.owner;
        c.listPrice = 0;           // effects before interaction
        c.owner = msg.sender;
        require(usdc.transferFrom(msg.sender, seller, price), "pay seller");
        emit ClaimBought(cid, seller, msg.sender, price);
    }

    // ---- claim yield: paid from REAL revenue deposits only; per-claim checkpoints ----
    /// Treasury moves USDC into the yield escrow (seniority interest while claims wait).
    /// T >= amount is required: yield cannot deepen insolvency. v2 F3: reverts with no live
    /// claims (funds would otherwise be stuck in the pool forever).
    function depositClaimYield(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "zero");
        require(queuePrincipal > 0, "no live claims"); // v2 F3
        require(treasury() >= amount, "would breach T");
        yieldPool += amount;
        claimYieldIndex += amount * 1e18 / queuePrincipal;
        emit YieldDeposited(amount, claimYieldIndex);
    }

    /// Settle a claim's accrued yield AT resolution time (pay or forfeit). After this,
    /// the claim stops accréting — a paid/forfeited claim cannot leak future index deltas.
    function _settleYield(uint256 cid) internal {
        Claim storage c = claims[cid];
        uint256 idxNow = claimYieldIndex;
        uint256 idxThen = c.yieldIndexAtBirth;
        if (idxNow == idxThen) return;
        uint256 owed = uint256(c.principal) * (idxNow - idxThen) / 1e18;
        c.yieldIndexAtBirth = idxNow;
        if (owed > yieldPool) owed = yieldPool; // dust guard
        if (owed > 0) {
            yieldPool -= owed;
            _pay(c.owner, owed);
            emit YieldClaimed(cid, c.owner, owed);
        }
    }

    /// Waiting claimants can also pull accrued yield any time before resolution.
    function claimYield(uint256 cid) external nonReentrant {
        Claim storage c = claims[cid];
        require(msg.sender == c.owner, "not owner");
        require(!c.forfeited, "forfeited");
        uint256 idxNow = claimYieldIndex;
        require(idxNow > c.yieldIndexAtBirth, "none accrued");
        _settleYield(cid);
    }

    // ----------------------------------------------------------------- LP (first-loss treasury)
    function lpDeposit(uint256 amount) external nonReentrant returns (uint256 minted) {
        require(!rehabMode, "rehab");
        require(usdc.transferFrom(msg.sender, address(this), amount), "pay in");
        uint256 T = treasury(); // NAV pre-deposit
        minted = totalShares == 0 || T == 0 ? amount : amount * totalShares / T;
        totalShares += minted;
        shares[msg.sender] += minted;
        emit LPDeposit(msg.sender, amount, minted);
    }

    function lpRequestExit(uint256 sharesAmt) external {
        require(sharesAmt > 0 && shares[msg.sender] >= sharesAmt, "shares");
        exitReq[msg.sender] = ExitReq(sharesAmt, uint64(block.timestamp + LP_EXIT_DELAY));
        emit LPExitRequested(msg.sender, sharesAmt, uint64(block.timestamp + LP_EXIT_DELAY));
    }

    function lpWithdraw() external nonReentrant {
        ExitReq memory r = exitReq[msg.sender];
        require(r.sharesAmt > 0 && block.timestamp >= r.availableAt, "not ready");
        uint256 amt = r.sharesAmt * treasury() / totalShares;
        require(_drainOk(treasury() - amt, queuePrincipal + queueWinnings),
                "SRI: LP exit locked while claims stand");
        delete exitReq[msg.sender];
        totalShares -= r.sharesAmt;
        shares[msg.sender] -= r.sharesAmt;
        _pay(msg.sender, amt);
        emit LPWithdrawn(msg.sender, amt, r.sharesAmt);
    }

    // ----------------------------------------------------------------- kill gates (with teeth)
    function _checkKillGate() internal {
        if (rehabMode) return;
        uint256 i = claimHead;
        uint256 end = claims.length;
        uint256 steps;
        while (i < end && steps < KG_SCAN_LIMIT) {
            if (!claims[i].paid && !claims[i].forfeited) {
                if (block.timestamp > claims[i].birthTime + MAX_CLAIM_AGE) {
                    rehabMode = true;
                    emit RehabSet(true, "oldest claim aged out");
                }
                return;
            }
            i++; steps++;
        }
    }

    /// Anyone may poke the gate (keeper bots orbit this).
    function pokeKillGate() external { _checkKillGate(); }

    function _clearRehabIfDrained() internal {
        if (rehabMode && queuePrincipal + queueWinnings == 0) {
            rehabMode = false; // auto-recover only when queue fully drained
            emit RehabSet(false, "queue drained");
        }
    }

    // ----------------------------------------------------------------- governance-lite
    function pauseSales(bool p) external onlyOwner { salesPaused = p; emit SalesPaused(p); }
    function setQuoter(address q) external onlyOwner { require(q != address(0), "zero"); quoterSigner = q; emit ParamSet("quoter", uint256(uint160(q))); }
    function setOutcomeVerifier(address v) external onlyOwner { require(v != address(0), "zero"); outcomeVerifier = v; emit ParamSet("verifier", uint256(uint160(v))); }

    // ----------------------------------------------------------------- revenue distribution
    // One-directional OUTFLOW to the stakers' sink; the sink NEVER reads house state
    // (audit lesson: no cross-domain cursors). Drain-gated like every treasury outflow.
    address public revenueSink;

    function setRevenueSink(address s) external onlyOwner {
        require(s != address(0), "zero");
        revenueSink = s;
        require(usdc.approve(s, type(uint256).max), "approve");
        emit ParamSet("revenueSink", uint256(uint160(s)));
    }

    /// Push realized positive edge share (amount) to the stakers' sink. Only callable when
    /// the drain rule survives the outflow (claims senior to distributions).
    function distributeToStakers(uint256 amount) external nonReentrant onlyOwner {
        require(revenueSink != address(0), "no sink");
        uint256 T = treasury();
        require(T >= amount && _drainOk(T - amount, queuePrincipal + queueWinnings), "drain");
        IRevenueSink(revenueSink).notifyRevenue(amount); // sink pulls USDC from house
    }
    function transferOwnership(address n) external onlyOwner { require(n != address(0), "zero"); owner = n; emit ParamSet("owner", uint256(uint160(n))); }

    /// Bootstrap cap setter — validated (audit L-06: every numeric config validated at write).
    /// v3.1: admit/tighten an underlyer. Governance may only TIGHTEN vs global menu
    /// (maxMult <= 25x cap, divisor >= 60). `enabled=false` halts sales on that class
    /// without touching open tickets (settlement/refund paths unaffected).
    function setClassCfg(uint8 classId, uint32 maxMultX1e4, uint16 stakeDivisor, bool enabled)
        external onlyOwner
    {
        require(maxMultX1e4 >= MIN_MULT_X1E4 && maxMultX1e4 <= MAX_MULT_X1E4, "class mult range");
        require(stakeDivisor == 0 || (stakeDivisor >= MAX_BET_DIVISOR && stakeDivisor <= 1_000),
            "class divisor range");
        classCfg[classId] = ClassCfg(maxMultX1e4, stakeDivisor, enabled);
        emit ClassSet(classId, maxMultX1e4, stakeDivisor, enabled);
    }

    function setBootstrapMaxStake(uint256 v) external onlyOwner {
        require(v <= 10_000e6, "cap too high"); // <= $10k seed
        bootstrapMaxStake = v;
        emit ParamSet("bootstrapMaxStake", v);
    }

    // ----------------------------------------------------------------- internals
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        require(usdc.transfer(to, amount), "pay out");
    }

    function _recoverSig(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "sig len");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "sig v");
        address rec = ecrecover(digest, v, r, s);
        require(rec != address(0), "sig");
        return rec;
    }
}
