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
import { enrichSignal }      from "../llm/prompts.js";
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
  // ABSTAIN when signal is too weak or volatility is extreme.
  // NEUTRAL for mid-range signals. LONG/SHORT for directional calls.
  const ABSTAIN_THRESHOLD = 0.12;
  const NEUTRAL_THRESHOLD = 0.25;
  const absScore  = Math.abs(compositeScore);
  const highVol   = volatilityAdj < -0.35;

  let direction: Direction;
  let rawConfidence: number;

  if (absScore < ABSTAIN_THRESHOLD || (highVol && absScore < 0.20)) {
    direction    = "ABSTAIN";   // no trade — signal too weak or too noisy
    rawConfidence = 0;
  } else if (compositeScore > NEUTRAL_THRESHOLD) {
    direction    = "LONG";
    rawConfidence = compositeScore / 2.0; // normalise to 0–1
  } else if (compositeScore < -NEUTRAL_THRESHOLD) {
    direction    = "SHORT";
    rawConfidence = -compositeScore / 2.0;
  } else {
    direction    = "NEUTRAL";
    rawConfidence = 1.0 - absScore / NEUTRAL_THRESHOLD;
  }

  // Map to 0–1000 integer scale, cap at 950 (never 100 % confident)
  const confidence = Math.min(Math.round(rawConfidence * 1000), 950);

  // ── Calibrated probability P(up) ─────────────────────────────────────
  // Maps direction + confidence to a 0–1 probability estimate.
  // LONG → 0.50–0.95; SHORT → 0.05–0.50; otherwise 0.50
  const calibratedProb =
    direction === "LONG"  ? 0.5 + (confidence / 1000) * 0.45 :
    direction === "SHORT" ? 0.5 - (confidence / 1000) * 0.45 :
    0.5;

  // ── Kelly sizing ──────────────────────────────────────────────────────
  // Quarter-Kelly position sizing based on calibrated edge.
  // edge = 2 × |P(up) - 0.5|; at 1:1 odds, full Kelly = edge.
  // Quarter-Kelly halves expected drawdown vs half-Kelly.
  const kellyEdge    = Math.abs(calibratedProb - 0.5) * 2;
  const kellyFraction = kellyEdge * 0.25;               // quarter-Kelly
  const positionSize  = (direction === "ABSTAIN" || direction === "NEUTRAL")
    ? 0
    : Math.min(kellyFraction, 0.10);                     // cap at 10% per trade

  // ── Reasoning Text ───────────────────────────────────────────────────
  const reasoning = [
    `trend=${indicators.trend}(sma20=${indicators.sma20.toFixed(2)},sma50=${indicators.sma50.toFixed(2)})`,
    `rsi14=${indicators.rsi14.toFixed(1)}${indicators.overbought ? "[OB]" : indicators.oversold ? "[OS]" : ""}`,
    `atr14=${indicators.atr14.toFixed(4)}(${(atrPct * 100).toFixed(2)}%