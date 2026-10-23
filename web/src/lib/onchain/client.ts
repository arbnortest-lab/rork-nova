/**
 * Browser client for the on-chain scan backend.
 *
 * Every call resolves — nothing here throws — so a caller can never crash on
 * a backend that is down, undeployed or answering with HTML. Failures carry
 * a reason and a `retryable` flag, which is all the scheduler needs.
 *
 * The backend is reached on the page's own origin through `/~api`, so there
 * is no CORS and no credential leaves the browser: the Arkham key lives on
 * the server only.
 */

import type { OnChainRead, OnChainReason, ScanRequest, ScannerStatus, VerifyResult } from "./types";

export const ONCHAIN_PATH = "/~api/onchain";

export type ScanOutcome =
  | { kind: "read"; read: OnChainRead }
  | { kind: "pending"; position: number; queue: number }
  | { kind: "failed"; reason: OnChainReason; message: string; retryable: boolean };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  base?: string;
}

/** `fetch` must be called on `window`; an unbound alias throws "Illegal invocation". */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function failed(reason: OnChainReason, message: string, retryable: boolean): ScanOutcome {
  return { kind: "failed", reason, message, retryable };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRead(body: unknown): body is OnChainRead {
  return Boolean(body) && typeof body === "object" && (body as { version?: unknown }).version === 1;
}

/** Maps one HTTP answer from `/onchain/scan` to a scan outcome. */
export async function outcomeOf(res: Response): Promise<ScanOutcome> {
  const text = await res.text().catch(() => "");
  const body = parseJson(text) as { error?: unknown; position?: unknown; queue?: unknown } | undefined;

  if (res.status === 202) {
    return { kind: "pending", position: num(body?.position) ?? 0, queue: num(body?.queue) ?? 0 };
  }

  if (res.ok) {
    if (isRead(body)) return { kind: "read", read: body };
    return failed(
      "upstream",
      "Backend answered, but not with a scan. The add-on only works when the app is served through Rork hosting.",
      true,
    );
  }

  const message = typeof body?.error === "string" ? body.error : `Backend HTTP ${res.status}`;
  if (res.status === 400) return failed("bad-request", message, false);
  if (res.status === 403) return failed("forbidden", message, false);
  if (res.status === 429) return failed("rate-limited", message, true);
  if (res.status === 503 && /no bundle/i.test(text)) return failed("upstream", "Backend is not deployed yet", true);
  return failed("upstream", message, true);
}

/** POSTs a scan request. Resolves with an outcome in every case. */
export async function requestScan(req: ScanRequest, opts: ClientOptions = {}): Promise<ScanOutcome> {
  const { timeoutMs = 28_000, fetchImpl = defaultFetch, base = ONCHAIN_PATH } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return failed(
      aborted ? "timeout" : "network",
      aborted ? `Backend did not answer within ${Math.round(timeoutMs / 1000)}s` : "Backend unreachable",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  return outcomeOf(res);
}

/** Backend self-report; `undefined` when it cannot be reached. */
export async function fetchStatus(opts: ClientOptions = {}): Promise<ScannerStatus | undefined> {
  const { timeoutMs = 10_000, fetchImpl = defaultFetch, base = ONCHAIN_PATH } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/status`, { signal: controller.signal });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<ScannerStatus>;
    if (typeof body?.configured !== "boolean" || !body.today) return undefined;
    return body as ScannerStatus;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Proves the Arkham key with a free endpoint. Never throws. */
export async function verifyKey(opts: ClientOptions = {}): Promise<VerifyResult> {
  const { timeoutMs = 20_000, fetchImpl = defaultFetch, base = ONCHAIN_PATH } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/verify`, { method: "POST", signal: controller.signal });
    const text = await res.text().catch(() => "");
    const body = parseJson(text) as Partial<VerifyResult> | undefined;
    if (body && typeof body.ok === "boolean" && typeof body.message === "string") return body as VerifyResult;
    if (res.status === 503 && /no bundle/i.test(text)) {
      return { ok: false, reason: "upstream", message: "Backend is not deployed yet" };
    }
    return { ok: false, reason: "upstream", message: `Backend answered HTTP ${res.status} without a verdict` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "network", message: aborted ? "Verify timed out" : "Backend unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
