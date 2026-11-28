/**
 * Defaults, parameter schema, presets and sanitisers for the Liquidity
 * Exhaustion Engine configuration.
 *
 * `WICK_PARAMS` is the single source of truth for every tunable value: the
 * Config panel builds its sliders and numeric inputs from it, the presets are
 * validated against it, and `sanitizeWickRules` clamps with it before anything
 * reaches the scanner. The UI and the engine therefore can never disagree on a
 * range.
 *
 * This module deliberately imports nothing but types, so the PDF build script
 * can read the live thresholds without pulling in the browser-side engine.
 */

import type { WickRules } from "./types";

/** Bars behind the "higher high" half of the trap test. */
export const TRAP_LOOKBACK = 12;
/** How many of the newest bars may carry the rejection. Keeps the trap recent. */
export const TRAP_SCAN = 3;
/** Bars behind the relative-volume baseline. */
export const RVOL_LOOKBACK = 96;

/**
 * Widest liquidity horizon, in daily bars. Binance caps one klines request at
 * 1500 bars and gate 4 discards the in-progress day, so four years fits in a
 * single call. Contracts listed more recently simply use every bar they have;
 * the gate's reason text reports the real window.
 */
export const MAX_HORIZON_DAYS = 1_460;

/**
 * Most contracts given full 5m + daily history at once. Each slot costs one
 * 5m klines request every 25s; at 60 slots that is ~290 request weight per
 * minute against the venue's 2400/min budget, leaving room for the ticker poll
 * and the radar. Beyond that the browser starts queueing requests and history
 * goes stale, which silently un-measures gates 3 and 4.
 */
export const MAX_DEEP_WATCH = 60;

export const DEFAULT_WICK_RULES: WickRules = {
  refreshMs: 2_000,
  minVolume: 5_000_000,
  /** Within 5 bps of the 24h extreme counts as pinned. */
  pinBps: 5,
  rvolClimax: 300,
  wickPct: 45,
  depletionPct: 0.5,
  horizonDays: 365,
  deepWatch: 12,
  cooldownMins: 30,
};

/**
 * Quick picks for the header cadence control. Any value in the schema's range
 * (0.5–300s) is valid; these are just one-tap shortcuts.
 */
export const REFRESH_OPTIONS = [
  { value: 1_000, label: "1s" },
  { value: 2_000, label: "2s" },
  { value: 3_000, label: "3s" },
  { value: 5_000, label: "5s" },
] as const;

/* ------------------------------------------------------------------ */
/* Parameter schema                                                    */
/* ------------------------------------------------------------------ */

export type WickParamKey = keyof WickRules;

/**
 * How the slider maps onto the range. Wide ranges use a curve so the low end,
 * where most tuning happens, keeps fine resolution; the numeric input always
 * accepts any exact value in range.
 */
export type SliderCurve = "linear" | "log" | "sqrt";

export interface WickParamSpec {
  key: WickParamKey;
  label: string;
  /** One-line explanation shown under the control. */
  hint: string;
  group: "gates" | "scanner";
  /** Range and step in DISPLAY units (stored value = display × scale). */
  min: number;
  max: number;
  step: number;
  decimals: number;
  /** Suffix in display units, e.g. "bps", "%", "s". */
  unit: string;
  /** Prefix in display units, e.g. "$". */
  prefix?: string;
  /** Stored value = display value × scale. */
  scale: number;
  /** Stored value is a whole number. */
  integer: boolean;
  curve: SliderCurve;
}

