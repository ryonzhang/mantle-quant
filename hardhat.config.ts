import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Hardhat default (NOT for production)

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },

  networks: {
    // ── Local ──────────────────────────────────────────────────────
    hardhat: {},

    // ── Mantle Sepolia Testnet ─────────────────────────────────────
    mantleTestnet: {
      url:      process.env.MANTLE_TESTNET_RPC ?? "https://rpc.sepolia.mantle.xyz",
      chainId:  5003,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
    },

    // ── Mantle Mainnet ─────────────────────────────────────────────
    mantleMainnet: {
      url:      process.env.MANTLE_MAINNET_RPC ?? "https://rpc.mantle.xyz",
      chainId:  5000,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
    },
  },

  // ── Contract Verification ──────────────────────────────────────────
  etherscan: {
    apiKey: {
      mantleTestnet: process.env.MANTLE_EXPLORER_API_KEY ?? "placeholder",
      mantleMainnet: process.env.MANTLE_EXPLORER_API_KEY ?? "placeholder",
    },
    customChains: [
      {
        network:  "mantleTestnet",
        chainId:  5003,
        urls: {
          apiURL:     "https://api.routescan.io/v2/network/testnet/evm/5003/etherscan",
          browserURL: "https://explorer.sepolia.mantle.xyz",
        },
      },
      {
        network:  "mantleMainnet",
        chainId:  5000,
        urls: {
          apiURL:     "https://api.routescan.io/v2/network/mainnet/evm/5000/etherscan",
          browserURL: "https://explorer.mantle.xyz",
        },
      },
    ],
  },

  // ── Sourcify (no API key needed) ──────────────────────────────────
  sourcify: {
    enabled: true,
  },

  // ── Gas Reporter ───────────────────────────────────────────────────
  gasReporter: {
    enabled:  process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
};

export default config;
