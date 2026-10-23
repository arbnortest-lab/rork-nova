import { describe, expect, it } from "vitest";

import { baseAssetOf, pickCoinGeckoMatch, staticTokenId } from "../../../functions/_lib/tokens";

describe("baseAssetOf", () => {
  it("strips the quote asset", () => {
    expect(baseAssetOf("MOVRUSDT")).toBe("MOVR");
    expect(baseAssetOf("btcusdt")).toBe("BTC");
    expect(baseAssetOf("ETHUSDC")).toBe("ETH");
  });

  it("strips Binance's multiplier prefixes but keeps tickers that start with digits", () => {
    expect(baseAssetOf("1000PEPEUSDT")).toBe("PEPE");
    expect(baseAssetOf("1000SHIBUSDT")).toBe("SHIB");
    expect(baseAssetOf("1MBABYDOGEUSDT")).toBe("BABYDOGE");
    expect(baseAssetOf("1INCHUSDT")).toBe("1INCH");
  });
});

describe("staticTokenId", () => {
  it("maps the majors and the Binance-specific collisions", () => {
    expect(staticTokenId("BTC")).toBe("bitcoin");
    expect(staticTokenId("MOVR")).toBe("moonriver");
    expect(staticTokenId("TON")).toBe("the-open-network");
    expect(staticTokenId("ONE")).toBe("harmony");
    expect(staticTokenId("AVAX")).toBe("avalanche-2");
    expect(staticTokenId("S")).toBe("sonic-3");
    expect(staticTokenId("nope-not-a-ticker")).toBeUndefined();
  });
});

describe("pickCoinGeckoMatch", () => {
  it("takes the best-ranked exact ticker match", () => {
    const id = pickCoinGeckoMatch(
      {
        coins: [
          { id: "fake-movr", symbol: "MOVRX", market_cap_rank: 3 },
          { id: "moonriver-clone", symbol: "movr", market_cap_rank: null },
          { id: "moonriver", symbol: "MOVR", market_cap_rank: 780 },
        ],
      },
      "movr",
    );
    expect(id).toBe("moonriver");
  });

  it("returns nothing without an exact match", () => {
    expect(pickCoinGeckoMatch({ coins: [{ id: "x", symbol: "XX", market_cap_rank: 1 }] }, "MOVR")).toBeUndefined();
    expect(pickCoinGeckoMatch({}, "MOVR")).toBeUndefined();
  });
});
