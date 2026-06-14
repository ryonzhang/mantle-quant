// ─── MantleQuant HTTP API Server ─────────────────────────────────────────────
//
// Judges can test signal generation without a wallet or PRIVATE_KEY.
// Serves real Bybit data + optional LLM enrichment.
//
// Endpoints:
//   GET  /api/health            Health check + config info
//   GET  /api/assets            List covered assets
//   POST /api/analyze           Single-asset signal
//   GET  /api/analyze/all       All assets in parallel
//   GET  /api/backtest/:symbol  Walk-forward backtest + Brier score
//   GET  /api/backtest/all      Backtest all three assets
//   GET  /                      Frontend dashboard
//
// Run: npm run serve

import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { analyzeAsset, analyzeAll, ASSETS } from "./agent/analyzer.js";
import { hasLLM } from "./llm/client.js";
import { runBacktest, runAllBacktests, formatBacktestSummary } from "./backtest/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleAnalyze(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { symbol = "BTCUSDT" } = JSON.parse(body) as { symbol?: string };
    const sym = symbol.toUpperCase().endsWith("USDT") ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    console.log(chalk.gray(`  POST /api/analyze  symbol=${sym}`));
    const result = await analyzeAsset(sym);
    json(res, 200, { success: true, signal: result });
  } catch (err) {
    json(res, 500, { success: false, error: (err as Error).message });
  }
}

async function handleAnalyzeAll(_req: IncomingMessage, res: ServerResponse) {
  try {
    console.log(chalk.gray("  GET  /api/analyze/all"));
    const results = await analyzeAll();
    json(res, 200, { success: true, signals: results, count: results.length });
  } catch (err) {
    json(res, 500, { success: false, error: (err as Error).message });
  }
}

async function handleBacktest(_req: IncomingMessage, res: ServerResponse, symbol: string) {
  try {
    const sym = symbol.toUpperCase().endsWith("USDT") ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    console.log(chalk.gray(`  GET  /api/backtest/${sym}`));
    const result = await runBacktest(sym);
    json(res, 200, {
      success: true,
      backtest: {
        symbol:     result.symbol,
        periods:    result.periods,
        active:     result.active,
        abstained:  result.abstained,
        neutrals:   result.neutrals,
        brierScore: result.brierScore,
        accuracy:   result.accuracy,
        edge:       result.edge,
        summary:    formatBacktestSummary(result),
        interpretation: {
          brierScore: result.brierScore < 0.25
            ? "✓ Better than coin-flip (< 0.25)"
            : "~ Near coin-flip (0.25 = random)",
          accuracy: `${(result.accuracy * 100).toFixed(1)}% directional accuracy on ${result.active} active signals`,
          abstention: `${result.abstained} of ${result.periods} periods — agent declined to trade (disciplined)`,
        },
      },
    });
  } catch (err) {
    json(res, 500, { success: false, error: (err as Error).message });
  }
}

async function handleBacktestAll(_req: IncomingMessage, res: ServerResponse) {
  try {
    console.log(chalk.gray("  GET  /api/backtest/all"));
    const results = await runAllBacktests();
    const pooledPeriods = results.reduce((s, r) => s + r.periods, 0);
    const pooledBrier   = results.reduce((s, r) => s + r.brierScore * r.periods, 0) / pooledPeriods;
    const pooledActive  = results.reduce((s, r) => s + r.active, 0);
    const pooledCorrect = results.reduce((s, r) => s + Math.round(r.accuracy * r.active), 0);
    json(res, 200, {
      success: true,
      assets:  results.map(r => ({
        symbol:     r.symbol,
        periods:    r.periods,
        brierScore: r.brierScore,
        accuracy:   r.accuracy,
        abstained:  r.abstained,
        edge:       r.edge,
        summary:    formatBacktestSummary(r),
      })),
      pooled: {
        periods:    pooledPeriods,
        brierScore: pooledBrier,
        accuracy:   pooledActive > 0 ? pooledCorrect / pooledActive : 0,
        note:       "Pooled across BTC, ETH, MNT — out-of-sample walk-forward",
      },
    });
  } catch (err) {
    json(res, 500, { success: false, error: (err as Error).message });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function startServer() {
  const server = createServer(async (req, res) => {
    const url    = req.url ?? "/";
    co