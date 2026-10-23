/**
 * Flow classification for the on-chain add-on.
 *
 * Pure functions only — no I/O and no Cloudflare types — so the same module
 * is unit-tested from the web app.
 *
 * Every Arkham transfer is reduced to one of five moves:
 *
 *   in        counterparty → exchange   bearish, coins arrive to be sold
 *   out       exchange → counterparty   bullish, coins leave the venue
 *   internal  one exchange shuffling its own wallets (deposit sweeps, hot/cold)
 *   venue     exchange → another exchange
 *   ignored   anything without an exchange on exactly one side
 *
 * Inflows and outflows are then clustered by counterparty, so a position
 * split into several transfers is still seen as one flow, and only clusters
 * between the floor and the ceiling are kept.
 */

import type {
  FlowDirection,
  OnChainAlignment,
  OnChainCluster,
  OnChainConfidence,
  OnChainQualifier,
  OnChainStats,
  OnChainVerdict,
  SignalSide,
  Venue,
} from "./types";

/* ------------------------------------------------------------------ */
/* Arkham payload (the subset this module reads)                       */
/* ------------------------------------------------------------------ */

export interface ArkhamTag {
  id?: string | null;
  label?: string | null;
}

export interface ArkhamEntity {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  service?: boolean | null;
  populatedTags?: ArkhamTag[] | null;
}

export interface ArkhamAddress {
  address?: string | null;
  chain?: string | null;
  arkhamEntity?: ArkhamEntity | null;
  arkhamLabel?: { name?: string | null } | null;
  predictedEntity?: ArkhamEntity | null;
  depositServiceID?: string | null;
  contract?: boolean | null;
}

export interface ArkhamTransfer {
  id?: string | null;
  transactionHash?: string | null;
  chain?: string | null;
  blockTimestamp?: string | null;
  historicalUSD?: number | null;
  tokenId?: string | null;
  tokenSymbol?: string | null;
  fromAddress?: ArkhamAddress | null;
  toAddress?: ArkhamAddress | null;
  fromIsContract?: boolean | null;
  toIsContract?: boolean | null;
}

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

/** Rows are fetched from here so split flows can be re-assembled. */
export const FETCH_FLOOR_USD = 20_000;
/** A counterparty's clustered flow must reach this to count. */
export const CLUSTER_MIN_USD = 100_000;
/** Above this a flow is a whale outlier and is excluded. */
export const CLUSTER_MAX_USD = 500_000;
/** |net| / (in + out) needed before one side is called dominant. */
export const DOMINANCE_MIN = 0.25;
/** Clusters are reported in full counts, but only this many travel to the UI. */
export const MAX_CLUSTERS_OUT = 8;

/* ------------------------------------------------------------------ */
/* Endpoint classification                                             */
/* ------------------------------------------------------------------ */

export type EndpointRole = "exchange" | "smart-money" | "private" | "service" | "contract";
export type ExchangeKind = "hot" | "cold" | "deposit";

export interface Endpoint {
  role: EndpointRole;
  /** Stable identity for clustering: entity id, else address. */
  key: string;
  name: string;
  exchange?: string;
  kind?: ExchangeKind;
  venue?: "spot" | "derivatives";
  /** Why the endpoint counts as smart money. */
  tag?: string;
  /** True when the entity came from Arkham's prediction tier, not a verified label. */
  predicted: boolean;
}

const EXCHANGE_TYPES = new Set(["cex", "derivatives"]);
const SMART_TYPES = new Set(["fund", "fund-decentralized", "otc", "custodian"]);
/** Infrastructure that moves coins for others and tells nothing about intent. */
const INFRA_TYPES = new Set([
  "dex",
  "dex-aggregator",
  "defi",
  "bridge",
  "crosschain-interoperability",
  "mixer",
  "staking",
  "liquid-staking",
  "lending-decentralized",
  "lending-centralized",
  "cdp",
  "yield",
  "oracle",
  "blockchain-infra",
  "blockchain-infrastructure",
  "blockchain-scaling",
  "smart-contract-platform",
  "nft-marketplace",
  "launchpad",
  "faucet",
  "mev",
  "validator",
  "insurance",
  "prediction-market",
  "gambling",
  "stablecoin",
  "wallet",
  "privacy",
  "hacker",
  "scam",
  "ponzi",
  "ransomware",
  "darkweb",
]);

