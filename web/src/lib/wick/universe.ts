/**
 * Which contracts the project tracks.
 *
 * The scanner is deliberately narrow: Bitcoin, plus altcoins whose last price
 * sits strictly inside the $0.001–$7.00 band. Everything else is dropped
 * before it is scored, ranked, alerted on or shown.
 *
 * The test runs on every pass against the live ticker, so a contract that
 * leaves the band leaves the scanner on the next tick and comes back only once
 * its price is inside the band again. The price is the contract's own quote —
 * for multiplied contracts such as 1000PEPEUSDT that is the ×1000 price the
 * chart trades at, not the underlying token's.
 *
 * Pure module: no engine imports, so it can be read by scripts and tests.
 */

export const BITCOIN_SYMBOL = "BTCUSDT";
/** Exclusive lower bound of the altcoin price band, in USD. */
export const PRICE_BAND_MIN = 0.001;
/** Exclusive upper bound of the altcoin price band, in USD. */
export const PRICE_BAND_MAX = 7;

export const PRICE_BAND_LABEL = "$0.001–$7.00";
export const UNIVERSE_LABEL = `BTC + alts ${PRICE_BAND_LABEL}`;

export type BandPosition = "inside" | "below" | "above" | "unpriced";

/** Where a price sits relative to the band. `unpriced` for 0, negative or non-finite. */
export function bandPosition(last: number): BandPosition {
  if (!Number.isFinite(last) || last <= 0) return "unpriced";
  if (last <= PRICE_BAND_MIN) return "below";
  if (last >= PRICE_BAND_MAX) return "above";
  return "inside";
}

/** Strictly inside the band: the bounds themselves are out. */
export function inPriceBand(last: number): boolean {
  return bandPosition(last) === "inside";
}

/** Bitcoin always; any other contract only while its price is inside the band. */
export function isTracked(symbol: string, last: number): boolean {
  return symbol === BITCOIN_SYMBOL || inPriceBand(last);
}

/**
 * Drops stored records raised on contracts the project no longer tracks, judged
 * by the price recorded with them. Records without a usable price are kept:
 * a missing number is not evidence of anything.
 */
export function pruneUntracked<T extends { symbol: string; price: number }>(items: T[]): T[] {
  return items.filter((item) => !(item.price > 0) || isTracked(item.symbol, item.price));
}