export const WICK_PARAMS: readonly WickParamSpec[] = [
  {
    key: "pinBps",
    label: "Pin distance",
    hint: "How close to the 24h high counts as pinned (gate 1).",
    group: "gates",
    min: 0.1,
    max: 1_000,
    step: 0.1,
    decimals: 1,
    unit: "bps",
    scale: 1,
    integer: false,
    curve: "log",
  },
  {
    key: "rvolClimax",
    label: "Volume climax",
    hint: "Relative volume vs the 8h baseline that counts as a climax (gate 2).",
    group: "gates",
    min: 100,
    max: 10_000,
    step: 1,
    decimals: 0,
    unit: "%",
    scale: 1,
    integer: false,
    curve: "log",
  },
  {
    key: "wickPct",
    label: "Rejection wick",
    hint: "Upper wick as a share of the candle range on the failed high (gate 3).",
    group: "gates",
    min: 1,
    max: 100,
    step: 0.5,
    decimals: 1,
    unit: "%",
    scale: 1,
    integer: false,
    curve: "linear",
  },
  {
    key: "depletionPct",
    label: "Depletion band",
    hint: "Distance to the long-horizon high that counts as swept (gate 4).",
    group: "gates",
    min: 0,
    max: 25,
    step: 0.01,
    decimals: 2,
    unit: "%",
    scale: 1,
    integer: false,
    curve: "sqrt",
  },
  {
    key: "horizonDays",
    label: "Liquidity horizon",
    hint: "Trading days behind the long-horizon high used by gate 4.",
    group: "gates",
    min: 30,
    max: MAX_HORIZON_DAYS,
    step: 1,
    decimals: 0,
    unit: "d",
    scale: 1,
    integer: true,
    curve: "log",
  },
  {
    key: "refreshMs",
    label: "Scan cadence",
    hint: "How often every contract is re-scored. Local work only — no extra venue calls.",
    group: "scanner",
    min: 0.5,
    max: 300,
    step: 0.1,
    decimals: 1,
    unit: "s",
    scale: 1_000,
    integer: true,
    curve: "log",
  },
  {
    key: "deepWatch",
    label: "History slots",
    hint: `Contracts kept on full candle history (max ${MAX_DEEP_WATCH}, set by the venue's rate limit).`,
    group: "scanner",
    min: 2,
    max: MAX_DEEP_WATCH,
    step: 1,
    decimals: 0,
    unit: "",
    scale: 1,
    integer: true,
    curve: "linear",
  },
  {
    key: "minVolume",
    label: "Min 24h turnover",
    hint: "Contracts trading less than this in 24h are skipped. 0 = any.",
    group: "scanner",
    min: 0,
    max: 5_000,
    step: 0.1,
    decimals: 1,
    unit: "M",
    prefix: "$",
    scale: 1_000_000,
    integer: false,
    curve: "sqrt",
  },
  {
    key: "cooldownMins",
    label: "Cooldown",
    hint: "Minimum gap between two alerts on the same contract. 0 = re-arm only.",
    group: "scanner",
    min: 0,
    max: 10_080,
    step: 0.5,
    decimals: 1,
    unit: "min",
    scale: 1,
    integer: false,
    curve: "sqrt",
  },
] as const;

export const WICK_PARAM_BY_KEY: Readonly<Record<WickParamKey, WickParamSpec>> = Object.fromEntries(
  WICK_PARAMS.map((p) => [p.key, p]),
) as Record<WickParamKey, WickParamSpec>;

/** Stored value → display value. */
export function toDisplay(spec: WickParamSpec, stored: number): number {
  return stored / spec.scale;
}

/** Display value → stored value, rounded the way the engine stores it. */
export function fromDisplay(spec: WickParamSpec, display: number): number {
  const stored = display * spec.scale;
  return spec.integer ? Math.round(stored) : roundTo(stored, spec.decimals - Math.log10(spec.scale));
}

function roundTo(n: number, decimals: number): number {
  const d = Math.max(0, Math.min(10, Math.round(decimals)));
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

const ATTACHED_UNITS = new Set(["%", "s", "d", "M"]);

/** Display value formatted with its unit, e.g. "5.0 bps", "$5.0M", "2.0s". */
export function formatParam(spec: WickParamSpec, stored: number): string {
  const shown = toDisplay(spec, stored).toFixed(spec.decimals);
  const unit = spec.unit === "" ? "" : ATTACHED_UNITS.has(spec.unit) ? spec.unit : ` ${spec.unit}`;
  return `${spec.prefix ?? ""}${shown}${unit}`;
}

/* --- slider curve: position 0..SLIDER_STEPS ↔ display value --- */

export const SLIDER_STEPS = 1_000;

export function valueToSlider(spec: WickParamSpec, display: number): number {
  const { min, max } = spec;
  const v = Math.min(max, Math.max(min, display));
  let t: number;
  if (spec.curve === "log" && min > 0) t = Math.log(v / min) / Math.log(max / min);
  else if (spec.curve === "sqrt") t = Math.sqrt((v - min) / (max - min));
  else t = (v - min) / (max - min);
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_STEPS);
}

