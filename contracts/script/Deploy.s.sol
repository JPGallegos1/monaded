// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TemplateMarketplace} from "../src/TemplateMarketplace.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Deploys TemplateMarketplace (and optionally MockUSDC) to Monad testnet.
/// Env:
///   MONAD_DEPLOYER_PRIVATE_KEY  required, deployer = admin
///   RELAYER_ADDRESS             optional, defaults to the deployer
///   ROYALTY_BPS                 optional, default 1000 (10% per ancestor level)
///   PLATFORM_FEE_BPS            optional, default 0
///   FEE_RECIPIENT               optional, defaults to the deployer
///   DEPLOY_MOCK_USDC            optional, default false
contract Deploy is Script {
    function run() external returns (TemplateMarketplace market, MockUSDC usdc) {
        uint256 pk = vm.envUint("MONAD_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address relayer = vm.envOr("RELAYER_ADDRESS", deployer);
        uint256 royaltyBps = vm.envOr("ROYALTY_BPS", uint256(1_000));
        uint256 feeBps = vm.envOr("PLATFORM_FEE_BPS", uint256(0));
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        bool deployMock = vm.envOr("DEPLOY_MOCK_USDC", false);

        vm.startBroadcast(pk);
        market = new TemplateMarketplace(deployer, relayer, royaltyBps, feeBps, feeRecipient);
        if (deployMock) {
            usdc = new MockUSDC();
            market.setAcceptedToken(address(usdc), true);
        }
        vm.stopBroadcast();

        console.log("TemplateMarketplace:", address(market));
        console.log("MockUSDC:", address(usdc));
        console.log("admin/deployer:", deployer);
        console.log("relayer:", relayer);
    }
}