const SMART_TAG_RE = /market.?mak|smart.?money|\bvc\b|venture|hedge|\bfund\b|whale|prop.?trad|quant|otc|custod/i;
const SMART_NAME_RE =
  /\b(?:wintermute|jump(?: trading| crypto)?|gsr|cumberland|dwf labs|amber group|flow traders|galaxy digital|b2c2|auros|kronos research|qcp|keyrock|kairon|gotbit|jane street|tower research|hudson river|virtu|a16z|andreessen|paradigm|pantera|polychain|dragonfly|multicoin|grayscale|blackrock|fidelity|ark invest|vaneck|bitwise|franklin templeton|brevan howard|millennium|citadel|abraxas|arrington|sequoia|hashkey|animoca|spartan|delphi|framework ventures|1kx|1confirmation|electric capital|variant fund|hack vc|nascent|cms holdings|defiance|mechanism capital|selini|dv chain|portofino|wincent|laser digital|coinbase ventures|binance labs|yzi labs|okx ventures|mexc ventures|bybit ventures|kucoin ventures)\b/i;
const DERIVATIVES_RE = /futures|perp|derivativ|margin/i;
const COLD_RE = /cold|reserve|treasury|vault/i;

function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function smartTagOf(entity: ArkhamEntity): string | undefined {
  const type = (entity.type ?? "").toLowerCase();
  if (SMART_TYPES.has(type)) return titleCase(type === "otc" ? "OTC desk" : type);
  for (const tag of entity.populatedTags ?? []) {
    const text = `${tag.label ?? ""} ${tag.id ?? ""}`;
    if (SMART_TAG_RE.test(text)) return (tag.label ?? tag.id ?? "tagged").trim();
  }
  const name = `${entity.name ?? ""} ${entity.id ?? ""}`;
  if (SMART_NAME_RE.test(name)) return "Market maker / fund";
  return undefined;
}

/** Reduces one side of a transfer to a role the flow logic can reason about. */
export function classifyEndpoint(
  address: ArkhamAddress | null | undefined,
  isContract: boolean | null | undefined,
): Endpoint {
  const raw = (address?.address ?? "").trim();
  const addrKey = raw.toLowerCase();
  const label = address?.arkhamLabel?.name ?? "";
  const verified = address?.arkhamEntity ?? undefined;
  const predicted = !verified && address?.predictedEntity ? address.predictedEntity : undefined;
  const entity = verified ?? predicted;
  const isPredicted = !verified && Boolean(predicted);
  const type = (entity?.type ?? "").toLowerCase();
  const deposit = (address?.depositServiceID ?? "").trim().toLowerCase();

  // Exchange wallets first: a deposit address has no entity of its own but
  // belongs to the venue it sweeps into.
  if ((entity && EXCHANGE_TYPES.has(type)) || deposit) {
    const exchange = (entity && EXCHANGE_TYPES.has(type) ? entity.id : undefined) ?? deposit;
    const name = (entity && EXCHANGE_TYPES.has(type) ? entity.name : undefined) ?? titleCase(deposit);
    const kind: ExchangeKind =
      !(entity && EXCHANGE_TYPES.has(type)) && deposit
        ? "deposit"
        : COLD_RE.test(label)
          ? "cold"
          : "hot";
    const venue: "spot" | "derivatives" =
      type === "derivatives" || DERIVATIVES_RE.test(`${label} ${entity?.name ?? ""}`) ? "derivatives" : "spot";
    return {
      role: "exchange",
      key: `x:${exchange ?? addrKey}`,
      name: name || "Exchange",
      exchange: exchange ?? addrKey,
      kind,
      venue,
      predicted: isPredicted,
    };
  }

  if (entity) {
    const name = entity.name || titleCase(entity.id ?? "") || shortAddress(raw);
    const key = entity.id ? `e:${entity.id.toLowerCase()}` : `a:${addrKey}`;
    // Infrastructure first: a bridge or DEX called "X Capital" is still plumbing.
    if (INFRA_TYPES.has(type)) return { role: "service", key, name, predicted: isPredicted };
    const tag = smartTagOf(entity);
    if (tag) return { role: "smart-money", key, name, tag, predicted: isPredicted };
    if (isContract || address?.contract) return { role: "contract", key, name, predicted: isPredicted };
    return { role: "private", key, name, predicted: isPredicted };
  }

  if (isContract || address?.contract) {
    return { role: "contract", key: `a:${addrKey}`, name: label || shortAddress(raw), predicted: false };
  }
  return { role: "private", key: `a:${addrKey}`, name: label || shortAddress(raw), predicted: false };
}

