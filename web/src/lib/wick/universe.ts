/**
 * Which contracts the terminal tracks.
 *
 * NOVAEXHAUSTION V2 monitors exactly two instruments: BTCUSDT and USDCUSDT.
 * Every other contract is dropped before it is scored, ranked, alerted on or
 * shown, and no coin selector exists anywhere in the app.
 *
 * The historical $0.001–$7.00 band helpers are kept — the band test still runs
 * on every pass and stored records are still pruned with it — but membership
 * of the fixed two-instrument list is the whole rule now.
 *
 * Pure module: no engine imports, so it can be read by scripts and tests.
 */

export const BITCOIN_SYMBOL = "BTCUSDT";
export const USDC_SYMBOL = "USDCUSDT";

/** The complete instrument list of the terminal. */
export const TRACKED_SYMBOLS: readonly string[] = [BITCOIN_SYMBOL, USDC_SYMBOL];

/** Exclusive lower bound of the legacy altcoin price band, in USD. */
export const PRICE_BAND_MIN = 0.001;
/** Exclusive upper bound of the legacy altcoin price band, in USD. */
export const PRICE_BAND_MAX = 7;

export const PRICE_BAND_LABEL = "$0.001–$7.00";
export const UNIVERSE_LABEL = "BTCUSDT · USDCUSDT";

export type BandPosition = "inside" | "below" | "above" | "unpriced";

/** Where a price sits relative to the legacy band. `unpriced` for 0, negative or non-finite. */
export function bandPosition(last: number): BandPosition {
  if (!Number.isFinite(last) || last <= 0) return "unpriced";
  if (last <= PRICE_BAND_MIN) return "below";
  if (last >= PRICE_BAND_MAX) return "above";
  return "inside";
}

/** Strictly inside the legacy band: the bounds themselves are out. */
export function inPriceBand(last: number): boolean {
  return bandPosition(last) === "inside";
}

/** The instrument list is the universe; the price is irrelevant to membership. */
export function isTracked(symbol: string, _last: number): boolean {
  return isTrackedSymbol(symbol);
}

/** Case-insensitive membership of the fixed two-instrument list. */
export function isTrackedSymbol(symbol: string): boolean {
  return TRACKED_SYMBOLS.includes(symbol.toUpperCase());
}

/**
 * Drops stored records raised on contracts the terminal no longer tracks,
 * judged by the price recorded with them. Records without a usable price are
 * kept: a missing number is not evidence of anything.
 */
export function pruneUntracked<T extends { symbol: string; price: number }>(items: T[]): T[] {
  return items.filter((item) => !(item.price > 0) || isTracked(item.symbol, item.price));
}
