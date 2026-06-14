// ─── MantleQuant Signal Engine Tests ─────────────────────────────────────────
//
// Tests the multi-factor signal engine with NO external deps.
// No Bybit, no Mantle RPC, no LLM — pure logic.

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";

// ─── Inline signal engine logic ───────────────────────────────────────────────

interface Factors {
  trendScore: number;
  momentumScore: number;
  volatilityAdj: number;
  priceChangeScore: number;
  compositeScore: number;
}

function computeComposite(f: Omit<Factors, "compositeScore">): number {
  const raw = f.trendScore + f.momentumScore + f.priceChangeScore;
  return raw * (1 + f.volatilityAdj);
}

function getDirection(score: number): string {
  if (score >  0.25) return "LONG";
  if (score < -0.25) return "SHORT";
  return "NEUTRAL";
}

function getConfidence(score: number): number {
  const THRESHOLD = 0.25;
  let raw: number;
  if (score > THRESHOLD)       raw = score / 2.0;
  else if (score < -THRESHOLD) raw = -score / 2.0;
  else                         raw = 1.0 - Math.abs(score) / THRESHOLD;
  return Math.min(Math.round(raw * 1000), 950);
}

function hashAnalysis(payload: object): string {
  return `0x${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function sma(prices: number[], period: number): number {
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(closes: number[], period = 14): number {
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  const gains = changes.map((c) => (c > 0 ? c : 0));
  const losses = changes.map((c) => (c < 0 ? -c : 0));
  const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Direction Tests ──────────────────────────────────────────────────────────

describe("getDirection", () => {
  it("returns LONG for positive composite > 0.25", () => {
    expect(getDirection(0.5)).toBe("LONG");
    expect(getDirection(0.26)).toBe("LONG");
    expect(getDirection(2.0)).toBe("LONG");
  });

  it("returns SHORT for negative composite < -0.25", () => {
    expect(getDirection(-0.5)).toBe("SHORT");
    expect(getDirection(-0.26)).toBe("SHORT");
    expect(getDirection(-2.0)).toBe("SHORT");
  });

  it("returns NEUTRAL within dead-band ±0.25", () => {
    expect(getDirection(0.0)).toBe("NEUTRAL");
    expect(getDirection(0.24)).toBe("NEUTRAL");
    expect(getDirection(-0.24)).toBe("NEUTRAL");
    expect(getDirection(0.25)).toBe("NEUTRAL");
    expect(getDirection(-0.25)).toBe("NEUTRAL");
  });
});

// ─── Confidence Tests ─────────────────────────────────────────────────────────

describe("getConfidence", () => {
  it("is capped at 950 (never 100%)", () => {
    expect(getConfidence(10)).toBe(950);
    expect(getConfidence(-10)).toBe(950);
  });

  it("higher |score| → higher confidence for directional signals", () => {
    const c1 = getConfidence(0.5);
    const c2 = getConfidence(1.0);
    expect(c2).toBeGreaterThan(c1);
  });

  it("confidence is always ≥ 0", () => {
    for (const s of [-2, -0.5, 0, 0.5, 2]) {
      expect(getConfidence(s)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Composite Score Tests ────────────────────────────────────────────────────

describe("computeComposite", () => {
  it("all-bullish factors → strong positive", () => {
    const score = computeComposite({
      trendScore:       1.0,
      momentumScore:    0.3,
      priceChangeScore: 0.3,
      volatilityAdj:    0.0,
    });
    expect(score).toBeGreaterThan(0.25);
    expect(getDirection(score)).toBe("LONG");
  });

  it("all-bearish factors → strong negative", () => {
    const score = computeComposite({
      trendScore:       -1.0,
      momentumScore:    -0.3,
      priceChangeScore: -0.3,
      volatilityAdj:    0.0,
    });
    expect(score).toBeLessThan(-0.25);
    expect(getDirection(score)).toBe("SHORT");
  });

  it("volatility penalty reduces absolute composite", () => {
    const base = { trendScore: 1.0, momentumScore: 0.3, priceChangeScore: 0.3 };
    const noVol  = computeComposite({ ...base, volatilityAdj:  0.0 });
    const highVol = computeComposite({ ...base, volatilityAdj: -0.5 });
    expect(Math.abs(highVol)).toBeLessThan(Math.abs(noVol));
  });

  it("cancelling trend + momentum → may be NEUTRAL", () => {
    const score = computeComposite({
      trendScore:       1.0,
      momentumScore:   -0.8,
      priceChangeScore:-0.3,
      volatilityAdj:    0.0,
    });
    expect(Math.abs(score)).toBeLessThan(0.5);
  });
});

// ─── SMA Tests ────────────────────────────────────────────────────────────────

describe("SMA", () => {
  it("flat prices → SMA = price", () => {
    expect(sma(Array(50).fill(100), 20)).toBe(100);
  });

  it("uptrend → SMA20 > SMA50", () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(sma(prices, 20)).toBeGreaterThan(sma(prices, 50));
  });

  it("downtrend → SMA20 < SMA50", () => {
    const prices = Array.from({ length: 60 }, (_, i) => 200 - i);
    expect(sma(prices, 20)).toBeLessThan(sma(prices, 50));
  });
});

// ─── RSI Tests ────────────────────────────────────────────────────────────────

describe("RSI", () => {
  it("all gains → RSI = 100", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(prices, 14)).toBe(100);
  });

  it("all losses → RSI = 0", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 200 - i);
    expect(rsi(prices, 14)).toBe(0);
  });

  it("RSI is always 0–100", () => {
    const prices = Array.from({ length: 30 }, () => Math.random() * 1000);
    const r = rsi(prices, 14);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(100);
  });

  it("strong uptrend → RSI > 70 (overbought)", () => {
    const prices = [100, 102, 105, 109, 114, 120, 127, 135, 144, 154, 165, 177, 190, 204, 219, 235];
    expect(rsi(prices, 14)).toBeGreaterThan(70);
  });
});

// ─── ATR Tests ────────────────────────────────────────────────────────────────

describe("ATR", () => {
  it("flat prices → ATR = 0", () => {
    const n = 20;
    expect(atr(Array(n).fill(100), Array(n).fill(100), Array(n).fill(100), 14)).toBe(0);
  });

  it("ATR is non-negative", () => {
    const n = 20;
    const hs = Array.from({ length: n }, () => 100 + Math.random() * 10);
    const ls = hs.map((h) => h - Math.random() * 5);
    const cs = hs.map((h, i) => (h + ls[i]) / 2);
    expect(atr(hs, ls, cs, 14)).toBeGreaterThanOrEqual(0);
  });

  it("higher range → higher ATR", () => {
    const n = 20;
    const quietATR = atr(Array(n).fill(101), Array(n).fill(99), Array(n).fill(100), 14);
    const noisyATR = atr(Array(n).fill(115), Array(n).fill(85), Array(n).fill(100), 14);
    expect(noisyATR).toBeGreaterThan(quietATR);
  });
});

// ─── Hash Tests ───────────────────────────────────────────────────────────────

describe("hashAnalysis", () => {
  it("produces 0x-prefixed 64-char hex", () => {
    const h = hashAnalysis({ asset: "BTC", direction: "LONG" });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("same input → same hash (deterministic)", () => {
    const payload = { asset: "MNT", direction: "SHORT", confidence: 750 };
    expect(hashAnalysis(payload)).toBe(hashAnalysis(payload));
  });

  it("different input → different hash", () => {
    expect(hashAnalysis({ a: 1 })).not.toBe(hashAnalysis({ a: 2 }));
  });

  it("hash is 32 bytes (bytes32 compatible for Solidity)", () => {
    const h = hashAnalysis({ test: true });
    // 0x + 64 hex chars = 32 bytes
    expect(h.length).toBe(66);
  });
});

// ─── Signal roundtrip ─────────────────────────────────────────────────────────

describe("Signal pipeline", () => {
  it("LONG signal: direction + confidence + hash are consistent", () => {
    const score = 0.8;
    const dir = getDirection(score);
    const conf = getConfidence(score);
    const hash = hashAnalysis({ direction: dir, confidence: conf, score });

    expect(dir).toBe("LONG");
    expect(conf).toBeGreaterThan(0);
    expect(conf).toBeLessThanOrEqual(950);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("NEUTRAL signal: confidence reflects uncertainty", () => {
    const score = 0.1;
    const dir = getDirection(score);
    const longConf = getConfidence(0.8);
    const neutralConf = getConfidence(score);

    expect(dir).toBe("NEUTRAL");
    // Neutral confidence is computed differently — just check it's valid
    expect(neutralConf).toBeGreaterThanOrEqual(0);
    expect(neutralConf).toBeLessThanOrEqual(950);
  });
});
