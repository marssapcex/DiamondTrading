// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title EDGE — loss-receipt token for RUNWAY
/// @notice Capped ERC20. Minting is restricted to a governance-set distributor.
///         The epoch net-loss computation + merkle distributor is phase-2 (see README);
///         this token deliberately contains NO mint logic beyond the cap so that no
///         accounting cursor of the house can influence supply (audit lesson H-01/M-05).
contract EdgeToken {
    string public constant name = "Runway EDGE";
    string public constant symbol = "EDGE";
    uint8 public constant decimals = 18;
    uint256 public constant CAP = 1_000_000_000e18;

    uint256 public totalSupply;
    address public owner;
    address public minter; // phase-2 distributor contract (budget-bounded)

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner_, address indexed spender, uint256 value);
    event MinterSet(address indexed minter);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() { owner = msg.sender; }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setMinter(address m) external onlyOwner {
        emit MinterSet(m);
        minter = m;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        require(totalSupply + amount <= CAP, "cap");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
