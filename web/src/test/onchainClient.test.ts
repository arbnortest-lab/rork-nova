/**
 * The browser client must resolve in every case — a backend that is down,
 * undeployed or answering HTML can never throw into the add-on.
 */

import { describe, expect, it } from "vitest";

import { fetchStatus, outcomeOf, requestScan, verifyKey, type FetchLike } from "@/lib/onchain/client";

const REQ = { symbol: "MOVRUSDT", at: 1_800_000_000_000, side: "short" as const, phase: "early" as const };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const readBody = {
  version: 1,
  symbol: "MOVRUSDT",
  side: "short",
  at: REQ.at,
  phase: "early",
  window: { from: 0, to: 0 },
  state: "ok",
  verdict: "none",
  qualifier: "none",
  confidence: "none",
  alignment: "neutral",
  inflowUsd: 0,
  outflowUsd: 0,
  netUsd: 0,
  clusters: [],
  stats: { transfers: 0, kept: 0, small: 0, outliers: 0, internal: 0, ignored: 0, truncated: false },
  summary: "",
  scannedAt: 1,
  durationMs: 1,
  credits: 0,
};

describe("outcomeOf", () => {
  it("returns the read on 200", async () => {
    const o = await outcomeOf(json(readBody));
    expect(o.kind).toBe("read");
  });

  it("returns pending on 202", async () => {
    const o = await outcomeOf(json({ pending: true, position: 2, queue: 3 }, 202));
    expect(o).toEqual({ kind: "pending", position: 2, queue: 3 });
  });

  it("treats a 200 that is not a scan (the SPA shell on a dev server) as a retryable failure", async () => {
    const o = await outcomeOf(new Response("<!doctype html><html></html>", { status: 200 }));
    expect(o).toMatchObject({ kind: "failed", reason: "upstream", retryable: true });
  });

  it("maps 400 and 403 to non-retryable, 429 and 5xx to retryable", async () => {
    expect(await outcomeOf(json({ error: "signal is older than 7 days" }, 400))).toMatchObject({ reason: "bad-request", retryable: false });
    expect(await outcomeOf(json({ error: "origin not allowed" }, 403))).toMatchObject({ reason: "forbidden", retryable: false });
    expect(await outcomeOf(json({ error: "slow down" }, 429))).toMatchObject({ reason: "rate-limited", retryable: true });
    expect(await outcomeOf(new Response("no bundle deployed for this project", { status: 503 }))).toMatchObject({
      reason: "upstream",
      message: "Backend is not deployed yet",
      retryable: true,
    });
  });
});

describe("requestScan", () => {
  it("posts the request and parses the answer", async () => {
    let seen: { url: string; body: string } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, body: String(init?.body) };
      return json(readBody);
    };
    const o = await requestScan(REQ, { fetchImpl });
    expect(o.kind).toBe("read");
    expect(seen?.url).toBe("/~api/onchain/scan");
    expect(JSON.parse(seen?.body ?? "{}")).toMatchObject(REQ);
  });

  it("turns a network error into a retryable failure instead of throwing", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const o = await requestScan(REQ, { fetchImpl });
    expect(o).toMatchObject({ kind: "failed", reason: "network", retryable: true });
  });

  it("times out", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const o = await requestScan(REQ, { fetchImpl, timeoutMs: 20 });
    expect(o).toMatchObject({ kind: "failed", reason: "timeout", retryable: true });
  });
});

describe("fetchStatus / verifyKey", () => {
  it("returns undefined status when the backend is not answering properly", async () => {
    expect(await fetchStatus({ fetchImpl: async () => new Response("<html/>", { status: 200 }) })).toBeUndefined();
    expect(await fetchStatus({ fetchImpl: async () => new Response("", { status: 503 }) })).toBeUndefined();
    expect(
      await fetchStatus({
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeUndefined();
  });

  it("passes a real status through", async () => {
    const status = {
      configured: true,
      queue: 0,
      inFlight: null,
      today: { day: "2026-10-07", credits: 12, scans: 3, failures: 0 },
      creditCap: 25_000,
      scanLimit: 250,
      cachedScans: 3,
      now: 1,
    };
    expect(await fetchStatus({ fetchImpl: async () => json(status) })).toEqual(status);
  });

  it("verify never throws", async () => {
    expect(await verifyKey({ fetchImpl: async () => json({ ok: false, reason: "no-key", message: "missing" }) })).toMatchObject({
      ok: false,
      reason: "no-key",
    });
    expect(
      await verifyKey({
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).toMatchObject({ ok: false, reason: "network" });
    expect(await verifyKey({ fetchImpl: async () => new Response("no bundle deployed", { status: 503 }) })).toMatchObject({
      ok: false,
      message: "Backend is not deployed yet",
    });
  });
});
