/**
 * Flow classification — the backend's pure core, tested from the web suite.
 *
 * Fixtures mirror Arkham's `/transfers` payload: each endpoint carries an
 * `arkhamEntity` (type + tags), an `arkhamLabel` (wallet role) and, for
 * exchange deposit addresses, a `depositServiceID`.
 */

import { describe, expect, it } from "vitest";

import {
  analyze,
  classifyEndpoint,
  CLUSTER_MAX_USD,
  CLUSTER_MIN_USD,
  directionOf,
  fmtUsdShort,
  type ArkhamAddress,
  type ArkhamTransfer,
} from "../../../functions/_lib/flow";

const T0 = Date.parse("2026-10-07T10:00:00Z");
const WINDOW = { windowFrom: T0 - 15 * 60_000, windowTo: T0 + 2 * 60_000 };

const binanceHot: ArkhamAddress = {
  address: "0x28C6c06298d514Db089934071355E5743bf21d60",
  arkhamEntity: { id: "binance", name: "Binance", type: "cex" },
  arkhamLabel: { name: "Hot Wallet" },
};
const binanceCold: ArkhamAddress = {
  address: "0xF977814e90dA44bFA03b6295A0616a897441aceC",
  arkhamEntity: { id: "binance", name: "Binance", type: "cex" },
  arkhamLabel: { name: "Cold Wallet" },
};
const binanceDeposit: ArkhamAddress = {
  address: "0x1111111111111111111111111111111111111111",
  arkhamLabel: { name: "Binance Deposit" },
  depositServiceID: "binance",
};
const okxFutures: ArkhamAddress = {
  address: "0x2222222222222222222222222222222222222222",
  arkhamEntity: { id: "okx", name: "OKX", type: "cex" },
  arkhamLabel: { name: "Futures Wallet" },
};
const wintermute: ArkhamAddress = {
  address: "0x3333333333333333333333333333333333333333",
  arkhamEntity: {
    id: "wintermute",
    name: "Wintermute",
    type: "individual",
    populatedTags: [{ id: "market-maker", label: "Market Maker" }],
  },
};
const fund: ArkhamAddress = {
  address: "0x4444444444444444444444444444444444444444",
  arkhamEntity: { id: "pantera", name: "Pantera Capital", type: "fund" },
};
const whale: ArkhamAddress = { address: "0x5555555555555555555555555555555555555555" };
const whale2: ArkhamAddress = { address: "0x6666666666666666666666666666666666666666" };
const bridge: ArkhamAddress = {
  address: "0x7777777777777777777777777777777777777777",
  arkhamEntity: { id: "stargate", name: "Stargate", type: "bridge" },
};

let seq = 0;
function tx(from: ArkhamAddress, to: ArkhamAddress, usd: number, extra: Partial<ArkhamTransfer> = {}): ArkhamTransfer {
  seq += 1;
  return {
    id: `t${seq}`,
    transactionHash: `0xhash${seq}`,
    chain: "ethereum",
    blockTimestamp: new Date(T0 - 5 * 60_000).toISOString(),
    historicalUSD: usd,
    tokenId: "moonriver",
    tokenSymbol: "MOVR",
    fromAddress: from,
    toAddress: to,
    fromIsContract: false,
    toIsContract: false,
    ...extra,
  };
}

function run(transfers: ArkhamTransfer[], side: "short" | "none" = "short", truncated = false) {
  return analyze({ transfers, side, truncated, ...WINDOW });
}

