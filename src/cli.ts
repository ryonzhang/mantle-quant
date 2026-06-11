#!/usr/bin/env node
/**
 * MantleQuant CLI
 *
 * Commands:
 *   analyze [symbol]   — run analysis in dry-run mode (no chain writes)
 *   demo               — demo mode: analyze all assets, pretty-print results
 *   run                — start the live agent daemon (requires .env)
 */

import { program }    from "commander";
import chalk          from "chalk";
import { config }     from "dotenv";
import { ASSETS, analyzeAll, analyzeAsset } from "./agent/analyzer.js";
import { runDaemon }  from "./agent/daemon.js";
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
  .version("1.0.0");

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

// ── run ──────────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Start the live agent daemon (writes signals to Mantle chain)")
  .action(async () => {
    const privateKey      = process.env["PRIVATE_KEY"];
    const signalRegistry  = process.env["SIGNAL_REGISTRY_ADDRESS"];
    const rpcUrl          = process.env["MANTLE_RPC_URL"] ?? "https://rpc.sepolia.mantle.xyz";

    if (!privateKey) {
      console.error(chalk.red("ERROR: PRIVATE_KEY not set in .env"));
      console.error(chalk.gray("  Copy .env.example → .env and fill in your values"));
      process.exit(1);
    }
    if (!signalRegistry) {
      console.error(chalk.red("ERROR: SIGNAL_REGISTRY_ADDRESS not set in .env"));
      console.error(chalk.gray("  Deploy first: npm run deploy:testnet"));
      process.exit(1);
    }

    const chainConfig: ChainConfig = {
      rpcUrl,
      privateKey,
      signalRegistry,
      agentNFT: process.env["AGENT_NFT_ADDRESS"],
    };

    await runDaemon(chainConfig);
  });

program.parse();
