/**
 * Multi-factor signal generation engine.
 */

import { createHash }        from "crypto";
import { fetchBybitTicker }  from "../tools/prices.js";
import { computeIndicators } from "../tools/indicators.js";
import type { AnalysisResult, Direction } from "../types.js";

export const ASSETS = [
  { asset: "BTC", symbol: "BTCUSDT" },
  { asset: "ETH", symbol: "ETHUSDT" },
  { asset: "MNT", symbol: "MNTUSDT" },
] as const;

export const DEFAULT_HORIZON = 60;

export async function analyzeAsset(symbol: string): Promise<AnalysisResult> {
  const asset = symbol.replace("USDT", "");

  const [quote, indicators] = await Promise.all([
    fetchBybitTicker(symbol),
    computeIndicators(symbol),
  ]);

  const trendScore      = indicators.trend === "UP" ? 1.0 : indicators.trend === "DOWN" ? -1.0 : 0.0;
  const normalizedRSI   = (indicators.rsi14 - 50) / 50;
  const momentumScore   = -normalizedRSI * 0.6;
  const priceChangeScore = Math.tanh(quote.priceChange24h / 5) * 0.4;
  const atrPct          = indicators.atr14 / quote.price;
  const volatilityAdj   = -Math.min(atrPct * 20, 0.5);
  const rawScore        = trendScore + momentumScore + priceChangeScore;
  const compositeScore  = rawScore * (1 + volatilityAdj);

  const ABSTAIN_THRESHOLD = 0.12;
  const NEUTRAL_THRESHOLD = 0.25;
  const absScore = Math.abs(compositeScore);
  const highVol  = volatilityAdj < -0.35;

  let direction: Direction;
  let rawConfidence: number;

  if (absScore < ABSTAIN_THRESHOLD || (highVol && absScore < 0.20)) {
    direction     = "ABSTAIN";
    rawConfidence = 0;
  } else if (compositeScore > NEUTRAL_THRESHOLD) {
    direction     = "LONG";
    rawConfidence = compositeScore / 2.0;
  } else if (compositeScore < -NEUTRAL_THRESHOLD) {
    direction     = "SHORT";
    rawConfidence = -compositeScore / 2.0;
  } else {
    direction     = "NEUTRAL";
    rawConfidence = 1.0 - absScore / NEUTRAL_THRESHOLD;
  }

  const confidence = Math.min(Math.round(rawConfidence * 1000), 950);

  const calibratedProb =
    direction === "LONG"  ? 0.5 + (confidence / 1000) * 0.45 :
    direction === "SHORT" ? 0.5 - (confidence / 1000) * 0.45 :
    0.5;

  const kellyEdge    = Math.abs(calibratedProb - 0.5) * 2;
  const kellyFraction = kellyEdge * 0.25;
  const positionSize  = (direction === "ABSTAIN" || direction === "NEUTRAL")
    ? 0
    : Math.min(kellyFraction, 0.10);

  const reasoning = [
    `trend=${indicators.trend}(sma20=${indicators.sma20.toFixed(2)},sma50=${indicators.sma50.toFixed(2)})`,
    `rsi14=${indicators.rsi14.toFixed(1)}${indicators.overbought ? "[OB]" : indicators.oversold ? "[OS]" : ""}`,
    `atr14=${indicators.atr14.toFixed(4)}(${(atrPct * 100).toFixed(2)}%)`,
    `score=${compositeScore.toFixed(3)}`,
    `kelly=${(positionSize * 100).toFixed(1)}%`,
  ].join(" | ");

  const analysisJson = JSON.stringify({
    asset, symbol, direction, confidence, compositeScore,
    factors: { trendScore, momentumScore, priceChangeScore, volatilityAdj },
    indicators: { sma20: indicators.sma20, sma50: indicators.sma50, rsi14: indicators.rsi14, atr14: indicators.atr14 },
    calibratedProb, positionSize,
    timestamp: Date.now(),
  });
  const analysisHash = "0x" + createHash("sha256").update(analysisJson).digest("hex");

  return {
    asset,
    symbol,
    direction,
    confidence,
    entryPrice: quote.price,
    horizon:    DEFAULT_HORIZON,
    compositeScore,
    factors: {
      trendScore,
      momentumScore,
      priceChangeScore,
      volatilityAdj,
      compositeScore,
    },
    calibratedProb,
    positionSize,
    reasoning,
    analysisHash,
    analysisJson,
  };
}

export async function analyzeAll(): Promise<AnalysisResult[]> {
  return Promise.all(ASSETS.map(a => analyzeAsset(a.symbol)));
}
