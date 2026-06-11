/**
 * Price data from Bybit public REST API (no API key required).
 * Bybit is the primary sponsor of the AI Trading & Strategy track.
 */

import type { Quote, OHLCV } from "../types.js";

const BYBIT_BASE = "https://api.bybit.com";

/** Fetch a single perpetual futures ticker */
export async function fetchBybitTicker(symbol: string): Promise<Quote> {
  const url = `${BYBIT_BASE}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;

  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await res.json()) as {
    retCode: number;
    retMsg:  string;
    result:  { list: Record<string, string>[] };
  };

  if (data.retCode !== 0 || !data.result?.list?.[0]) {
    throw new Error(`Bybit API error for ${symbol}: ${data.retMsg}`);
  }

  const t = data.result.list[0];
  return {
    asset:           symbol.replace("USDT", ""),
    symbol,
    price:           parseFloat(t["lastPrice"]    ?? "0"),
    priceChange24h:  parseFloat(t["price24hPcnt"] ?? "0") * 100,
    volume24h:       parseFloat(t["volume24h"]    ?? "0"),
    openInterest:    parseFloat(t["openInterest"] ?? "0"),
  };
}

/** Fetch multiple tickers in parallel */
export async function fetchMultipleTickers(symbols: string[]): Promise<Quote[]> {
  return Promise.all(symbols.map(fetchBybitTicker));
}

/** Fetch OHLCV klines from Bybit */
export async function fetchKlines(
  symbol:   string,
  interval: "1" | "5" | "15" | "30" | "60" | "D" = "60",
  limit:    number = 60,
): Promise<OHLCV[]> {
  const url = `${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;

  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await res.json()) as {
    retCode: number;
    retMsg:  string;
    result:  { list: string[][] };
  };

  if (data.retCode !== 0) {
    throw new Error(`Bybit kline error for ${symbol}: ${data.retMsg}`);
  }

  // Bybit returns newest first — reverse to chronological order
  return [...data.result.list].reverse().map(([time, open, high, low, close, volume]) => ({
    time:   parseInt(time, 10),
    open:   parseFloat(open),
    high:   parseFloat(high),
    low:    parseFloat(low),
    close:  parseFloat(close),
    volume: parseFloat(volume),
  }));
}
