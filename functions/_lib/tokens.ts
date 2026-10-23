/**
 * Binance contract symbol → Arkham token id.
 *
 * Arkham keys tokens by CoinGecko pricing id, so the static table is a
 * ticker → pricing-id map and CoinGecko's free search is the fallback for
 * anything the table does not know.
 */

import { TOKEN_IDS } from "./token-ids";

const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "USD"];
const MULTIPLIERS = ["1000000", "100000", "10000", "1000", "1M"];

/** `1000PEPEUSDT` → `PEPE`, `BTCUSDT` → `BTC`, `1INCHUSDT` → `1INCH`. */
export function baseAssetOf(symbol: string): string {
  let s = symbol.trim().toUpperCase();
  for (const q of QUOTES) {
    if (s.length > q.length + 1 && s.endsWith(q)) {
      s = s.slice(0, -q.length);
      break;
    }
  }
  if (TOKEN_IDS[s]) return s;
  for (const m of MULTIPLIERS) {
    if (s.startsWith(m) && s.length - m.length >= 2) return s.slice(m.length);
  }
  return s;
}

export function staticTokenId(base: string): string | undefined {
  return TOKEN_IDS[base.toUpperCase()];
}

interface CoinGeckoSearch {
  coins?: { id?: string; symbol?: string; market_cap_rank?: number | null }[] | null;
}

/** Highest-ranked CoinGecko coin whose ticker matches exactly, if any. */
export function pickCoinGeckoMatch(payload: CoinGeckoSearch, base: string): string | undefined {
  const want = base.toUpperCase();
  const hits = (payload.coins ?? [])
    .filter((c): c is { id: string; symbol: string; market_cap_rank?: number | null } =>
      typeof c?.id === "string" && typeof c?.symbol === "string" && c.symbol.toUpperCase() === want,
    )
    .sort((a, b) => (a.market_cap_rank ?? Number.MAX_SAFE_INTEGER) - (b.market_cap_rank ?? Number.MAX_SAFE_INTEGER));
  return hits[0]?.id;
}

export async function searchCoinGecko(base: string, timeoutMs = 8_000): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(base)}`, {
      headers: { Accept: "application/json", "User-Agent": "NovaDCAPro-OnChain/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[onchain] coingecko search ${base}: HTTP ${res.status}`);
      return undefined;
    }
    return pickCoinGeckoMatch((await res.json()) as CoinGeckoSearch, base);
  } catch (err) {
    console.warn(`[onchain] coingecko search ${base} failed: ${err instanceof Error ? err.message : "unknown"}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
