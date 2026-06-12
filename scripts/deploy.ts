/**
 * Deployment script for MantleQuant contracts.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network mantleTestnet
 *   npx hardhat run scripts/deploy.ts --network mantleMainnet
 *
 * After deployment, update `deployed-addresses.json` with the output addresses.
 * Then verify on-chain:
 *   npx hardhat verify --network mantleTestnet <SignalRegistry_address>
 *   npx hardhat verify --network mantleTestnet <AgentNFT_address> <SignalRegistry_address>
 */

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("─".repeat(60));
  console.log("MantleQuant Deployment");
  console.log("─".repeat(60));
  console.log(`Network  : ${network.name}`);
  console.log(`Deployer : ${deployer.address}`);
  console.log(`Balance  : ${ethers.formatEther(balance)} MNT`);
  console.log("─".repeat(60));

  if (balance === 0n) {
    console.error("ERROR: Deployer has zero balance — get testnet MNT from the faucet first.");
    console.error("Faucet: https://faucet.sepolia.mantle.xyz");
    process.exit(1);
  }

  // 1. Deploy SignalRegistry
  console.log("\n[1/2] Deploying SignalRegistry...");
  const SignalRegistry = await ethers.getContractFactory("SignalRegistry");
  const signalRegistry = await SignalRegistry.deploy();
  await signalRegistry.waitForDeployment();
  const signalRegistryAddr = await signalRegistry.getAddress();
  console.log(`      ✓ SignalRegistry → ${signalRegistryAddr}`);

  // 2. Deploy AgentNFT (linked to SignalRegistry)
  console.log("\n[2/2] Deploying AgentNFT...");
  const AgentNFT = await ethers.getContractFactory("AgentNFT");
  const agentNFT = await AgentNFT.deploy(signalRegistryAddr);
  await agentNFT.waitForDeployment();
  const agentNFTAddr = await agentNFT.getAddress();
  console.log(`      ✓ AgentNFT → ${agentNFTAddr}`);

  // 3. Save addresses
  const addresses = {
    network:         network.name,
    chainId:         (await ethers.provider.getNetwork()).chainId.toString(),
    deployer:        deployer.address,
    signalRegistry:  signalRegistryAddr,
    agentNFT:        agentNFTAddr,
    deployedAt:      new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "..", "deployed-addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));

  console.log("\n" + "─".repeat(60));
  console.log("Deployment complete!");
  console.log("─".repeat(60));
  console.log(`SignalRegistry : ${signalRegistryAddr}`);
  console.log(`AgentNFT       : ${agentNFTAddr}`);
  console.log(`\nAddresses saved to deployed-addresses.json`);

  const explorer =
    network.name === "mantleMainnet"
      ? "https://explorer.mantle.xyz"
      : "https://explorer.sepolia.mantle.xyz";
  console.log(`\nVerify on explorer:`);
  console.log(`  ${explorer}/address/${signalRegistryAddr}`);
  console.log(`  ${explorer}/address/${agentNFTAddr}`);

  console.log("\nVerify on-chain (run after a few seconds):");
  console.log(`  npx hardhat verify --network ${network.name} ${signalRegistryAddr}`);
  console.log(`  npx hardhat verify --network ${network.name} ${agentNFTAddr} "${signalRegistryAddr}"`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