describe("classifyEndpoint", () => {
  it("reads exchange wallets, their temperature and venue", () => {
    expect(classifyEndpoint(binanceHot, false)).toMatchObject({ role: "exchange", exchange: "binance", kind: "hot", venue: "spot" });
    expect(classifyEndpoint(binanceCold, false)).toMatchObject({ role: "exchange", kind: "cold" });
    expect(classifyEndpoint(okxFutures, false)).toMatchObject({ role: "exchange", exchange: "okx", venue: "derivatives" });
  });

  it("attaches a deposit address to the venue it sweeps into", () => {
    expect(classifyEndpoint(binanceDeposit, false)).toMatchObject({ role: "exchange", exchange: "binance", kind: "deposit" });
  });

  it("tags market makers and funds as smart money", () => {
    expect(classifyEndpoint(wintermute, false)).toMatchObject({ role: "smart-money", tag: "Market Maker" });
    expect(classifyEndpoint(fund, false)).toMatchObject({ role: "smart-money", tag: "Fund" });
  });

  it("treats unlabeled addresses as private wallets and plumbing as services", () => {
    expect(classifyEndpoint(whale, false)).toMatchObject({ role: "private", name: "0x5555…5555" });
    expect(classifyEndpoint(whale, true)).toMatchObject({ role: "contract" });
    expect(classifyEndpoint(bridge, true)).toMatchObject({ role: "service" });
  });

  it("falls back to a predicted entity but remembers it was predicted", () => {
    const predicted: ArkhamAddress = {
      address: "0x8888888888888888888888888888888888888888",
      predictedEntity: { id: "kraken", name: "Kraken", type: "cex" },
    };
    expect(classifyEndpoint(predicted, false)).toMatchObject({ role: "exchange", exchange: "kraken", predicted: true });
  });

  it("does not let an infrastructure entity's name make it smart money", () => {
    const namedBridge: ArkhamAddress = {
      address: "0x9999999999999999999999999999999999999999",
      arkhamEntity: { id: "jump-bridge", name: "Jump Crypto Bridge", type: "bridge" },
    };
    expect(classifyEndpoint(namedBridge, true).role).toBe("service");
  });
});

describe("directionOf", () => {
  it("maps exchange ↔ counterparty moves", () => {
    const hot = classifyEndpoint(binanceHot, false);
    const w = classifyEndpoint(whale, false);
    expect(directionOf(w, hot)).toBe("in");
    expect(directionOf(hot, w)).toBe("out");
  });

  it("ignores exchange-internal shuffles and venue-to-venue transfers", () => {
    const hot = classifyEndpoint(binanceHot, false);
    const cold = classifyEndpoint(binanceCold, false);
    const dep = classifyEndpoint(binanceDeposit, false);
    const okx = classifyEndpoint(okxFutures, false);
    expect(directionOf(dep, hot)).toBe("internal");
    expect(directionOf(hot, cold)).toBe("internal");
    expect(directionOf(hot, okx)).toBe("venue");
  });

  it("does not count contract or bridge traffic as flow", () => {
    const hot = classifyEndpoint(binanceHot, false);
    const br = classifyEndpoint(bridge, true);
    expect(directionOf(br, hot)).toBe("ignored");
    expect(directionOf(hot, br)).toBe("ignored");
    expect(directionOf(classifyEndpoint(whale, false), classifyEndpoint(whale2, false))).toBe("ignored");
  });
});

describe("analyze — band and clustering", () => {
  it("keeps only clustered flows inside $100k–$500k", () => {
    const r = run([
      tx(whale, binanceHot, 60_000), // under the floor on its own
      tx(whale2, binanceDeposit, 150_000),
      tx(binanceHot, fund, 900_000), // whale outlier
    ]);
    expect(r.stats).toMatchObject({ transfers: 3, kept: 1, small: 1, outliers: 1 });
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]).toMatchObject({ direction: "in", usd: 150_000, exchanges: ["Binance"] });
  });

  it("re-assembles a position split into several transfers from one entity", () => {
    const r = run([
      tx(wintermute, binanceDeposit, 40_000),
      tx(wintermute, binanceHot, 45_000),
      tx(wintermute, okxFutures, 50_000),
    ]);
    expect(r.stats.kept).toBe(1);
    expect(r.clusters[0]).toMatchObject({ name: "Wintermute", usd: 135_000, transfers: 3, smartMoney: true, venue: "mixed" });
    expect(r.clusters[0].exchanges).toEqual(["Binance", "OKX"]);
  });

  it("drops a cluster whose split total crosses the ceiling", () => {
    const r = run([tx(whale, binanceHot, 300_000), tx(whale, binanceHot, 300_000)]);
    expect(r.stats.kept).toBe(0);
    expect(r.stats.outliers).toBe(1);
    expect(r.verdict).toBe("none");
  });

  it("clusters the same unlabeled address on both sides separately by direction", () => {
    const r = run([tx(whale, binanceHot, 120_000), tx(binanceHot, whale, 120_000)]);
    expect(r.stats.kept).toBe(2);
    expect(r.verdict).toBe("mixed");
  });

  it("ignores rows outside the window and duplicate ids", () => {
    const late = tx(whale, binanceHot, 200_000, { blockTimestamp: new Date(T0 + 10 * 60_000).toISOString() });
    const dup = tx(whale2, binanceHot, 200_000);
    const r = run([late, dup, { ...dup }]);
    expect(r.stats.transfers).toBe(1);
    expect(r.inflowUsd).toBe(200_000);
  });

  it("exposes the band constants the UI quotes", () => {
    expect(CLUSTER_MIN_USD).toBe(100_000);
    expect(CLUSTER_MAX_USD).toBe(500_000);
  });
});

