/**
 * MantleQuant Agent Daemon
 *
 * Runs the full agent loop:
 *   1. Analyze all covered assets (BTC, ETH, MNT)
 *   2. Write non-NEUTRAL signals to Mantle chain
 *   3. Attempt to resolve expired signals with current prices
 *   4. Sleep until next cycle
 *
 * Set INTERVAL_MS env var to override the default 1-hour cycle.
 */

import chalk       from "chalk";
import ora         from "ora";
import { analyzeAll }           from "./analyzer.js";
import { createOnChainWriter }  from "./onchain.js";
import { fetchBybitTicker }     from "../tools/prices.js";
import type { OnChainSignal, ChainConfig } from "../types.js";

const INTERVAL_MS = parseInt(process.env["INTERVAL_MS"] ?? "3600000", 10);

// In-memory store for pending signals (use a database in production)
const pendingSignals: OnChainSignal[] = [];

export async function runDaemon(config: ChainConfig): Promise<void> {
  const writer = await createOnChainWriter(config);
  const spinner = ora();

  console.log(chalk.bold.magenta("\n╔═══════════════════════════════════════╗"));
  console.log(chalk.bold.magenta("║    MantleQuant Agent  v1.0.0          ║"));
  console.log(chalk.bold.magenta("║    Verifiable AI Trading on Mantle    ║"));
  console.log(chalk.bold.magenta("╚═══════════════════════════════════════╝\n"));

  console.log(chalk.gray(`Agent address : ${writer.address}`));
  console.log(chalk.gray(`Registry      : ${config.signalRegistry}`));
  console.log(chalk.gray(`RPC           : ${config.rpcUrl}`));
  console.log(chalk.gray(`Cycle         : every ${INTERVAL_MS / 60000} minutes\n`));

  // Register agent identity NFT if not yet done
  await writer.ensureRegistered("MantleQuant-v1", "trading", "Multi-factor AI quant agent");

  // Main loop
  while (true) {
    await runCycle(writer, spinner);
    await sleep(INTERVAL_MS);
  }
}

async function runCycle(
  writer:  Awaited<ReturnType<typeof createOnChainWriter>>,
  spinner: ReturnType<typeof ora>,
): Promise<void> {
  const ts = new Date().toISOString();
  console.log(chalk.cyan(`\n[${ts}] ── Analysis Cycle ──────────────────────`));

  // 1. Analyze
  spinner.start("Fetching market data + computing indicators...");
  let analyses;
  try {
    analyses = await analyzeAll();
    spinner.succeed("Analysis complete");
  } catch (err) {
    spinner.fail(`Analysis failed: ${err}`);
    return;
  }

  // 2. Print + write signals
  for (const a of analyses) {
    const color =
      a.direction === "LONG"  ? chalk.green  :
      a.direction === "SHORT" ? chalk.red    : chalk.gray;

    console.log(
      color(`  ${a.asset.padEnd(4)} ${a.direction.padEnd(7)} `) +
      chalk.white(`${(a.confidence / 10).toFixed(1).padStart(5)}% confidence`) +
      chalk.gray(` @ $${a.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}`)
    );
    console.log(chalk.gray(`        ${a.reasoning}`));

    if (a.direction === "NEUTRAL") continue;

    spinner.start(`Writing ${a.asset} ${a.direction} signal to Mantle...`);
    try {
      const signal = await writer.writeSignal(a);
      pendingSignals.push(signal);
      spinner.succeed(
        `Signal #${signal.signalId} on-chain: ${signal.txHash.slice(0, 18)}...`
      );
    } catch (err) {
      spinner.fail(`Failed to write ${a.asset} signal: ${err}`);
    }
  }

  // 3. Attempt to resolve expired signals
  const now  = Date.now();
  const toResolve = pendingSignals.filter(
    s => now - s.analysis.timestamp >= s.analysis.horizon * 60_000
  );

  if (toResolve.length > 0) {
    console.log(chalk.yellow(`\n  Resolving ${toResolve.length} expired signal(s)...`));
    for (const s of toResolve) {
      try {
        const quote = await fetchBybitTicker(`${s.analysis.asset}USDT`);
        const txHash = await writer.resolveSignal(s.signalId, quote.price);
        console.log(
          chalk.blue(`  ✓ Resolved #${s.signalId} @ $${quote.price.toLocaleString()} — ${txHash.slice(0, 18)}...`)
        );
        // Remove from pending
        const idx = pendingSignals.indexOf(s);
        if (idx !== -1) pendingSignals.splice(idx, 1);
      } catch (err) {
        console.log(chalk.red(`  ✗ Could not resolve #${s.signalId}: ${err}`));
      }
    }
  }

  // 4. Print stats
  try {
    const stats = await writer.getStats();
    const balance = await writer.getBalance();
    console.log(chalk.gray(
      `\n  Stats: ${stats.total} signals | ` +
      `${stats.resolved} resolved | ` +
      `${(stats.accuracyBps / 100).toFixed(1)}% accuracy | ` +
      `${(stats.totalReturnBps / 100).toFixed(2)}% total return`
    ));
    console.log(chalk.gray(`  Balance: ${balance} MNT`));
  } catch { /* ignore stats errors */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
