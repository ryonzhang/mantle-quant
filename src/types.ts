// ─── Signal & Analysis Types ──────────────────────────────────────────────────

export type Direction = "LONG" | "SHORT" | "NEUTRAL";

/** Raw market quote from Bybit */
export interface Quote {
  asset:           string;
  symbol:          string;
  price:           number;
  priceChange24h:  number;   // percent
  volume24h:       number;
  openInterest?:   number;
}

/** OHLCV candle */
export interface OHLCV {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

/** Technical indicator bundle */
export interface Indicators {
  sma20:      number;
  sma50:      number;
  rsi14:      number;
  atr14:      number;
  trend:      "UP" | "DOWN" | "SIDEWAYS";
  overbought: boolean;
  oversold:   boolean;
}

/** Multi-factor scoring breakdown */
export interface SignalFactors {
  trendScore:      number;   // -1 to +1
  momentumScore:   number;   // -1 to +1
  volatilityAdj:   number;   // 0 to -1 (penalty)
  priceChangeScore: number;  // -1 to +1
  compositeScore:  number;   // combined
}

/** Final analysis result from the AI engine */
export interface AnalysisResult {
  asset:       string;
  direction:   Direction;
  confidence:  number;          // 0–1000 (0.0 %–100.0 %)
  entryPrice:  number;
  horizon:     number;          // minutes
  reasoning:   string;
  factors:     SignalFactors;
  timestamp:   number;          // unix ms
}

/** A signal that has been committed to Mantle chain */
export interface OnChainSignal {
  txHash:   string;
  signalId: number;
  analysis: AnalysisResult;
  blockNumber?: number;
}

/** Config for the on-chain writer */
export interface ChainConfig {
  rpcUrl:          string;
  privateKey:      string;
  signalRegistry:  string;   // contract address
  agentNFT?:       string;   // optional, for registration
}
