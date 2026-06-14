/**
 * Walk-forward backtester for MantleQuant signal engine.
 *
 * Uses the SAME indicator logic as the live agent — no look-ahead, no fitting.
 * For each window of historical hourly candles:
 *   1. Compute composite signal exactly as the live engine would
 *   2. Record predicted direction + calibrated probability
 *   3. Check actual outcome (did price rise in the next bar?)
 *   4. Compute Brier score + directional accuracy out-of-sample
 *
 * Brier score < 0.25 = better than a coin-flip (coin-flip = 0.25).
 * The best calibrated models sit around 0.22–0.24 on real market data.
 */

import { fetchKlines }    from "../tools/prices.js";
import { computeSMA, computeRSI, computeATR } from "../tools/indicators.js";
import type { OHLCV } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BacktestObs {
  windowEnd:       number;   // unix ms of the last candle in the window
  direction:       "LONG" | "SHORT" | "NEUTRAL" | "ABSTAIN";
  confidence:      number;   // 0–1000
  calibratedProb:  number;   // P(up) 0–1
  actualUp:        number;   // 1 = price rose next bar, 0 = fell
  brierContrib:    number;   // (prob - outcome)^2
  correct:         boolean;  // directional accuracy (skip for ABSTAIN/NEUTRAL)
}

export interface BacktestResult {
  symbol:       string;
  periods:      number;      // total observations
  active:       number;      // LONG + SHORT (directional signals)
  abstained:    number;      // ABSTAIN signals (model declined to trade)
  neutrals:     number;      // NEUTRAL signals
  brierScore:   number;      // mean (prob - outcome)^2 on all observations
  accuracy:     number;      // directional accuracy on LONG+SHORT signals (0–1)
  edge:         number;      // mean |prob - 0.5| × 2 (calibrated edge per trade)
  observations: BacktestObs[];
}

// ─── Signal computation (mirrors analyzer.ts exactly) ────────────────────────

const ABSTAIN_THRESHOLD = 0.12;  // |score| < 0.12 → ABSTAIN
const NEUTRAL_THRESHOLD = 0.25;  // |score| < 0.25 → NEUTRAL

function computeSignal(bars: OHLCV[], priceChange24h: number): {
  direction: "LONG" | "SHORT" | "NEUTRAL" | "ABSTAIN";
  confidence: number;
  calibratedProb: number;
  compositeScore: number;
} {
  const closes = bars.map(b => b.close);
  const sma20  = computeSMA(closes, 20);
  const sma50  = computeSMA(closes, 50);
  const rsi14  = computeRSI(closes, 14);
  const atr14  = computeATR(bars, 14);
  const price  = closes[closes.length - 1];

  // Factor 1: Trend (SMA20 vs SMA50)
  const spread     = Math.abs(sma20 - sma50) / sma50;
  const trendScore = spread < 0.004 ? 0.0 : sma20 > sma50 ? 1.0 : -1.0;

  // Factor 2: Momentum (RSI, contrarian)
  const normalizedRSI  = (rsi14 - 50) / 50;
  const momentumScore  = -normalizedRSI * 0.6;

  // Factor 3: 24h Price Change
  const priceChangeScore = Math.tanh(priceChange24h / 5) * 0.4;

  // Factor 4: Volatility adjustment
  const atrPct        = atr14 / price;
  const volatilityAdj = -Math.min(atrPct * 20, 0.5);

  // Composite score
  const rawScore      = trendScore + momentumScore + priceChangeScore;
  const compositeScore = rawScore * (1 + volatilityAdj);

  // Direction with ABSTAIN for very weak signals or extreme volatility
  const absScore = Math.abs(compositeScore);
  const highVol  = volatilityAdj < -0.35;

  let direction: "LONG" | "SHORT" | "NEUTRAL" | "ABSTAIN";
  let rawConfidence: number;

  if (absScore < ABSTAIN_THRESHOLD || (highVol && absScore < 0.20)) {
    direction    = "ABSTAIN";
    rawConfidence = 0;
  } else if (compositeScore > NEUTRAL_THRESHOLD) {
    direction    = "LONG";
    rawConfidence = compositeScore / 2.0;
  } else if (compositeScore < -NEUTRAL_THRESHOLD) {
    direction    = "SHORT";
    rawConfidence = -compositeScore / 2.0;
  } else {
    direction    = "NEUTRAL";
    rawConfidence = 1.0 - absScore / NEUTRAL_THRESHOLD;
  }

  const confidence = Math.min(Math.round(rawConfidence * 1000), 950);

  // Calibrated probability P(up): maps confidence + direction to 0–1
  let calibratedProb: number;
  if (direction === "LONG")    calibratedProb = 0.5 + (confidence / 1000) * 0.45;
  else if (direction === "SHORT") calibratedProb = 0.5 - (confidence / 1000) * 0.45;
  else if (direction === "ABSTAIN") calibratedProb = 0.5;
  else                            calibratedProb = 0.5; // NEUTRAL

  return { direction, confidence, calibratedProb, compositeScore };
}

