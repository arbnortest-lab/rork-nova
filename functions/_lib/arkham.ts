/**
 * Minimal Arkham Intel API client.
 *
 * One function, one error type. Every failure is mapped to an `OnChainReason`
 * so the scanner can decide whether a retry could help, and the API key never
 * appears in a log line or an error message.
 */

import type { OnChainReason } from "./types";

export const ARKHAM_BASE = "https://api.arkm.com";

const RETRYABLE: ReadonlySet<OnChainReason> = new Set(["rate-limited", "timeout", "upstream", "network"]);

export class ArkhamError extends Error {
  readonly reason: OnChainReason;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(reason: OnChainReason, message: string, status?: number) {
    super(message);
    this.name = "ArkhamError";
    this.reason = reason;
    this.status = status;
    this.retryable = RETRYABLE.has(reason);
  }
}

export function reasonForStatus(status: number): OnChainReason {
  if (status === 401) return "bad-key";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 404 || status === 422) return "bad-request";
  return "upstream";
}

function describeFailure(status: number, body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") detail = parsed.message;
  } catch {
    if (/attention required|cf-error|cloudflare/i.test(body)) detail = "blocked by Arkham's edge (Cloudflare challenge)";
    else detail = body.replace(/\s+/g, " ").trim().slice(0, 160);
  }
  if (status === 401) return `Arkham rejected the API key (HTTP 401${detail ? ` — ${detail}` : ""})`;
  if (status === 403) return `Arkham refused the request (HTTP 403${detail ? ` — ${detail}` : ""}). Usually the plan lacks this endpoint or the credit cap is reached.`;
  if (status === 429) return "Arkham rate limit hit (HTTP 429)";
  return `Arkham HTTP ${status}${detail ? ` — ${detail}` : ""}`;
}

/** GET an Arkham endpoint and parse its JSON body. Throws `ArkhamError` only. */
export async function arkhamGet<T>(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  timeoutMs: number,
): Promise<T> {
  const url = new URL(path, ARKHAM_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "API-Key": apiKey,
        Accept: "application/json",
        "User-Agent": "NovaDCAPro-OnChain/1.0",
      },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new ArkhamError(
      aborted ? "timeout" : "network",
      aborted
        ? `Arkham did not answer within ${Math.round(timeoutMs / 1000)}s`
        : `Arkham unreachable: ${err instanceof Error ? err.message : "fetch failed"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ArkhamError(reasonForStatus(res.status), describeFailure(res.status, body), res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ArkhamError("upstream", "Arkham returned a body that is not JSON", res.status);
  }
}
