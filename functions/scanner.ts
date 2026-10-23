/**
 * OnChainScanner — one Durable Object instance ("global") that owns every
 * Arkham call this project makes.
 *
 * Why one instance: Arkham's `/transfers` endpoint allows 1 request per
 * second per API key, and the browser may raise several Wick signals in the
 * same scan tick. Serialising here means the add-on can never trip the rate
 * limit on its own, however many tabs are open.
 *
 * What it does for a scan request:
 *   1. answers from cache when the same signal was scanned already
 *   2. resolves the Binance symbol to Arkham's token id
 *   3. checks, once per token per day, that Arkham indexes the asset at all
 *   4. fetches every $20k–$500k transfer of that token inside the signal
 *      window and reduces it to one verdict (see `_lib/flow.ts`)
 *
 * Everything that can fail is reported as an `unavailable` read with a reason,
 * never as a thrown error, so the Wick module is never affected.
 */

import { DurableObject } from "cloudflare:workers";

import { ArkhamError, arkhamGet } from "./_lib/arkham";
import { analyze, type ArkhamTransfer, CLUSTER_MAX_USD, FETCH_FLOOR_USD } from "./_lib/flow";
import { baseAssetOf, searchCoinGecko, staticTokenId } from "./_lib/tokens";
import type {
  OnChainPhase,
  OnChainRead,
  OnChainReason,
  OnChainToken,
  ScanRequest,
  SignalSide,
} from "./_lib/types";

type Env = {
  ARKHAM_API_KEY?: string;
  /** Hard stop on Arkham credits per UTC day. Default 25,000. */
  ONCHAIN_DAILY_CREDIT_CAP?: string;
  /** Rows fetched per scan (2 credits each). Default 250, max 1000. */
  ONCHAIN_SCAN_LIMIT?: string;
};

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** The window the spec pins the scan to: 15 minutes before the signal, 2 after. */
export const WINDOW_BEFORE_MS = 15 * 60_000;
export const WINDOW_AFTER_MS = 2 * 60_000;

/** Heavy Arkham endpoints allow 1 request/second; keep a little slack. */
const HEAVY_SPACING_MS = 1_150;
const ARKHAM_TIMEOUT_MS = 12_000;
/** How long a request waits for its scan before answering 202 "still running". */
const REQUEST_WAIT_MS = 20_000;

const EARLY_TTL_MS = 10 * 60_000;
const FINAL_TTL_MS = 7 * 24 * 60 * 60_000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const TOKEN_MISS_TTL_MS = 6 * 60 * 60_000;
const COVERAGE_TTL_MS = 24 * 60 * 60_000;
const COVERAGE_MISS_TTL_MS = 12 * 60 * 60_000;
/** Signals older than this are not worth the credits. */
const MAX_SIGNAL_AGE_MS = 7 * 24 * 60 * 60_000;

const DEFAULT_CREDIT_CAP = 25_000;
const DEFAULT_SCAN_LIMIT = 250;
const CREDITS_PER_ROW = 2;

/* ------------------------------------------------------------------ */
/* Payload shapes                                                      */
/* ------------------------------------------------------------------ */

interface TransfersPage {
  count?: number | null;
  transfers?: ArkhamTransfer[] | null;
}

type ScanRow = Record<string, SqlStorageValue> & {
  payload: string;
  created_at: number;
};

type TokenRow = Record<string, SqlStorageValue> & {
  token_id: string;
  source: string;
  resolved_at: number;
};

type CoverageRow = Record<string, SqlStorageValue> & {
  covered: number;
  symbol: string;
  chains: string;
  checked_at: number;
};

type UsageRow = Record<string, SqlStorageValue> & {
  credits: number;
  scans: number;
  failures: number;
  last_error: string | null;
  last_error_at: number | null;
};

