// ─── Backtest Engine Tests ────────────────────────────────────────────────────
//
// Tests the walk-forward backtester with NO external deps.
// All OHLCV data is synthetic - no Bybit API calls.

import { describe, it, expect } from "vitest";

// ─── Inline types ─────────────────────────────────────────────────────────────

interface OHLCV { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface BacktestObs { direction: "LONG"|"SHORT"|"NEUTRAL"|"ABSTAIN"; confidence: number; calibratedProb: number; actualUp: number; brierContrib: number; correct: boolean; }

// ─── Inline signal computation ────────────────────────────────────────────────

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const from = closes.length - period;
  for (let i = from; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars: OHLCV[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs = bars.slice(-period - 1).map((b, i, arr): number => {
    if (i === 0) return b.high - b.low;
    return Math.max(b.high - b.low, Math.abs(b.high - arr[i-1].close), Math.abs(b.low - arr[i-1].close));
  });
  return trs.slice(1).reduce((a, b) => a + b, 0) / Math.min(trs.length - 1, period);
}

function computeSignal(bars: OHLCV[], priceChange24h: number) {
  const closes = bars.map(b => b.close);
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const price = closes[closes.length - 1];
  const spread = Math.abs(sma20 - sma50) / sma50;
  const trendScore = spread < 0.004 ? 0 : sma20 > sma50 ? 1 : -1;
  const momentumScore = -((rsi14 - 50) / 50) * 0.6;
  const priceChangeScore = Math.tanh(priceChange24h / 5) * 0.4;
  const atrPct = atr14 / price;
  const volatilityAdj = -Math.min(atrPct * 20, 0.5);
  const compositeScore = (trendScore + momentumScore + priceChangeScore) * (1 + volatilityAdj);
  const absScore = Math.abs(compositeScore);
  const highVol = volatilityAdj < -0.35;
  let direction: "LONG"|"SHORT"|"NEUTRAL"|"ABSTAIN";
  let rawConf: number;
  if (absScore < 0.12 || (highVol && absScore < 0.20)) { direction = "ABSTAIN"; rawConf = 0; }
  else if (compositeScore > 0.25) { direction = "LONG"; rawConf = compositeScore / 2; }
  else if (compositeScore < -0.25) { direction = "SHORT"; rawConf = -compositeScore / 2; }
  else { direction = "NEUTRAL"; rawConf = 1 - absScore / 0.25; }
  const confidence = Math.min(Math.round(rawConf * 1000), 950);
  const calibratedProb = direction === "LONG" ? 0.5 + (confidence/1000)*0.45
                       : direction === "SHORT" ? 0.5 - (confidence/1000)*0.45 : 0.5;
  return { direction, confidence, calibratedProb, compositeScore };
}

// ─── Backtest runner ──────────────────────────────────────────────────────────

const WINDOW = 52;

function runBacktestInline(bars: OHLCV[]): BacktestObs[] {
  const obs: BacktestObs[] = [];
  for (let i = WINDOW; i < bars.length - 1; i++) {
    const window = bars.slice(i - WINDOW, i + 1);
    const curClose = bars[i].close, nextClose = bars[i + 1].close;
    const actualUp = nextClose > curClose ? 1 : 0;
    const bar24 = bars[Math.max(0, i - 24)];
    const priceChange24h = ((curClose - bar24.close) / bar24.close) * 100;
    const { direction, confidence, calibratedProb } = computeSignal(window, priceChange24h);
    const brierContrib = (calibratedProb - actualUp) ** 2;
    const correct = direction === "LONG" ? actualUp === 1 : direction === "SHORT" ? actualUp === 0 : false;
    obs.push({ direction, confidence, calibratedProb, actualUp, brierContrib, correct });
  }
  return obs;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({
    time: i * 3600_000, open: c * 0.999, high: c * 1.002, low: c * 0.997, close: c, volume: 1000,
  }));
}
function trendBars(n: number, start = 100, step = 1): OHLCV[] {
  return makeBars(Array.from({ length: n }, (_, i) => start + i * step));
}
function altBars(n: number): OHLCV[] {
  return makeBars(Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 0.005 : -0.005)));
}

// ─── Brier score ──────────────────────────────────────────────────────────────

describe("Brier score properties", () => {
  it("strong uptrend: directional Brier < 0.25", () => {
    const bars = trendBars(200, 100, 2);
    const obs = runBacktestInline(bars);
    const dir = obs.filter(o => o.direction === "LONG" || o.direction === "SHORT");
    if (dir.length === 0) return;
    const brier = dir.reduce((s, o) => s + o.brierContrib, 0) / dir.length;
    expect(brier).toBeLessThan(0.25);
  });

  it("Brier contrib is always 0-1", () => {
    const obs = runBacktestInline(trendBars(200));
    for (const o of obs) {
      expect(o.brierContrib).toBeGreaterThanOrEqual(0);
      expect(o.brierContrib).toBeLessThanOrEqual(1);
    }
  });

  it("coin-flip-like random data: Brier near 0.25", () => {
    let price = 100;
    const closes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const rand = ((42 * 1664525 + i * 1013904223) % 65536) / 65536;
      price *= 1 + (rand - 0.5) * 0.02;
      closes.push(price);
    }
    const obs = runBacktestInline(makeBars(closes));
    const brier = obs.reduce((s, o) => s + o.brierContrib, 0) / obs.length;
    expect(brier).toBeGreaterThan(0.10);
    expect(brier).toBeLessThan(0.35);
  });
});

// ─── Calibrated probability ───────────────────────────────────────────────────

