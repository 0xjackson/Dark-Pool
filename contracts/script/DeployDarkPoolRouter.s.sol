// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script, console} from "forge-std/Script.sol";
import {DarkPoolRouter} from "../src/DarkPoolRouter.sol";

contract DeployDarkPoolRouter is Script {
    function run() public {
        address custodyAddress = vm.envAddress("YELLOW_CUSTODY_ADDRESS");
        address engineAddress = vm.envAddress("ENGINE_ADDRESS");
        address zkVerifierAddress = vm.envAddress("ZK_VERIFIER_ADDRESS");

        vm.startBroadcast();

        DarkPoolRouter router = new DarkPoolRouter(custodyAddress, engineAddress, zkVerifierAddress);

        vm.stopBroadcast();

        console.log("DarkPoolRouter deployed at:", address(router));
        console.log("Custody:", custodyAddress);
        console.log("Engine:", engineAddress);
        console.log("ZK Verifier:", zkVerifierAddress);
    }
}
