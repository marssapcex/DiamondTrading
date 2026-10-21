// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IEdgeToken {
    function mint(address to, uint256 amount) external;
}

/// @title EdgeDistributor — epoch-based merkle distributor for EDGE net-loss minting.
/// Once per epoch (target: 6h), governance posts (epochId, root, totalMint). totalMint is
/// HARD-CAPPED by a budget rule: budget(t) <= BUDGET_BPS of treasury revenue inflow reported
/// by a bonded revenue attester -- the off-chain net-loss computation can never inflate
/// emission past earned revenue (mint-basis lesson, audit KV-04 / M-05).
///
/// Leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, account, amount))))
/// Users self-claim with a merkle proof. One claim per (epoch, account).
contract EdgeDistributor {
    IEdgeToken public immutable edge;
    address public owner;
    address public budgetAttester; // bonded off-chain accountant; reports revenue anchor

    uint256 public constant BUDGET_BPS = 3_000;   // <=30% of reported revenue per epoch
    uint256 public constant MAX_EPOCH_GAP = 7 days;
    uint256 public constant BPS = 10_000;

    struct Epoch { bytes32 root; uint256 totalMint; uint64 postedAt; }
    mapping(uint256 => Epoch) public epochs;
    uint256 public lastEpoch;
    mapping(uint256 => mapping(address => bool)) public claimed;
    uint256 public totalMinted;

    event EpochPosted(uint256 indexed epochId, bytes32 root, uint256 totalMint, uint256 budget);
    event Claimed(uint256 indexed epochId, address indexed account, uint256 amount);
    event BudgetAttesterSet(address indexed who);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _edge) {
        require(_edge != address(0), "zero");
        edge = IEdgeToken(_edge);
        owner = msg.sender;
    }

    function setBudgetAttester(address who) external onlyOwner {
        budgetAttester = who;
        emit BudgetAttesterSet(who);
    }

    /// @param revenueAnchor USDC-marked realized positive edge for the epoch, signed-reported
    ///        by budgetAttester (EIP-191 personal sign over (epochId, revenueAnchor)).
    function postEpoch(
        uint256 epochId,
        bytes32 root,
        uint256 totalMint,
        uint256 revenueAnchor,
        bytes calldata budgetSig
    ) external onlyOwner {
        require(epochId == lastEpoch + 1, "epoch order");
        require(epochs[epochId].root == bytes32(0), "posted");
        // revenue anchor must be attested: keccak("\x19Ethereum Signed Message:\n32" || hash)
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32",
                        keccak256(abi.encode(epochId, revenueAnchor))));
        require(_rec(h, budgetSig) == budgetAttester, "bad budget sig");
        uint256 budget = revenueAnchor * BUDGET_BPS / BPS;
        require(totalMint <= budget, "over budget"); // the whole point (KV-04 / M-05)
        epochs[epochId] = Epoch(root, totalMint, uint64(block.timestamp));
        lastEpoch = epochId;
        emit EpochPosted(epochId, root, totalMint, budget);
    }

    function claim(uint256 epochId, uint256 amount, bytes32[] calldata proof) external {
        Epoch storage e = epochs[epochId];
        require(e.root != bytes32(0), "no epoch");
        require(block.timestamp <= e.postedAt + MAX_EPOCH_GAP, "claim window closed");
        require(!claimed[epochId][msg.sender], "claimed");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, msg.sender, amount))));
        require(_verify(leaf, e.root, proof), "bad proof");
        claimed[epochId][msg.sender] = true;
        totalMinted += amount;
        edge.mint(msg.sender, amount);
        emit Claimed(epochId, msg.sender, amount);
    }

    // ---- merkle verification (OZ-style, sorted pairs) ----
    function _verify(bytes32 leaf, bytes32 root, bytes32[] calldata proof) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    function _rec(bytes32 digest, bytes calldata sig) internal pure returns (address) {
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

    function transferOwnership(address n) external onlyOwner { require(n != address(0), "zero"); owner = n; }
}
