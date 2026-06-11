/**
 * On-chain writer for MantleQuant signals.
 *
 * Wraps ethers.js v6 + the SignalRegistry ABI into a clean async interface.
 * The ABI is embedded here (no compilation artifact needed at runtime).
 */

import { ethers }            from "ethers";
import { hashAnalysis }      from "./analyzer.js";
import type { AnalysisResult, OnChainSignal, ChainConfig } from "../types.js";

// ─── Direction enum (mirrors Solidity) ───────────────────────────────────────

const DIRECTION_ENUM = { NEUTRAL: 0, LONG: 1, SHORT: 2 } as const;

// ─── Embedded ABI ────────────────────────────────────────────────────────────

const SIGNAL_REGISTRY_ABI = [
  // Write
  "function recordSignal(string asset, uint8 direction, uint16 confidence, uint128 entryPrice, uint32 horizon, bytes32 analysisHash) returns (uint256)",
  "function resolveSignal(uint256 id, uint128 exitPrice)",
  // Read
  "function signalCount() view returns (uint256)",
  "function signals(uint256) view returns (uint256 id, address agent, string asset, uint8 direction, uint16 confidence, uint128 entryPrice, uint32 horizon, uint48 timestamp, bytes32 analysisHash, uint128 exitPrice, bool resolved, int64 returnBps)",
  "function agentCorrect(address) view returns (uint256)",
  "function agentTotalReturnBps(address) view returns (int256)",
  "function getAgentSignals(address) view returns (uint256[])",
  "function getAgentStats(address) view returns (uint256 total, uint256 resolved, uint256 correct, int256 totalReturnBps, uint256 accuracyBps)",
  "function getSignals(uint256 from, uint256 count) view returns (tuple(uint256 id, address agent, string asset, uint8 direction, uint16 confidence, uint128 entryPrice, uint32 horizon, uint48 timestamp, bytes32 analysisHash, uint128 exitPrice, bool resolved, int64 returnBps)[])",
  // Events
  "event SignalRecorded(uint256 indexed id, address indexed agent, string asset, uint8 direction, uint16 confidence, uint128 entryPrice, bytes32 analysisHash)",
  "event SignalResolved(uint256 indexed id, uint128 exitPrice, int64 returnBps, bool correct)",
];

const AGENT_NFT_ABI = [
  "function register(string agentName, string agentType, string description) returns (uint256)",
  "function agentTokenId(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "event AgentRegistered(uint256 indexed tokenId, address indexed agent, string agentName, string agentType)",
];

// ─── Writer Factory ───────────────────────────────────────────────────────────

export interface AgentStats {
  total:          number;
  resolved:       number;
  correct:        number;
  totalReturnBps: number;
  accuracyBps:    number;
  address:        string;
}

export async function createOnChainWriter(config: ChainConfig) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer   = new ethers.Wallet(config.privateKey, provider);
  const registry = new ethers.Contract(config.signalRegistry, SIGNAL_REGISTRY_ABI, signer);

  const agentNFT = config.agentNFT
    ? new ethers.Contract(config.agentNFT, AGENT_NFT_ABI, signer)
    : null;

  // ── Agent NFT Registration ─────────────────────────────────────────────

  async function ensureRegistered(
    agentName:   string,
    agentType:   string,
    description: string,
  ): Promise<void> {
    if (!agentNFT) return;
    const tokenId = await agentNFT.agentTokenId(signer.address);
    if (tokenId === 0n) {
      console.log("  Registering agent identity NFT on Mantle...");
      const tx = await agentNFT.register(agentName, agentType, description);
      await tx.wait();
      console.log(`  ✓ Agent NFT minted: tx ${tx.hash}`);
    }
  }

  // ── Signal Writing ─────────────────────────────────────────────────────

  async function writeSignal(analysis: AnalysisResult): Promise<OnChainSignal> {
    if (analysis.direction === "NEUTRAL") {
      throw new Error("Refusing to write NEUTRAL signal to save gas");
    }

    const analysisHash  = hashAnalysis(analysis);
    const entryScaled   = BigInt(Math.round(analysis.entryPrice * 1e8));
    const directionEnum = DIRECTION_ENUM[analysis.direction];

    const tx = await registry.recordSignal(
      analysis.asset,
      directionEnum,
      analysis.confidence,
      entryScaled,
      analysis.horizon,
      analysisHash,
    );

    const receipt = await tx.wait();

    // Parse event to get signalId
    const iface    = new ethers.Interface(SIGNAL_REGISTRY_ABI);
    let signalId   = -1;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "SignalRecorded") {
          signalId = Number(parsed.args["id"]);
          break;
        }
      } catch { /* skip non-matching logs */ }
    }

    return {
      txHash:      tx.hash,
      signalId,
      analysis,
      blockNumber: receipt.blockNumber,
    };
  }

  // ── Signal Resolution ──────────────────────────────────────────────────

  async function resolveSignal(signalId: number, exitPrice: number): Promise<string> {
    const exitScaled = BigInt(Math.round(exitPrice * 1e8));
    const tx         = await registry.resolveSignal(signalId, exitScaled);
    await tx.wait();
    return tx.hash;
  }

  // ── Read Stats ─────────────────────────────────────────────────────────

  async function getStats(): Promise<AgentStats> {
    const stats = await registry.getAgentStats(signer.address);
    return {
      total:          Number(stats.total),
      resolved:       Number(stats.resolved),
      correct:        Number(stats.correct),
      totalReturnBps: Number(stats.totalReturnBps),
      accuracyBps:    Number(stats.accuracyBps),
      address:        signer.address,
    };
  }

  async function getBalance(): Promise<string> {
    const bal = await provider.getBalance(signer.address);
    return ethers.formatEther(bal);
  }

  return {
    ensureRegistered,
    writeSignal,
    resolveSignal,
    getStats,
    getBalance,
    address: signer.address,
    provider,
    registry,
  };
}
