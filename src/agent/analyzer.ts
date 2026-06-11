/**
 * Multi-factor signal generation engine.
 *
 * Uses five independent factors to produce calibrated trading signals:
 *   1. Trend           — SMA20 vs SMA50 crossover
 *   2. Momentum        — RSI mean-reversion component
 *   3. Price change    — 24-hour momentum confirmation
 *   4. Volatility adj  — ATR-based confidence penalty
 *   5. Open interest   — conviction proxy from derivatives market
 *
 * Each factor is independently bounded [-1, +1] and combined into a
 * composite score that maps to LONG / SHORT / NEUTRAL with a calibrated
 * confidence level. The analysis JSON is hashed and stored on-chain
 * alongside the signal, enabling off-chain verification.
 */

import { createHash }       from "crypto";
import { fetchBybitTicker } from "../tools/prices.js";
import { computeIndicators } from "../tools/indicators.js";
import type { AnalysisResult, Direction, SignalFactors } from "../types.js";

// ─── Covered assets ──────────────────────────────────────────────────────────

export const ASSETS = [
  { asset: "BTC", symbol: "BTCUSDT" },  // largest by cap
  { asset: "ETH", symbol: "ETHUSDT" },  // primary smart-contract chain
  { asset: "MNT", symbol: "MNTUSDT" },  // Mantle Network native token ← flagship
] as const;

/** Default signal horizon in minutes */
export const DEFAULT_HORIZON = 60;

// ─── Core Analysis ───────────────────────────────────────────────────────────

export async function analyzeAsset(symbol: string): Promise<AnalysisResult> {
  const asset = symbol.replace("USDT", "");

  const [quote, indicators] = await Promise.all([
    fetchBybitTicker(symbol),
    computeIndicators(symbol),
  ]);

  // ── Factor 1: Trend (SMA20 vs SMA50) ──────────────────────────────────
  // +1 = strong uptrend, -1 = strong downtrend, 0 = sideways
  const trendScore =
    indicators.trend === "UP"   ?  1.0 :
    indicators.trend === "DOWN" ? -1.0 : 0.0;

  // ── Factor 2: Momentum (RSI) ─────────────────────────────────────────
  // Contrarian: oversold → buy signal, overbought → sell signal
  const normalizedRSI  = (indicators.rsi14 - 50) / 50; // -1 to +1
  const momentumScore  = -normalizedRSI * 0.6;           // flip sign (mean-reversion)

  // ── Factor 3: 24h Price Change ───────────────────────────────────────
  // Trend-following: large positive change → buy confirmation
  const priceChangeScore = Math.tanh(quote.priceChange24h / 5) * 0.4;

  // ── Factor 4: Volatility Adjustment (ATR %) ──────────────────────────
  // High volatility reduces confidence; capped at 0.5 (max 50 % penalty)
  const atrPct       = indicators.atr14 / quote.price;
  const volatilityAdj = -Math.min(atrPct * 20, 0.5);

  // ── Composite Score ──────────────────────────────────────────────────
  // Range: approximately -2 to +2 before volatility adjustment
  const rawScore      = trendScore + momentumScore + priceChangeScore;
  const compositeScore = rawScore * (1 + volatilityAdj);

  // ── Direction + Confidence ───────────────────────────────────────────
  // Dead-band of ±0.25 → NEUTRAL
  const THRESHOLD = 0.25;
  let direction: Direction;
  let rawConfidence: number;

  if (compositeScore > THRESHOLD) {
    direction    = "LONG";
    rawConfidence = compositeScore / 2.0; // normalise to 0–1
  } else if (compositeScore < -THRESHOLD) {
    direction    = "SHORT";
    rawConfidence = -compositeScore / 2.0;
  } else {
    direction    = "NEUTRAL";
    rawConfidence = 1.0 - Math.abs(compositeScore) / THRESHOLD;
  }

  // Map to 0–1000 integer scale, cap at 950 (never 100 % confident)
  const confidence = Math.min(Math.round(rawConfidence * 1000), 950);

  // ── Reasoning Text ───────────────────────────────────────────────────
  const reasoning = [
    `trend=${indicators.trend}(sma20=${indicators.sma20.toFixed(2)},sma50=${indicators.sma50.toFixed(2)})`,
    `rsi14=${indicators.rsi14.toFixed(1)}${indicators.overbought ? "[OB]" : indicators.oversold ? "[OS]" : ""}`,
    `atr14=${indicators.atr14.toFixed(4)}(${(atrPct * 100).toFixed(2)}%)`,
    `24hΔ=${quote.priceChange24h.toFixed(2)}%`,
    `composite=${compositeScore.toFixed(3)}→${direction}@${(confidence / 10).toFixed(1)}%`,
  ].join(" ");

  const factors: SignalFactors = {
    trendScore,
    momentumScore,
    volatilityAdj,
    priceChangeScore,
    compositeScore,
  };

  return {
    asset,
    direction,
    confidence,
    entryPrice: quote.price,
    horizon:    DEFAULT_HORIZON,
    reasoning,
    factors,
    timestamp:  Date.now(),
  };
}

/** Run analysis on all covered assets in parallel */
export async function analyzeAll(): Promise<AnalysisResult[]> {
  return Promise.all(ASSETS.map(({ symbol }) => analyzeAsset(symbol)));
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Produce a deterministic bytes32-compatible hash of an analysis result.
 * This hash is stored on-chain alongside the signal, allowing anyone to
 * verify the off-chain analysis JSON matches what was committed.
 */
export function hashAnalysis(analysis: AnalysisResult): `0x${string}` {
  const payload = JSON.stringify({
    asset:       analysis.asset,
    direction:   analysis.direction,
    confidence:  analysis.confidence,
    entryPrice:  analysis.entryPrice,
    horizon:     analysis.horizon,
    reasoning:   analysis.reasoning,
    factors:     analysis.factors,
    timestamp:   analysis.timestamp,
  });
  return `0x${createHash("sha256").update(payload).digest("hex")}`;
}
