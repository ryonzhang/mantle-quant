// ─── Signal & Analysis Types ──────────────────────────────────────────────────

export type Direction = "LONG" | "SHORT" | "NEUTRAL" | "ABSTAIN";

export interface Quote {
  asset:          string;
  symbol:         string;
  price:          number;
  priceChange24h: number;
  volume24h:      number;
  openInterest?:  number;
}

export interface OHLCV {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface Indicators {
  sma20:      number;
  sma50:      number;
  rsi14:      number;
  atr14:      number;
  trend:      "UP" | "DOWN" | "SIDEWAYS";
  overbought: boolean;
  oversold:   boolean;
}

export interface SignalFactors {
  trendScore:       number;
  momentumScore:    number;
  volatilityAdj:    number;
  priceChangeScore: number;
  compositeScore:   number;
}

export interface AnalysisResult {
  asset:          string;
  symbol:         string;
  direction:      Direction;
  confidence:     number;
  entryPrice:     number;
  horizon:        number;
  reasoning:      string;
  factors:        SignalFactors;
  compositeScore: number;
  calibratedProb: number;
  positionSize:   number;
  analysisHash:   string;
  analysisJson:   string;
  // optional LLM enrichment
  narrative?:     string;
  keyDrivers?:    string[];
  riskFactors?:   string[];
  priceTarget?:   number | null;
  stopLoss?:      number | null;
  marketRegime?:  string;
  llmEnriched?:   boolean;
}

export interface OnChainSignal {
  txHash:   string;
  signalId: number;
  asset:    string;
  direction: Direction;
}

export interface ChainConfig {
  rpcUrl:                 string;
  privateKey:             string;
  signalRegistryAddress:  string;
  agentNFTAddress:        string;
  intervalMs:             number;
}