/* ------------------------------------------------------------------ */
/* Direction                                                           */
/* ------------------------------------------------------------------ */

export type Direction = FlowDirection | "internal" | "venue" | "ignored";

export function directionOf(from: Endpoint, to: Endpoint): Direction {
  const fromExchange = from.role === "exchange";
  const toExchange = to.role === "exchange";

  if (fromExchange && toExchange) return from.exchange === to.exchange ? "internal" : "venue";
  if (!fromExchange && !toExchange) return "ignored";

  if (fromExchange) {
    // A deposit address paying out somewhere other than its own venue is not a withdrawal.
    if (from.kind === "deposit") return "ignored";
    return to.role === "contract" || to.role === "service" ? "ignored" : "out";
  }
  return from.role === "contract" || from.role === "service" ? "ignored" : "in";
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

export interface AnalysisInput {
  transfers: ArkhamTransfer[];
  windowFrom: number;
  windowTo: number;
  side: SignalSide;
  truncated: boolean;
}

export interface Analysis {
  verdict: OnChainVerdict;
  qualifier: OnChainQualifier;
  confidence: OnChainConfidence;
  alignment: OnChainAlignment;
  inflowUsd: number;
  outflowUsd: number;
  netUsd: number;
  clusters: OnChainCluster[];
  stats: OnChainStats;
  summary: string;
}

interface Bucket {
  key: string;
  name: string;
  direction: FlowDirection;
  usd: number;
  transfers: number;
  venues: Set<"spot" | "derivatives">;
  exchanges: Set<string>;
  chains: Set<string>;
  smartMoney: boolean;
  tag?: string;
}

/** Compact dollar text shared by the summary line. */
export function fmtUsdShort(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

function venueOf(venues: Set<"spot" | "derivatives">): Venue {
  if (venues.size === 0) return "spot";
  if (venues.size > 1) return "mixed";
  return venues.has("derivatives") ? "derivatives" : "spot";
}

export function analyze(input: AnalysisInput): Analysis {
  const buckets = new Map<string, Bucket>();
  const seen = new Set<string>();
  const stats: OnChainStats = {
    transfers: 0,
    kept: 0,
    small: 0,
    outliers: 0,
    internal: 0,
    ignored: 0,
    truncated: input.truncated,
  };

  for (const t of input.transfers) {
    const usd = typeof t.historicalUSD === "number" && Number.isFinite(t.historicalUSD) ? t.historicalUSD : 0;
    if (usd <= 0) continue;

    const ts = t.blockTimestamp ? Date.parse(t.blockTimestamp) : NaN;
    if (Number.isFinite(ts) && (ts < input.windowFrom || ts > input.windowTo)) continue;

    const dedupe = t.id ?? (t.transactionHash ? `${t.transactionHash}:${t.fromAddress?.address ?? ""}:${t.toAddress?.address ?? ""}:${usd}` : "");
    if (dedupe) {
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
    }
    stats.transfers += 1;

    if (usd > CLUSTER_MAX_USD) {
      stats.outliers += 1;
      continue;
    }

    const from = classifyEndpoint(t.fromAddress, t.fromIsContract);
    const to = classifyEndpoint(t.toAddress, t.toIsContract);
    const direction = directionOf(from, to);

    if (direction === "internal") {
      stats.internal += 1;
      continue;
    }
    if (direction === "venue" || direction === "ignored") {
      stats.ignored += 1;
      continue;
    }

    const counterparty = direction === "in" ? from : to;
    const exchange = direction === "in" ? to : from;
    const key = `${direction}:${counterparty.key}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key: counterparty.key,
        name: counterparty.name,
        direction,
        usd: 0,
        transfers: 0,
        venues: new Set(),
        exchanges: new Set(),
        chains: new Set(),
        smartMoney: counterparty.role === "smart-money",
        tag: counterparty.tag,
      };
      buckets.set(key, bucket);
    }
    bucket.usd += usd;
    bucket.transfers += 1;
    if (exchange.venue) bucket.venues.add(exchange.venue);
    bucket.exchanges.add(exchange.name);
    if (t.chain) bucket.chains.add(t.chain);
  }

  const kept: OnChainCluster[] = [];
  for (const b of buckets.values()) {
    if (b.usd < CLUSTER_MIN_USD) {
      stats.small += 1;
      continue;
    }
    if (b.usd > CLUSTER_MAX_USD) {
      stats.outliers += 1;
      continue;
    }
    kept.push({
      key: b.key,
      name: b.name,
      direction: b.direction,
      usd: Math.round(b.usd),
      transfers: b.transfers,
      venue: venueOf(b.venues),
      exchanges: [...b.exchanges].sort(),
      chains: [...b.chains].sort(),
      smartMoney: b.smartMoney,
      tag: b.tag,
    });
  }
  kept.sort((a, b) => b.usd - a.usd);
  stats.kept = kept.length;

  const inflow = kept.filter((c) => c.direction === "in");
  const outflow = kept.filter((c) => c.direction === "out");
  const inflowUsd = inflow.reduce((s, c) => s + c.usd, 0);
  const outflowUsd = outflow.reduce((s, c) => s + c.usd, 0);
  const netUsd = outflowUsd - inflowUsd;
  const total = inflowUsd + outflowUsd;
  const dominance = total > 0 ? Math.abs(netUsd) / total : 0;

  let verdict: OnChainVerdict = "none";
  if (total > 0) {
    if (dominance >= DOMINANCE_MIN) verdict = netUsd > 0 ? "accumulation" : "distribution";
    else verdict = "mixed";
  }

  const dominant = verdict === "accumulation" ? outflow : verdict === "distribution" ? inflow : [];
  const smart = dominant.filter((c) => c.smartMoney);
  let qualifier: OnChainQualifier = "none";
  if (dominant.length) {
    if (smart.length) qualifier = "smart-money";
    else {
      const venues = new Set(dominant.map((c) => c.venue));
      qualifier = venues.size === 1 && !venues.has("mixed") ? ([...venues][0] as OnChainQualifier) : "mixed";
    }
  }

  let confidence: OnChainConfidence = "none";
  if (dominant.length) {
    const dominantUsd = verdict === "accumulation" ? outflowUsd : inflowUsd;
    if (smart.length) confidence = "high";
    else if (dominance >= 0.5 && (dominant.length >= 2 || dominantUsd >= 300_000)) confidence = "medium";
    else confidence = "low";
  }

  let alignment: OnChainAlignment = "neutral";
  if (input.side === "short") {
    if (verdict === "distribution") alignment = "confirms";
    else if (verdict === "accumulation") alignment = "contradicts";
  }

  const summary = summarize({ verdict, inflow, outflow, inflowUsd, outflowUsd, netUsd, smart, stats });

  return {
    verdict,
    qualifier,
    confidence,
    alignment,
    inflowUsd: Math.round(inflowUsd),
    outflowUsd: Math.round(outflowUsd),
    netUsd: Math.round(netUsd),
    clusters: kept.slice(0, MAX_CLUSTERS_OUT),
    stats,
    summary,
  };
}

function summarize(x: {
  verdict: OnChainVerdict;
  inflow: OnChainCluster[];
  outflow: OnChainCluster[];
  inflowUsd: number;
  outflowUsd: number;
  netUsd: number;
  smart: OnChainCluster[];
  stats: OnChainStats;
}): string {
  const clusters = (n: number) => `${n} cluster${n === 1 ? "" : "s"}`;
  if (x.verdict === "none") {
    const parts: string[] = [`${x.stats.transfers} transfer${x.stats.transfers === 1 ? "" : "s"} scanned`];
    if (x.stats.small) parts.push(`${clusters(x.stats.small)} under $100k`);
    if (x.stats.outliers) parts.push(`${x.stats.outliers} above $500k`);
    if (x.stats.internal) parts.push(`${x.stats.internal} exchange-internal`);
    return `No $100k–$500k exchange flow · ${parts.join(", ")}`;
  }
  const head =
    x.verdict === "accumulation"
      ? "Accumulation"
      : x.verdict === "distribution"
        ? "Distribution"
        : "Mixed flow";
  const body = `${fmtUsdShort(x.inflowUsd)} in (${clusters(x.inflow.length)}) vs ${fmtUsdShort(x.outflowUsd)} out (${clusters(x.outflow.length)}) · net ${fmtUsdShort(x.netUsd)}`;
  const tagged = x.smart.length
    ? ` · ${x.smart
        .slice(0, 2)
        .map((c) => `${c.name}${c.tag ? ` (${c.tag.toLowerCase()})` : ""}`)
        .join(", ")}`
    : "";
  return `${head} · ${body}${tagged}`;
}
