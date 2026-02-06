// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/DarkPool.sol";

contract DeployDarkPool is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        DarkPool darkPool = new DarkPool();

        console.log("DarkPool deployed to:", address(darkPool));

        vm.stopBroadcast();
    }
}
