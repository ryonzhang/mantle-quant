/**
 * Technical indicators computed locally from Bybit OHLCV data.
 * All calculations are pure functions — no external dependencies.
 */

import { fetchKlines } from "./prices.js";
import type { OHLCV, Indicators } from "../types.js";

// ─── Pure Computation ────────────────────────────────────────────────────────

export function computeSMA(values: number[], period: number): number {
  if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gains  = 0;
  let losses = 0;
  const from = closes.length - period;

  for (let i = from; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }

  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeATR(bars: OHLCV[], period: number = 14): number {
  if (bars.length < 2) return 0;

  const trs = bars.slice(-period - 1).map((bar, i, arr): number => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = arr[i - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low  - prevClose),
    );
  });

  // Slice off the first element (no prev-close reference)
  return trs.slice(1).reduce((a, b) => a + b, 0) / Math.min(trs.length - 1, period);
}

// ─── Fetching + Bundle ───────────────────────────────────────────────────────

/**
 * Fetch klines from Bybit and return a full indicator bundle for a symbol.
 * Uses 60-minute candles by default (matches signal horizon).
 */
export async function computeIndicators(symbol: string): Promise<Indicators> {
  const bars   = await fetchKlines(symbol, "60", 60);
  const closes = bars.map(b => b.close);

  const sma20 = computeSMA(closes, 20);
  const sma50 = computeSMA(closes, 50);
  const rsi14 = computeRSI(closes, 14);
  const atr14 = computeATR(bars, 14);

  // Trend: SMA20 vs SMA50, with a deadband to avoid "SIDEWAYS" flip-flopping
  const spread = Math.abs(sma20 - sma50) / sma50;
  let trend: "UP" | "DOWN" | "SIDEWAYS";
  if (spread < 0.004)      trend = "SIDEWAYS";
  else if (sma20 > sma50)  trend = "UP";
  else                     trend = "DOWN";

  return {
    sma20,
    sma50,
    rsi14,
    atr14,
    trend,
    overbought: rsi14 > 70,
    oversold:   rsi14 < 30,
  };
}