export interface ScannerStatus {
  configured: boolean;
  queue: number;
  inFlight: string | null;
  today: { day: string; credits: number; scans: number; failures: number };
  creditCap: number;
  scanLimit: number;
  lastError?: string;
  lastErrorAt?: number;
  cachedScans: number;
  now: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function parseScanRequest(body: unknown, now: number): ScanRequest | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const symbol = typeof b.symbol === "string" ? b.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{3,24}$/.test(symbol)) return "symbol is required";
  const at = typeof b.at === "number" && Number.isFinite(b.at) ? Math.round(b.at) : Number.NaN;
  if (!Number.isFinite(at) || at > now + 5 * 60_000) return "at must be an epoch-ms timestamp";
  if (now - at > MAX_SIGNAL_AGE_MS) return "signal is older than 7 days";
  const side: SignalSide = b.side === "short" ? "short" : "none";
  const phase: OnChainPhase = b.phase === "final" ? "final" : "early";
  return { symbol, at, side, phase, force: b.force === true };
}

function emptyRead(req: ScanRequest, now: number): OnChainRead {
  return {
    version: 1,
    symbol: req.symbol,
    side: req.side,
    at: req.at,
    phase: req.phase,
    window: { from: req.at - WINDOW_BEFORE_MS, to: req.at + WINDOW_AFTER_MS },
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
    scannedAt: now,
    durationMs: 0,
    credits: 0,
  };
}

