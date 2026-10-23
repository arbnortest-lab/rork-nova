/** Adaptive decimal precision — crypto prices span 6 orders of magnitude. */
export function priceDecimals(value: number): number {
  const v = Math.abs(value);
  if (v === 0) return 2;
  if (v >= 100) return 2;
  if (v >= 1) return 4;
  if (v >= 0.1) return 5;
  if (v >= 0.01) return 6;
  if (v >= 0.000001) return 8;
  return 10;
}

/**
 * A tick that is ~0.1% of the price, snapped down to a clean 1/2/5 decade step
 * and never finer than the displayed precision. Keeps arrow-key nudges useful
 * on a $63,000 asset and on a $0.015 one alike.
 */
export function priceStep(value: number): number {
  const v = Math.abs(value);
  if (!(v > 0)) return 1;
  const target = v * 0.001;
  const decade = 10 ** Math.floor(Math.log10(target));
  const mantissa = target / decade;
  const snapped = (mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1) * decade;
  return Math.max(snapped, 10 ** -priceDecimals(v));
}

export function fmtPrice(value: number | undefined | null, forced?: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const dp = forced ?? priceDecimals(value);
  return value.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtUsd(value: number | undefined | null, dp = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function fmtSignedUsd(value: number | undefined | null, dp = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function fmtPct(value: number | undefined | null, dp = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(dp)}%`;
}

export function fmtSignedPct(value: number | undefined | null, dp = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(dp)}%`;
}

export function fmtQty(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.001) return value.toFixed(6);
  return value.toExponential(3);
}

/** Tailwind text colour for a signed value. */
export function toneFor(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-pos" : "text-neg";
}

/** Turnover at a glance: `$1.24B`, `$12.4M`, `$840K`. */
export function fmtCompactUsd(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Coarse relative time for log lines. Never negative, never "in 3s". */
export function timeAgo(ts: number | undefined | null, now: number = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Wall-clock stamp for feed rows. */
export function fmtClock(ts: number | undefined | null): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDate(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
