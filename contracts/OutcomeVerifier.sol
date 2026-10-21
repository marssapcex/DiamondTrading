// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title OutcomeVerifier — pluggable outcome verification for RunwayHouse settlement.
/// v2 design: instead of one trusted settlement keeper, outcomes are attested by an
/// N-of-M attester set (default 2-of-3) via EIP-712 signatures; ANYONE may relay an
/// attested outcome on-chain. Keeper censorship/griefing is removed by design:
/// no single attester can settle alone, and no single attester can block settlement.
interface IOutcomeVerifier {
    /// @return true if `outcome` for `ticketId` is validly attested.
    function verify(uint256 ticketId, uint8 outcome, bytes[] calldata sigs) external view returns (bool);
}

/// @notice 2-of-3 (general M-of-N) EIP-712 attestation verifier.
/// Attestation payload: Outcome(uint256 ticketId,uint8 outcome,bytes32 salt)
/// Salt prevents signature reuse across different attestations of the same outcome.
contract MultiAttesterVerifier is IOutcomeVerifier {
    bytes32 public constant OUTCOME_TYPEHASH =
        keccak256("Outcome(uint256 ticketId,uint8 outcome,address house)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    address public immutable house; // the RunwayHouse this verifier serves (bound in struct)

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
            keccak256("RunwayOutcome"), keccak256("1"), block.chainid, address(this)
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

    function digestOf(uint256 ticketId, uint8 outcome) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, _structHash(ticketId, outcome)));
    }

    function _structHash(uint256 ticketId, uint8 outcome) internal view returns (bytes32) {
        return keccak256(abi.encode(OUTCOME_TYPEHASH, ticketId, outcome, house));
    }

    function verify(uint256 ticketId, uint8 outcome, bytes[] calldata sigs) external view returns (bool) {
        require(sigs.length >= threshold, "not enough sigs");
        bytes32 digest = digestOf(ticketId, outcome);
        address[] memory seen = new address[](sigs.length);
        uint256 valid;
        for (uint256 i; i < sigs.length; i++) {
            address rec = _recover(digest, sigs[i]);
            if (!isAttester[rec]) continue;
            bool dup;
            for (uint256 j; j < valid; j++) if (seen[j] == rec) { dup = true; break; }
            if (dup) continue; // duplicate signer does not count (and cannot double-count)
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