describe("analyze — verdicts", () => {
  it("calls inflow to exchanges distribution, confirming a short", () => {
    const r = run([tx(whale, binanceDeposit, 180_000), tx(whale2, okxFutures, 120_000)]);
    expect(r.verdict).toBe("distribution");
    expect(r.alignment).toBe("confirms");
    expect(r.qualifier).toBe("mixed");
    expect(r.netUsd).toBe(-300_000);
    expect(r.summary).toMatch(/^Distribution · \$300k in \(2 clusters\) vs \$0 out/);
  });

  it("calls outflow from exchanges accumulation, contradicting a short", () => {
    const r = run([tx(binanceHot, whale, 250_000)]);
    expect(r.verdict).toBe("accumulation");
    expect(r.alignment).toBe("contradicts");
    expect(r.qualifier).toBe("spot");
    expect(r.confidence).toBe("low");
  });

  it("marks a smart-money participant as high confidence", () => {
    const r = run([tx(wintermute, binanceHot, 200_000), tx(whale, binanceHot, 110_000)]);
    expect(r.qualifier).toBe("smart-money");
    expect(r.confidence).toBe("high");
    expect(r.summary).toContain("Wintermute (market maker)");
  });

  it("separates derivatives from spot", () => {
    const r = run([tx(whale, okxFutures, 150_000), tx(whale2, okxFutures, 150_000)]);
    expect(r.qualifier).toBe("derivatives");
    expect(r.confidence).toBe("medium");
  });

  it("reports mixed flow when neither side dominates", () => {
    const r = run([tx(whale, binanceHot, 200_000), tx(binanceHot, whale2, 180_000)]);
    expect(r.verdict).toBe("mixed");
    expect(r.alignment).toBe("neutral");
    expect(r.qualifier).toBe("none");
  });

  it("stays neutral on alignment when the signal has no side", () => {
    const r = run([tx(whale, binanceHot, 200_000)], "none");
    expect(r.verdict).toBe("distribution");
    expect(r.alignment).toBe("neutral");
  });

  it("says why nothing was found", () => {
    const r = run([tx(binanceDeposit, binanceHot, 300_000), tx(whale, binanceHot, 30_000)]);
    expect(r.verdict).toBe("none");
    expect(r.summary).toBe("No $100k–$500k exchange flow · 2 transfers scanned, 1 cluster under $100k, 1 exchange-internal");
  });

  it("carries the truncation flag through", () => {
    expect(run([], "short", true).stats.truncated).toBe(true);
  });
});

describe("fmtUsdShort", () => {
  it("formats compact dollars", () => {
    expect(fmtUsdShort(0)).toBe("$0");
    expect(fmtUsdShort(135_400)).toBe("$135k");
    expect(fmtUsdShort(-300_000)).toBe("−$300k");
    expect(fmtUsdShort(2_450_000)).toBe("$2.5M");
    expect(fmtUsdShort(12_000_000)).toBe("$12M");
  });
});