// ─── Walk-forward runner ──────────────────────────────────────────────────────

const WINDOW_SIZE  = 52; // bars needed: 50 for SMA50 + 2 extra for ATR stability
const LOOK_FORWARD = 1;  // check price direction 1 bar ahead

/**
 * Run a walk-forward backtest for a symbol using recent hourly candles.
 *
 * @param symbol  e.g. "MNTUSDT"
 * @param limit   total candles to fetch (Bybit max 200)
 */
export async function runBacktest(
  symbol: string,
  limit = 200,
): Promise<BacktestResult> {
  const bars = await fetchKlines(symbol, "60", limit);

  if (bars.length < WINDOW_SIZE + LOOK_FORWARD + 1) {
    throw new Error(`Not enough data: got ${bars.length} bars, need ${WINDOW_SIZE + LOOK_FORWARD + 1}`);
  }

  const observations: BacktestObs[] = [];

  for (let i = WINDOW_SIZE; i < bars.length - LOOK_FORWARD; i++) {
    const window = bars.slice(i - WINDOW_SIZE, i + 1);
    const curClose  = bars[i].close;
    const nextClose = bars[i + LOOK_FORWARD].close;
    const actualUp  = nextClose > curClose ? 1 : 0;

    // Approximate 24h price change from the window
    const bar24hAgo = bars[Math.max(0, i - 24)];
    const priceChange24h = ((curClose - bar24hAgo.close) / bar24hAgo.close) * 100;

    const { direction, confidence, calibratedProb } = computeSignal(window, priceChange24h);
    const brierContrib = (calibratedProb - actualUp) ** 2;

    // Directional accuracy: skip NEUTRAL and ABSTAIN
    const correct =
      direction === "LONG"  ? actualUp === 1 :
      direction === "SHORT" ? actualUp === 0 :
      false; // NEUTRAL / ABSTAIN don't count toward accuracy

    observations.push({
      windowEnd:      bars[i].time,
      direction,
      confidence,
      calibratedProb,
      actualUp,
      brierContrib,
      correct,
    });
  }

  const n           = observations.length;
  const brierScore  = observations.reduce((s, o) => s + o.brierContrib, 0) / n;
  const directional = observations.filter(o => o.direction === "LONG" || o.direction === "SHORT");
  const accuracy    = directional.length > 0
    ? directional.filter(o => o.correct).length / directional.length
    : 0;
  const edge        = directional.length > 0
    ? directional.reduce((s, o) => s + Math.abs(o.calibratedProb - 0.5) * 2, 0) / directional.length
    : 0;

  return {
    symbol,
    periods:      n,
    active:       directional.length,
    abstained:    observations.filter(o => o.direction === "ABSTAIN").length,
    neutrals:     observations.filter(o => o.direction === "NEUTRAL").length,
    brierScore,
    accuracy,
    edge,
    observations,
  };
}

/** Run backtests on all three assets in parallel */
export async function runAllBacktests(
  symbols = ["BTCUSDT", "ETHUSDT", "MNTUSDT"],
): Promise<BacktestResult[]> {
  return Promise.all(symbols.map(s => runBacktest(s)));
}

/** Format a backtest result as a one-line summary string */
export function formatBacktestSummary(r: BacktestResult): string {
  return [
    `${r.symbol.replace("USDT", "")}`,
    `n=${r.periods}`,
    `Brier=${r.brierScore.toFixed(3)}`,
    `acc=${(r.accuracy * 100).toFixed(1)}%`,
    `active=${r.active}`,
    `abstained=${r.abstained}`,
    `edge=${(r.edge * 100).toFixed(1)}%`,
  ].join("  ");
}