export function sliderToValue(spec: WickParamSpec, position: number): number {
  const { min, max, step } = spec;
  const t = Math.min(1, Math.max(0, position / SLIDER_STEPS));
  let v: number;
  if (spec.curve === "log" && min > 0) v = min * (max / min) ** t;
  else if (spec.curve === "sqrt") v = min + (max - min) * t * t;
  else v = min + (max - min) * t;
  // Snap to the step, then to a tidy number of significant figures so a log
  // slider reads 250 rather than 251.37.
  const snapped = Math.round(v / step) * step;
  const tidy = snapped >= 100 ? Number(snapped.toPrecision(3)) : snapped;
  return roundTo(Math.min(max, Math.max(min, tidy)), spec.decimals);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type ParamCheck = { ok: true; stored: number } | { ok: false; error: string };

/**
 * Validates text typed into a parameter's numeric input, in display units.
 * Out-of-range values are rejected with a message rather than silently
 * clamped, so the trader always knows what the engine is actually using.
 */
export function validateParamInput(spec: WickParamSpec, text: string): ParamCheck {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return { ok: false, error: "Enter a number" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: "Not a number" };
  if (n < spec.min || n > spec.max) {
    return {
      ok: false,
      error: `Must be ${spec.prefix ?? ""}${spec.min}–${spec.prefix ?? ""}${spec.max}${spec.unit === "" ? "" : ` ${spec.unit}`}`,
    };
  }
  return { ok: true, stored: fromDisplay(spec, n) };
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export type WickPresetId = "conservative" | "balanced" | "aggressive" | "early";

export interface WickPreset {
  id: WickPresetId;
  label: string;
  description: string;
  /** Gate values only: scanner settings (cadence, slots, turnover) are left as the user set them. */
  gates: Pick<WickRules, "pinBps" | "rvolClimax" | "wickPct" | "depletionPct" | "horizonDays" | "cooldownMins">;
}

export const WICK_PRESETS: readonly WickPreset[] = [
  {
    id: "conservative",
    label: "Conservative",
    description: "Fewer, cleaner alerts: tight pin, big climax, deep rejection, 1-year high.",
    gates: { pinBps: 2, rvolClimax: 500, wickPct: 60, depletionPct: 0.25, horizonDays: 365, cooldownMins: 120 },
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "The engine's defaults.",
    gates: {
      pinBps: DEFAULT_WICK_RULES.pinBps,
      rvolClimax: DEFAULT_WICK_RULES.rvolClimax,
      wickPct: DEFAULT_WICK_RULES.wickPct,
      depletionPct: DEFAULT_WICK_RULES.depletionPct,
      horizonDays: DEFAULT_WICK_RULES.horizonDays,
      cooldownMins: DEFAULT_WICK_RULES.cooldownMins,
    },
  },
  {
    id: "aggressive",
    label: "Aggressive",
    description: "More alerts: looser pin and climax, shallower wick, 6-month high.",
    gates: { pinBps: 15, rvolClimax: 200, wickPct: 35, depletionPct: 1.5, horizonDays: 180, cooldownMins: 15 },
  },
  {
    id: "early",
    label: "Early Detection",
    description: "Flags setups forming: wide pin, modest climax, light wick, 90-day high.",
    gates: { pinBps: 40, rvolClimax: 150, wickPct: 25, depletionPct: 3, horizonDays: 90, cooldownMins: 5 },
  },
] as const;

/** Applies a preset's gate values on top of the current scanner settings. */
export function applyPreset(current: WickRules, id: WickPresetId): WickRules {
  const preset = WICK_PRESETS.find((p) => p.id === id);
  if (!preset) return sanitizeWickRules(current);
  return sanitizeWickRules({ ...current, ...preset.gates });
}

/** The preset whose gate values the rules match exactly, or "custom". */
export function matchPreset(rules: WickRules): WickPresetId | "custom" {
  for (const preset of WICK_PRESETS) {
    const gates = preset.gates as Record<string, number>;
    if (Object.keys(gates).every((k) => rules[k as WickParamKey] === gates[k])) return preset.id;
  }
  return "custom";
}

/* ------------------------------------------------------------------ */
/* Saved custom configurations                                         */
/* ------------------------------------------------------------------ */

export interface SavedWickConfig {
  name: string;
  savedAt: number;
  rules: WickRules;
}

export const MAX_SAVED_CONFIGS = 20;
export const MAX_CONFIG_NAME = 40;

/** Coerces a persisted list of saved configs: drops broken entries, re-clamps every rule set. */
export function sanitizeSavedConfigs(raw: unknown): SavedWickConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedWickConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, MAX_CONFIG_NAME) : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      savedAt: typeof o.savedAt === "number" && Number.isFinite(o.savedAt) ? o.savedAt : 0,
      rules: sanitizeWickRules(o.rules),
    });
    if (out.length >= MAX_SAVED_CONFIGS) break;
  }
  return out;
}

/** Adds or replaces (by case-insensitive name) a saved config, newest first. */
export function upsertSavedConfig(
  list: SavedWickConfig[],
  name: string,
  rules: WickRules,
  now: number = Date.now(),
): SavedWickConfig[] {
  const clean = name.trim().slice(0, MAX_CONFIG_NAME);
  if (!clean) return list;
  const rest = list.filter((c) => c.name.toLowerCase() !== clean.toLowerCase());
  return [{ name: clean, savedAt: now, rules: sanitizeWickRules(rules) }, ...rest].slice(0, MAX_SAVED_CONFIGS);
}

/* ------------------------------------------------------------------ */
/* Sanitiser                                                           */
/* ------------------------------------------------------------------ */

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerces persisted configuration back into range using `WICK_PARAMS`. A
 * stored value from an older build, or a hand-edited localStorage entry, can
 * never put the engine into a state it does not support. Every value an older
 * build could store is inside the current ranges, so existing configs load
 * unchanged.
 */
export function sanitizeWickRules(raw: unknown): WickRules {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_WICK_RULES };
  const r = raw as Partial<Record<WickParamKey, unknown>>;
  const out = { ...DEFAULT_WICK_RULES };
  for (const spec of WICK_PARAMS) {
    const min = spec.min * spec.scale;
    const max = spec.max * spec.scale;
    const v = clampNum(r[spec.key], min, max, DEFAULT_WICK_RULES[spec.key]);
    out[spec.key] = spec.integer ? Math.round(v) : v;
  }
  return out;
}
