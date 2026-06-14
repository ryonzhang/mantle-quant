// ─── LLM Signal Enrichment ────────────────────────────────────────────────────
//
// Wraps the rule-based signal engine output with LLM-generated narrative,
// risk factors, price targets, and market regime classification.
// Falls back to rule-based text when no LLM key is set.

import { callLLM, hasLLM } from "./client.js";
import type { AnalysisResult } from "../types.js";

export interface LLMEnrichedSignal {
  narrative: string;           // 1-2 sentence market narrative
  keyDrivers: string[];        // top 3 factors driving the signal
  riskFactors: string[];       // top 2 risks to the thesis
  priceTarget: number | null;  // 4h price target (null if NEUTRAL)
  stopLoss: number | null;     // suggested stop loss level
  marketRegime: string;        // e.g. "trending", "mean-reverting", "volatile"
  llmEnriched: boolean;
}

export async function enrichSignal(
  analysis: AnalysisResult
): Promise<LLMEnrichedSignal> {
  const { asset, direction, confidence, entryPrice, factors, reasoning } = analysis;
  const confPct = (confidence / 10).toFixed(1);

  const fallback: LLMEnrichedSignal = {
    narrative: direction === "LONG"
      ? `${asset} shows bullish technical setup with ${confPct}% confidence. SMA crossover and momentum indicators align to the upside.`
      : direction === "SHORT"
      ? `${asset} exhibits bearish technical structure at ${confPct}% confidence. Trend and momentum indicators point downward.`
      : `${asset} presents mixed signals with no clear directional conviction. Neutral positioning recommended.`,
    keyDrivers: [
      factors.trendScore > 0 ? "Bullish SMA20/50 crossover" : factors.trendScore < 0 ? "Bearish SMA20/50 crossover" : "Flat trend",
      factors.momentumScore > 0 ? "Oversold RSI reversal opportunity" : "Overbought RSI — mean reversion risk",
      factors.priceChangeScore > 0 ? "Positive 24h price momentum" : "Negative 24h price momentum",
    ],
    riskFactors: [
      `High volatility (ATR adj: ${factors.volatilityAdj.toFixed(3)}) may invalidate signal`,
      "Macro risk events could override technical setup",
    ],
    priceTarget: direction === "LONG"
      ? Math.round(entryPrice * 1.03 * 100) / 100
      : direction === "SHORT"
      ? Math.round(entryPrice * 0.97 * 100) / 100
      : null,
    stopLoss: direction === "LONG"
      ? Math.round(entryPrice * 0.985 * 100) / 100
      : direction === "SHORT"
      ? Math.round(entryPrice * 1.015 * 100) / 100
      : null,
    marketRegime: Math.abs(factors.compositeScore) > 1.0 ? "trending" : Math.abs(factors.compositeScore) < 0.3 ? "choppy" : "mean-reverting",
    llmEnriched: false,
  };

  if (!hasLLM()) return fallback;

  const systemPrompt = `You are a quantitative analyst specializing in crypto markets.
Given a trading signal and its technical factors, produce a concise JSON analysis.
Be precise, professional, and focus on actionable insights.
Always respond with valid JSON matching the exact schema provided.`;

  const userPrompt = `Analyze this ${asset} trading signal:
Direction: ${direction} (${confPct}% confidence)
Entry Price: $${entryPrice.toLocaleString()}
Technical Factors:
  - Trend score: ${factors.trendScore} (SMA20/50 crossover)
  - Momentum score: ${factors.momentumScore} (RSI mean-reversion)
  - Price change score: ${factors.priceChangeScore} (24h momentum)
  - Volatility adjustment: ${factors.volatilityAdj}
  - Composite: ${factors.compositeScore.toFixed(3)}
Raw reasoning: ${reasoning}

Produce JSON with exactly these fields:
{
  "narrative": "1-2 sentence market narrative",
  "keyDrivers": ["driver1", "driver2", "driver3"],
  "riskFactors": ["risk1", "risk2"],
  "priceTarget": <number or null>,
  "stopLoss": <number or null>,
  "marketRegime": "trending|mean-reverting|choppy|volatile"
}`;

  const result = await callLLM<Omit<LLMEnrichedSignal, "llmEnriched">>(
    [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
    fallback
  );

  return { ...result, llmEnriched: true };
}