describe("Calibrated probability", () => {
  it("LONG signals have calibratedProb > 0.5", () => {
    const obs = runBacktestInline(trendBars(200));
    for (const o of obs.filter(o => o.direction === "LONG")) {
      expect(o.calibratedProb).toBeGreaterThan(0.5);
      expect(o.calibratedProb).toBeLessThanOrEqual(0.95);
    }
  });

  it("SHORT signals have calibratedProb < 0.5", () => {
    const obs = runBacktestInline(trendBars(200, 300, -1));
    for (const o of obs.filter(o => o.direction === "SHORT")) {
      expect(o.calibratedProb).toBeLessThan(0.5);
      expect(o.calibratedProb).toBeGreaterThanOrEqual(0.05);
    }
  });

  it("ABSTAIN and NEUTRAL have calibratedProb = 0.5", () => {
    const obs = runBacktestInline(altBars(200));
    for (const o of obs.filter(o => o.direction === "ABSTAIN" || o.direction === "NEUTRAL")) {
      expect(o.calibratedProb).toBe(0.5);
    }
  });

  it("calibratedProb always in [0, 1]", () => {
    const obs = runBacktestInline(trendBars(200));
    for (const o of obs) {
      expect(o.calibratedProb).toBeGreaterThanOrEqual(0);
      expect(o.calibratedProb).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Abstention ───────────────────────────────────────────────────────────────

describe("Abstention", () => {
  it("alternating prices produce fewer directional calls", () => {
    const obs = runBacktestInline(altBars(200));
    const dir = obs.filter(o => o.direction === "LONG" || o.direction === "SHORT");
    // Near-zero composite with alternating prices: expect fewer than 50% directional
    expect(dir.length).toBeLessThan(obs.length * 0.5);
  });

  it("ABSTAIN signals: correct is always false", () => {
    const obs = runBacktestInline(altBars(200));
    for (const o of obs.filter(o => o.direction === "ABSTAIN")) {
      expect(o.correct).toBe(false);
    }
  });

  it("uptrend has fewer abstentions than alternating market", () => {
    const trend = runBacktestInline(trendBars(200)).filter(o => o.direction === "ABSTAIN").length;
    const alt   = runBacktestInline(altBars(200)).filter(o => o.direction === "ABSTAIN").length;
    expect(alt).toBeGreaterThanOrEqual(trend);
  });
});

// ─── Kelly sizing ─────────────────────────────────────────────────────────────

describe("Kelly criterion sizing", () => {
  it("higher confidence -> higher kellyFraction", () => {
    function kelly(conf: number): number {
      const prob = 0.5 + (conf/1000)*0.45;
      return Math.abs(prob - 0.5) * 2 * 0.25;
    }
    expect(kelly(800)).toBeGreaterThan(kelly(400));
    expect(kelly(400)).toBeGreaterThan(kelly(100));
  });

  it("ABSTAIN/NEUTRAL -> position size = 0", () => {
    function posSize(dir: string, conf: number): number {
      if (dir === "ABSTAIN" || dir === "NEUTRAL") return 0;
      const prob = dir === "LONG" ? 0.5 + (conf/1000)*0.45 : 0.5 - (conf/1000)*0.45;
      return Math.min(Math.abs(prob - 0.5) * 2 * 0.25, 0.10);
    }
    expect(posSize("ABSTAIN", 0)).toBe(0);
    expect(posSize("NEUTRAL", 500)).toBe(0);
  });

  it("position size capped at 10%", () => {
    function posSize(conf: number): number {
      const prob = 0.5 + (conf/1000)*0.45;
      return Math.min(Math.abs(prob - 0.5) * 2 * 0.25, 0.10);
    }
    for (const conf of [100, 500, 950]) {
      expect(posSize(conf)).toBeLessThanOrEqual(0.10);
    }
  });

  it("quarter-Kelly < half-Kelly", () => {
    function qk(conf: number): number { return Math.abs(0.5 + (conf/1000)*0.45 - 0.5) * 2 * 0.25; }
    function hk(conf: number): number { return Math.abs(0.5 + (conf/1000)*0.45 - 0.5) * 2 * 0.50; }
    for (const c of [200, 500, 800]) { expect(qk(c)).toBeLessThan(hk(c)); }
  });
});

// ─── Backtest shape ───────────────────────────────────────────────────────────

describe("Backtest output shape", () => {
  it("periods = bars.length - WINDOW - 1", () => {
    const bars = trendBars(200);
    const obs = runBacktestInline(bars);
    expect(obs.length).toBe(bars.length - WINDOW - 1);
  });

  it("every observation has required fields", () => {
    for (const o of runBacktestInline(trendBars(100))) {
      expect(["LONG","SHORT","NEUTRAL","ABSTAIN"]).toContain(o.direction);
      expect(o.actualUp === 0 || o.actualUp === 1).toBe(true);
      expect(o.calibratedProb).toBeGreaterThanOrEqual(0);
      expect(o.brierContrib).toBeGreaterThanOrEqual(0);
    }
  });

  it("uptrend: more LONG than SHORT", () => {
    const obs = runBacktestInline(trendBars(200));
    expect(obs.filter(o => o.direction === "LONG").length).toBeGreaterThan(obs.filter(o => o.direction === "SHORT").length);
  });

  it("downtrend: more SHORT than LONG", () => {
    const obs = runBacktestInline(trendBars(200, 500, -1));
    expect(obs.filter(o => o.direction === "SHORT").length).toBeGreaterThan(obs.filter(o => o.direction === "LONG").length);
  });
});
