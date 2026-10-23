import { describe, expect, it } from "vitest";

import { fmtClock, fmtCompactUsd, fmtPrice, priceDecimals, priceStep, timeAgo } from "@/lib/format";

describe("priceDecimals", () => {
  it("widens precision as the price shrinks", () => {
    expect(priceDecimals(63_025)).toBe(2);
    expect(priceDecimals(138.4)).toBe(2);
    expect(priceDecimals(1.94)).toBe(4);
    expect(priceDecimals(0.1284)).toBe(5);
    expect(priceDecimals(0.0255)).toBe(6);
    expect(priceDecimals(0.0154)).toBe(6);
    expect(priceDecimals(0.00008)).toBe(8);
  });

  it("never rounds a price away to zero", () => {
    for (const p of [63_025, 2465, 1.94, 0.1284, 0.0255, 0.0154, 0.00008]) {
      expect(Number(p.toFixed(priceDecimals(p)))).toBeGreaterThan(0);
    }
  });

  it("keeps at least 4 significant figures on sub-dollar coins", () => {
    for (const p of [0.514, 0.1284, 0.0255, 0.0154]) {
      const shown = Number(p.toFixed(priceDecimals(p)));
      expect(Math.abs(shown - p) / p).toBeLessThan(0.0001);
    }
  });
});

describe("priceStep", () => {
  it("returns roughly a tenth of a percent, snapped to 1/2/5", () => {
    expect(priceStep(63_025)).toBe(50);
    expect(priceStep(2465)).toBe(2);
    expect(priceStep(138.4)).toBeCloseTo(0.1, 10);
    expect(priceStep(0.0255)).toBeCloseTo(0.00002, 10);
    expect(priceStep(0.0154)).toBeCloseTo(0.00001, 10);
  });

  it("is never finer than the displayed precision", () => {
    for (const p of [63_025, 138.4, 1.94, 0.1284, 0.0255, 0.0154, 0.00008]) {
      expect(priceStep(p)).toBeGreaterThanOrEqual(10 ** -priceDecimals(p) - 1e-12);
    }
  });

  it("moves the price by a visible amount", () => {
    for (const p of [63_025, 138.4, 1.94, 0.0255, 0.0154]) {
      const dp = priceDecimals(p);
      expect(fmtPrice(p + priceStep(p), dp)).not.toBe(fmtPrice(p, dp));
    }
  });

  it("falls back to 1 for a zero or missing price", () => {
    expect(priceStep(0)).toBe(1);
    expect(priceStep(Number.NaN)).toBe(1);
  });
});

describe("fmtCompactUsd", () => {
  it("scales turnover into a readable unit", () => {
    expect(fmtCompactUsd(1_240_000_000)).toBe("$1.24B");
    expect(fmtCompactUsd(12_400_000)).toBe("$12.40M");
    expect(fmtCompactUsd(840_000)).toBe("$840.0K");
    expect(fmtCompactUsd(420)).toBe("$420");
    expect(fmtCompactUsd(0)).toBe("$0");
  });

  it("keeps the sign and rejects rubbish", () => {
    expect(fmtCompactUsd(-2_500_000)).toBe("-$2.50M");
    expect(fmtCompactUsd(null)).toBe("—");
    expect(fmtCompactUsd(Number.NaN)).toBe("—");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");

  it("reads naturally at every scale", () => {
    expect(timeAgo(now, now)).toBe("just now");
    expect(timeAgo(now - 30_000, now)).toBe("30s ago");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(timeAgo(now - 4 * 86_400_000, now)).toBe("4d ago");
  });

  it("never counts forwards or crashes", () => {
    expect(timeAgo(now + 60_000, now)).toBe("just now");
    expect(timeAgo(0, now)).toBe("—");
    expect(timeAgo(null, now)).toBe("—");
  });
});

describe("fmtClock", () => {
  it("stamps feed rows to the second", () => {
    expect(fmtClock(Date.parse("2026-08-01T12:34:56.000Z"))).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(fmtClock(0)).toBe("—");
  });
});
