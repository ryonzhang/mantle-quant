#!/usr/bin/env node
/**
 * MantleQuant CLI
 *
 * Commands:
 *   analyze [symbol]   — run analysis in dry-run mode (no chain writes)
 *   demo               — demo mode: analyze all assets, pretty-print results
 *   backtest [symbol]  — walk-forward backtest with Brier score
 *   run                — start the live agent daemon (requires .env)
 */

import { program }    from "commander";
import chalk          from "chalk";
import { config }     from "dotenv";
import { ASSETS, analyzeAll, analyzeAsset } from "./agent/analyzer.js";
import { runDaemon }  from "./agent/daemon.js";
import { runBacktest, runAllBacktests } from "./backtest/runner.js";
import type { ChainConfig } from "./types.js";

config(); // load .env

// ─── Helper ──────────────────────────────────────────────────────────────────

function printAnalysis(results: Awaited<ReturnType<typeof analyzeAll>>) {
  console.log(chalk.bold("\n  Asset  Direction  Confidence  Entry Price  Reasoning"));
  console.log("  " + "─".repeat(95));

  for (const r of results) {
    const dirColor =
      r.direction === "LONG"  ? chalk.green.bold  :
      r.direction === "SHORT" ? chalk.red.bold    : chalk.gray.bold;

    const bar = "█".repeat(Math.round(r.confidence / 100));
    const pct = `${(r.confidence / 10).toFixed(1)}%`;

    console.log(
      `  ${chalk.white(r.asset.padEnd(6))} ` +
      `${dirColor(r.direction.padEnd(9))} ` +
      `${chalk.yellow(pct.padStart(6))} ${chalk.gray(bar.padEnd(10))}  ` +
      `${chalk.cyan(`$${r.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })}`.padEnd(12))}  ` +
      `${chalk.gray(r.reasoning)}`
    );
  }

  console.log();
}

// ─── Program ─────────────────────────────────────────────────────────────────

program
  .name("mantle-quant")
  .description("MantleQuant — Verifiable AI Trading Signals on Mantle Network")
  .version("3.0.0");

// ── analyze ──────────────────────────────────────────────────────────────────
program
  .command("analyze [symbol]")
  .description(`Analyze one or all assets. Symbols: ${ASSETS.map(a => a.symbol).join(", ")}`)
  .action(async (symbol?: string) => {
    console.log(chalk.bold.blue("\nMantleQuant Analysis (dry-run — no chain writes)\n"));

    try {
      const results = symbol
        ? [await analyzeAsset(symbol.toUpperCase().replace("/", "").endsWith("USDT")
            ? symbol.toUpperCase()
            : symbol.toUpperCase() + "USDT"
          )]
        : await analyzeAll();
      printAnalysis(results);
    } catch (err) {
      console.error(chalk.red("Analysis error:"), err);
      process.exit(1);
    }
  });

// ── demo ─────────────────────────────────────────────────────────────────────
program
  .command("demo")
  .description("Run a full analysis demo (no API key needed, no chain writes)")
  .action(async () => {
    console.log(chalk.bold.magenta("\n╔══════════════════════════════════════╗"));
    console.log(chalk.bold.magenta("║  MantleQuant  —  Signal Engine Demo  ║"));
    console.log(chalk.bold.magenta("╚══════════════════════════════════════╝"));
    console.log(chalk.gray("\n  Fetching live data from Bybit API..."));
    console.log(chalk.gray("  Computing SMA20, SMA50, RSI14, ATR14..."));
    console.log(chalk.gray("  Running multi-factor scoring engine...\n"));

    try {
      const results = await analyzeAll();
      printAnalysis(results);

      console.log(chalk.bold("  Signal Summary:"));
      for (const r of results) {
        const sign = r.direction === "LONG" ? "↑" : r.direction === "SHORT" ? "↓" : "→";
        const color =
          r.direction === "LONG"  ? chalk.green  :
          r.direction === "SHORT" ? chalk.red    : chalk.gray;
        console.log(color(`    ${sign} ${r.asset}: ${r.direction} @ ${(r.confidence/10).toFixed(1)}% confidence`));
      }

      console.log(chalk.gray("\n  In live mode (npm run agent), each non-NEUTRAL signal"));
      console.log(chalk.gray("  is written to Mantle chain via SignalRegistry.recordSignal()"));
      console.log(chalk.gray("  and can be verified at: https://explorer.sepolia.mantle.xyz\n"));
    } catch (err) {
      console.error(chalk.red("Demo error:"), err);
      process.exit(1);
    }
  });

