/**
 * Wire types for the on-chain intelligence add-on.
 *
 * The web app keeps an identical copy in `web/src/lib/onchain/types.ts` so
 * neither bundle has to import across app folders. Bump `version` on any
 * shape change and update both files together.
 */

export type OnChainPhase = "early" | "final";
export type OnChainState = "ok" | "unavailable";
export type OnChainReason =
  | "no-key"
  | "bad-key"
  | "forbidden"
  | "rate-limited"
  | "timeout"
  | "upstream"
  | "network"
  | "token-unmapped"
  | "no-coverage"
  | "bad-request";
export type OnChainVerdict = "accumulation" | "distribution" | "mixed" | "none";
export type OnChainQualifier = "smart-money" | "spot" | "derivatives" | "mixed" | "none";
export type OnChainConfidence = "high" | "medium" | "low" | "none";
export type OnChainAlignment = "confirms" | "contradicts" | "neutral";
export type SignalSide = "short" | "none";
export type FlowDirection = "in" | "out";
export type Venue = "spot" | "derivatives" | "mixed";

/** One counterparty's transfers inside the window, merged into a single flow. */
export interface OnChainCluster {
  /** Entity id when Arkham labels the counterparty, otherwise its address. */
  key: string;
  name: string;
  direction: FlowDirection;
  usd: number;
  transfers: number;
  venue: Venue;
  /** Exchanges on the other side, display names. */
  exchanges: string[];
  chains: string[];
  smartMoney: boolean;
  /** Why the counterparty counts as smart money, when it does. */
  tag?: string;
}

export interface OnChainStats {
  transfers: number;
  kept: number;
  /** Clusters whose total stayed under the $100k floor. */
  small: number;
  /** Clusters and single transfers above the $500k ceiling. */
  outliers: number;
  /** Exchange-internal moves (deposit sweeps, hot/cold shuffles). */
  internal: number;
  /** Rows that were neither an exchange inflow nor an outflow. */
  ignored: number;
  /** True when Arkham had more rows than the scan fetched. */
  truncated: boolean;
}

export interface OnChainToken {
  id: string;
  symbol: string;
  chains: string[];
}

export interface OnChainRead {
  version: 1;
  symbol: string;
  side: SignalSide;
  /** The signal timestamp the window is anchored to, ms. */
  at: number;
  phase: OnChainPhase;
  window: { from: number; to: number };
  state: OnChainState;
  reason?: OnChainReason;
  message?: string;
  /** For unavailable reads: whether a later attempt could succeed. */
  retryable?: boolean;

  verdict: OnChainVerdict;
  qualifier: OnChainQualifier;
  confidence: OnChainConfidence;
  alignment: OnChainAlignment;

  inflowUsd: number;
  outflowUsd: number;
  /** Outflow minus inflow: positive means coins left exchanges. */
  netUsd: number;
  clusters: OnChainCluster[];
  stats: OnChainStats;
  token?: OnChainToken;
  summary: string;

  scannedAt: number;
  durationMs: number;
  /** Arkham credits the scan consumed, estimated from rows returned. */
  credits: number;
  cached?: boolean;
}

export interface ScanRequest {
  symbol: string;
  at: number;
  side: SignalSide;
  phase: OnChainPhase;
  force?: boolean;
}