function unavailable(
  req: ScanRequest,
  now: number,
  reason: OnChainReason,
  message: string,
  retryable: boolean,
  extra: Partial<OnChainRead> = {},
): OnChainRead {
  return {
    ...emptyRead(req, now),
    state: "unavailable",
    reason,
    message,
    retryable,
    summary: message,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* The Durable Object                                                  */
/* ------------------------------------------------------------------ */

export class OnChainScanner extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<OnChainRead>>();
  private readonly waiting: string[] = [];
  private running: string | null = null;
  private lastHeavyAt = 0;
  private readonly mem = new Map<string, OnChainRead>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        key TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        at INTEGER NOT NULL,
        phase TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        base TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        source TEXT NOT NULL,
        resolved_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coverage (
        token_id TEXT PRIMARY KEY,
        covered INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        chains TEXT NOT NULL,
        checked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT PRIMARY KEY,
        credits INTEGER NOT NULL DEFAULT 0,
        scans INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_at INTEGER
      );
    `);
  }

  /* ---------------------------------------------------------------- */
  /* HTTP surface                                                       */
  /* ---------------------------------------------------------------- */

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    try {
      if (url.pathname === "/onchain/status" && request.method === "GET") {
        return Response.json(this.status(now));
      }

      if (url.pathname === "/onchain/verify" && request.method === "POST") {
        return Response.json(await this.verify());
      }

      if (url.pathname === "/onchain/scan" && request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        const parsed = parseScanRequest(body, now);
        if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
        return this.handleScan(parsed, now);
      }

      return Response.json({ error: "not found" }, { status: 404 });
    } catch (err) {
      console.error("[onchain] handler failed", err instanceof Error ? err.message : err);
      return Response.json({ error: "scanner failed" }, { status: 500 });
    }
  }

  private status(now: number): ScannerStatus {
    const usage = this.usage(utcDay(now));
    const cached = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scans").one().n;
    return {
      configured: this.configured(),
      queue: this.waiting.length,
      inFlight: this.running,
      today: { day: utcDay(now), credits: usage.credits, scans: usage.scans, failures: usage.failures },
      creditCap: this.creditCap(),
      scanLimit: this.scanLimit(),
      lastError: usage.last_error ?? undefined,
      lastErrorAt: usage.last_error_at ?? undefined,
      cachedScans: cached,
      now,
    };
  }

  /** Proves the key with a free endpoint; costs no credits. */
  private async verify(): Promise<{ ok: boolean; reason?: OnChainReason; message: string; chains?: number }> {
    const key = this.apiKey();
    if (!key) return { ok: false, reason: "no-key", message: "ARKHAM_API_KEY is not set on the backend" };
    try {
      const chains = await arkhamGet<unknown>("/chains", {}, key, ARKHAM_TIMEOUT_MS);
      const n = Array.isArray(chains) ? chains.length : chains && typeof chains === "object" ? Object.keys(chains).length : 0;
      return { ok: true, message: `Arkham accepted the key · ${n} chains indexed`, chains: n };
    } catch (err) {
      if (err instanceof ArkhamError) return { ok: false, reason: err.reason, message: err.message };
      return { ok: false, reason: "upstream", message: err instanceof Error ? err.message : "verify failed" };
    }
  }

  private async handleScan(req: ScanRequest, now: number): Promise<Response> {
    const key = this.scanKey(req);

    if (!req.force) {
      const cached = this.cachedRead(key, req.phase, now);
      if (cached) return Response.json({ ...cached, cached: true });
    }

    let job = this.inflight.get(key);
    if (!job) {
      job = this.enqueue(key, () => this.runScan(req));
      this.inflight.set(key, job);
      void job.finally(() => this.inflight.delete(key));
      this.ctx.waitUntil(job.catch(() => undefined));
    }

    const result = await Promise.race([job, sleep(REQUEST_WAIT_MS).then(() => null)]);
    if (!result) {
      const position = this.waiting.indexOf(key);
      return Response.json(
        { pending: true, position: position < 0 ? 0 : position + 1, queue: this.waiting.length },
        { status: 202 },
      );
    }
    return Response.json(result);
  }

  /* ---------------------------------------------------------------- */
  /* Queue                                                              */
  /* ---------------------------------------------------------------- */

  private enqueue(key: string, work: () => Promise<OnChainRead>): Promise<OnChainRead> {
    this.waiting.push(key);
    const run = this.queue.then(async () => {
      const idx = this.waiting.indexOf(key);
      if (idx >= 0) this.waiting.splice(idx, 1);
      this.running = key;
      try {
        return await work();
      } finally {
        this.running = null;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async pace(): Promise<void> {
    const wait = this.lastHeavyAt + HEAVY_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastHeavyAt = Date.now();
  }

  /** One heavy Arkham call, paced, with a single retry on 429. */
  private async heavy<T>(path: string, params: Record<string, string>, key: string): Promise<T> {
    await this.pace();
    try {
      return await arkhamGet<T>(path, params, key, ARKHAM_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof ArkhamError && err.reason === "rate-limited") {
        await sleep(2_500);
        await this.pace();
        return arkhamGet<T>(path, params, key, ARKHAM_TIMEOUT_MS);
      }
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /* The scan                                                           */
  /* ---------------------------------------------------------------- */

  private async runScan(req: ScanRequest): Promise<OnChainRead> {
    const started = Date.now();
    const key = this.apiKey();
    if (!key) {
      return unavailable(req, started, "no-key", "On-chain add-on is not configured: ARKHAM_API_KEY is missing", false);
    }

    const day = utcDay(started);
    const usage = this.usage(day);
    const cap = this.creditCap();
    if (usage.credits >= cap) {
      return unavailable(
        req,
        started,
        "rate-limited",
        `Daily Arkham credit cap reached (${usage.credits.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")}); resets at 00:00 UTC`,
        true,
      );
    }

    let credits = 0;
    try {
      const token = await this.resolveToken(req.symbol, started);
      if (!token) {
        return this.finish(
          req,
          unavailable(
            req,
            started,
            "token-unmapped",
            `${baseAssetOf(req.symbol)} could not be matched to an Arkham token id`,
            false,
          ),
          0,
          started,
        );
      }

      const coverage = await this.coverage(token.id, key, started);
      credits += coverage.credits;
      if (!coverage.covered) {
        return this.finish(
          req,
          unavailable(
            req,
            started,
            "no-coverage",
            `Arkham has no transfer history for ${coverage.symbol || baseAssetOf(req.symbol)} (${token.id}) on the chains it indexes`,
            false,
            { token: { id: token.id, symbol: coverage.symbol || baseAssetOf(req.symbol), chains: [] } },
          ),
          credits,
          started,
        );
      }

      const window = { from: req.at - WINDOW_BEFORE_MS, to: req.at + WINDOW_AFTER_MS };
      const limit = this.scanLimit();
      const page = await this.heavy<TransfersPage>(
        "/transfers",
        {
          tokens: token.id,
          timeGte: String(window.from),
          timeLte: String(window.to),
          usdGte: String(FETCH_FLOOR_USD),
          usdLte: String(CLUSTER_MAX_USD),
          limit: String(limit),
        },
        key,
      );
      const rows = Array.isArray(page.transfers) ? page.transfers : [];
      credits += rows.length * CREDITS_PER_ROW;
      const total = typeof page.count === "number" ? page.count : rows.length;

      const analysis = analyze({
        transfers: rows,
        windowFrom: window.from,
        windowTo: window.to,
        side: req.side,
        truncated: total > rows.length,
      });

      const chains = [...new Set(rows.map((r) => r.chain).filter((c): c is string => typeof c === "string"))].sort();
      const tokenInfo: OnChainToken = {
        id: token.id,
        symbol: rows[0]?.tokenSymbol ?? coverage.symbol ?? baseAssetOf(req.symbol),
        chains: chains.length ? chains : coverage.chains,
      };

      const read: OnChainRead = {
        ...emptyRead(req, started),
        state: "ok",
        verdict: analysis.verdict,
        qualifier: analysis.qualifier,
        confidence: analysis.confidence,
        alignment: analysis.alignment,
        inflowUsd: analysis.inflowUsd,
        outflowUsd: analysis.outflowUsd,
        netUsd: analysis.netUsd,
        clusters: analysis.clusters,
        stats: analysis.stats,
        token: tokenInfo,
        summary: analysis.summary,
      };
      return this.finish(req, read, credits, started);
    } catch (err) {
      const reason: OnChainReason = err instanceof ArkhamError ? err.reason : "upstream";
      const message = err instanceof ArkhamError ? err.message : `Scan failed: ${err instanceof Error ? err.message : "unknown"}`;
      const retryable = err instanceof ArkhamError ? err.retryable : true;
      console.warn(`[onchain] ${req.symbol} ${req.phase} failed: ${message}`);
      this.recordFailure(day, message, Date.now());
      return this.finish(req, unavailable(req, started, reason, message, retryable), credits, started, false);
    }
  }

  private finish(req: ScanRequest, read: OnChainRead, credits: number, started: number, cache = true): OnChainRead {
    const now = Date.now();
    const done: OnChainRead = { ...read, scannedAt: now, durationMs: now - started, credits };
    this.recordUsage(utcDay(now), credits, 1);
    if (cache && read.state === "ok") this.store(req, done, now);
    return done;
  }

  /* ---------------------------------------------------------------- */
  /* Token → Arkham id                                                  */
  /* ---------------------------------------------------------------- */

  private async resolveToken(symbol: string, now: number): Promise<{ id: string; source: string } | undefined> {
    const base = baseAssetOf(symbol);
    const fixed = staticTokenId(base);
    if (fixed) return { id: fixed, source: "table" };

    const row = this.ctx.storage.sql
      .exec<TokenRow>("SELECT token_id, source, resolved_at FROM tokens WHERE base = ?", base)
      .toArray()[0];
    if (row) {
      const ttl = row.token_id ? TOKEN_TTL_MS : TOKEN_MISS_TTL_MS;
      if (now - row.resolved_at < ttl) return row.token_id ? { id: row.token_id, source: row.source } : undefined;
    }

    const found = await searchCoinGecko(base);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (base, token_id, source, resolved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(base) DO UPDATE SET token_id = excluded.token_id, source = excluded.source, resolved_at = excluded.resolved_at`,
      base,
      found ?? "",
      "coingecko",
      now,
    );
    return found ? { id: found, source: "coingecko" } : undefined;
  }

  /** Does Arkham see this token at all? Checked with a one-row query, cached per day. */
  private async coverage(
    tokenId: string,
    key: string,
    now: number,
  ): Promise<{ covered: boolean; symbol: string; chains: string[]; credits: number }> {
    const row = this.ctx.storage.sql
      .exec<CoverageRow>("SELECT covered, symbol, chains, checked_at FROM coverage WHERE token_id = ?", tokenId)
      .toArray()[0];
    if (row) {
      const ttl = row.covered ? COVERAGE_TTL_MS : COVERAGE_MISS_TTL_MS;
      if (now - row.checked_at < ttl) {
        return { covered: row.covered === 1, symbol: row.symbol, chains: row.chains ? row.chains.split(",") : [], credits: 0 };
      }
    }

    const page = await this.heavy<TransfersPage>(
      "/transfers",
      { tokens: tokenId, timeLast: "30d", usdGte: String(FETCH_FLOOR_USD), limit: "1" },
      key,
    );
    const rows = Array.isArray(page.transfers) ? page.transfers : [];
    const total = typeof page.count === "number" ? page.count : rows.length;
    const covered = total > 0 || rows.length > 0;
    const symbol = rows[0]?.tokenSymbol ?? "";
    const chains = rows[0]?.chain ? [rows[0].chain] : [];

    this.ctx.storage.sql.exec(
      `INSERT INTO coverage (token_id, covered, symbol, chains, checked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET covered = excluded.covered, symbol = excluded.symbol, chains = excluded.chains, checked_at = excluded.checked_at`,
      tokenId,
      covered ? 1 : 0,
      symbol,
      chains.join(","),
      now,
    );
    return { covered, symbol, chains, credits: rows.length * CREDITS_PER_ROW };
  }

  /* ---------------------------------------------------------------- */
  /* Cache + usage                                                      */
  /* ---------------------------------------------------------------- */

  private scanKey(req: ScanRequest): string {
    return `${req.symbol}:${req.at}:${req.phase}`;
  }

  private cachedRead(key: string, phase: OnChainPhase, now: number): OnChainRead | undefined {
    const ttl = phase === "final" ? FINAL_TTL_MS : EARLY_TTL_MS;
    const hot = this.mem.get(key);
    if (hot && now - hot.scannedAt < ttl) return hot;

    const row = this.ctx.storage.sql
      .exec<ScanRow>("SELECT payload, created_at FROM scans WHERE key = ?", key)
      .toArray()[0];
    if (!row || now - row.created_at >= ttl) return undefined;
    try {
      const read = JSON.parse(row.payload) as OnChainRead;
      this.mem.set(key, read);
      return read;
    } catch {
      return undefined;
    }
  }

  private store(req: ScanRequest, read: OnChainRead, now: number): void {
    const key = this.scanKey(req);
    this.mem.set(key, read);
    if (this.mem.size > 500) {
      const oldest = this.mem.keys().next().value;
      if (oldest !== undefined) this.mem.delete(oldest);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO scans (key, symbol, at, phase, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
      key,
      req.symbol,
      req.at,
      req.phase,
      JSON.stringify(read),
      now,
    );
    this.ctx.storage.sql.exec("DELETE FROM scans WHERE created_at < ?", now - FINAL_TTL_MS);
  }

  private usage(day: string): UsageRow {
    const row = this.ctx.storage.sql
      .exec<UsageRow>("SELECT credits, scans, failures, last_error, last_error_at FROM usage WHERE day = ?", day)
      .toArray()[0];
    return row ?? { credits: 0, scans: 0, failures: 0, last_error: null, last_error_at: null };
  }

  private recordUsage(day: string, credits: number, scans: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO usage (day, credits, scans, failures) VALUES (?, ?, ?, 0)
       ON CONFLICT(day) DO UPDATE SET credits = credits + excluded.credits, scans = scans + excluded.scans`,
      day,
      credits,
      scans,
    );
    this.ctx.storage.sql.exec("DELETE FROM usage WHERE day < ?", utcDay(Date.now() - 60 * 24 * 60 * 60_000));
  }

  private recordFailure(day: string, message: string, at: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO usage (day, credits, scans, failures, last_error, last_error_at) VALUES (?, 0, 0, 1, ?, ?)
       ON CONFLICT(day) DO UPDATE SET failures = failures + 1, last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
      day,
      message.slice(0, 300),
      at,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Config                                                             */
  /* ---------------------------------------------------------------- */

  private apiKey(): string {
    return (this.env.ARKHAM_API_KEY ?? "").trim();
  }

  private configured(): boolean {
    return this.apiKey().length > 0;
  }

  private creditCap(): number {
    const n = Number(this.env.ONCHAIN_DAILY_CREDIT_CAP);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_CREDIT_CAP;
  }

  private scanLimit(): number {
    const n = Number(this.env.ONCHAIN_SCAN_LIMIT);
    return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.round(n)) : DEFAULT_SCAN_LIMIT;
  }
}