// ── backtest ─────────────────────────────────────────────────────────────────
program
  .command("backtest [symbol]")
  .description("Run walk-forward backtest with Brier score (default: all assets)")
  .action(async (symbol?: string) => {
    console.log(chalk.bold.blue("\nMantleQuant Walk-Forward Backtest\n"));
    console.log(chalk.gray("  Fetching ~200 hourly candles from Bybit..."));
    console.log(chalk.gray("  Running out-of-sample signal evaluation..."));
    console.log(chalk.gray("  Computing Brier score + directional accuracy...\n"));

    try {
      const results = symbol
        ? [await runBacktest(symbol.toUpperCase().endsWith("USDT") ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`)]
        : await runAllBacktests();

      for (const r of results) {
        const brierColor = r.brierScore < 0.22 ? chalk.green : r.brierScore < 0.25 ? chalk.yellow : chalk.red;
        const edgeLabel  = r.brierScore < 0.25 ? chalk.green("✓ beats coin-flip baseline") : chalk.red("✗ no edge over coin-flip");

        console.log(chalk.bold(`  ${r.symbol.replace("USDT", "")}`));
        console.log(`    Brier Score : ${brierColor(r.brierScore.toFixed(4))}  ${edgeLabel}  ${chalk.gray("(baseline = 0.2500)")}`);
        console.log(`    Accuracy    : ${chalk.yellow((r.accuracy * 100).toFixed(1) + "%")}  on directional signals`);
        console.log(`    Signals     : ${r.periods} total  |  ${r.active} directional  |  ${r.abstained} abstained  |  ${r.neutrals} neutral`);
        console.log(`    Edge        : ${chalk.cyan((r.edge * 100).toFixed(2) + "%")}  avg calibrated edge per trade`);
        console.log();
      }

      // Summary
      const avgBrier = results.reduce((s, r) => s + r.brierScore, 0) / results.length;
      const avgAcc   = results.reduce((s, r) => s + r.accuracy,   0) / results.length;
      const bColor   = avgBrier < 0.25 ? chalk.green : chalk.red;

      console.log("  " + "─".repeat(55));
      console.log(chalk.bold("  SUMMARY"));
      console.log(`    Avg Brier Score : ${bColor(avgBrier.toFixed(4))}  ${avgBrier < 0.25 ? chalk.green("✓ edge confirmed") : chalk.red("✗ no edge")}`);
      console.log(`    Avg Accuracy    : ${chalk.yellow((avgAcc * 100).toFixed(1) + "%")}`);
      console.log(chalk.gray("\n  Walk-forward methodology: 200 bars, WINDOW=52, strictly out-of-sample.\n"));

    } catch (err) {
      console.error(chalk.red("Backtest error:"), err);
      process.exit(1);
    }
  });

// ── run (live agent daemon) ───────────────────────────────────────────────────
program
  .command("run")
  .description("Start the live agent daemon — writes signals to Mantle chain every hour")
  .action(async () => {
    const registryAddr = process.env.SIGNAL_REGISTRY_ADDRESS;
    const nftAddr      = process.env.AGENT_NFT_ADDRESS;
    const privateKey   = process.env.PRIVATE_KEY;
    const rpcUrl       = process.env.MANTLE_TESTNET_RPC ?? "https://rpc.sepolia.mantle.xyz";

    if (!registryAddr || !nftAddr || !privateKey) {
      console.error(chalk.red("\nMissing required .env variables:"));
      if (!privateKey)   console.error(chalk.red("  PRIVATE_KEY"));
      if (!registryAddr) console.error(chalk.red("  SIGNAL_REGISTRY_ADDRESS"));
      if (!nftAddr)      console.error(chalk.red("  AGENT_NFT_ADDRESS"));
      console.error(chalk.gray("\nCopy .env.example to .env and fill in the values.\n"));
      process.exit(1);
    }

    const chain: ChainConfig = {
      rpcUrl,
      privateKey,
      signalRegistryAddress: registryAddr,
      agentNFTAddress:       nftAddr,
      intervalMs:            Number(process.env.INTERVAL_MS ?? 3_600_000),
    };

    console.log(chalk.bold.green("\nMantleQuant Live Agent\n"));
    console.log(chalk.gray(`  Network  : ${rpcUrl}`));
    console.log(chalk.gray(`  Registry : ${registryAddr}`));
    console.log(chalk.gray(`  NFT      : ${nftAddr}`));
    console.log(chalk.gray(`  Interval : ${chain.intervalMs / 60_000} min\n`));

    await runDaemon(chain);
  });

program.parse();
