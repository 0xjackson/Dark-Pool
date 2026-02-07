// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/interfaces/IYellowCustody.sol";

contract MockYellowCustody is IYellowCustody {
    mapping(address => mapping(address => uint256)) public deposits;

    function deposit(address account, address token, uint256 amount) external payable {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        deposits[account][token] += amount;
    }
}
