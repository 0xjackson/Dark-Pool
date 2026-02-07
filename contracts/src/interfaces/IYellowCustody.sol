// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IYellowCustody {
    function deposit(address account, address token, uint256 amount) external payable;
}
