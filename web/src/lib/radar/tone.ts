/** Display tones shared by the radar gauges and tables. */

import type { OiTrend, SqueezeLevel } from "./types";

export type RadarTone = "pos" | "neg" | "warn" | "muted";

export const SQUEEZE_TONE: Record<SqueezeLevel, "muted" | "warn" | "neg"> = {
  cold: "muted",
  warm: "warn",
  hot: "neg",
};

export const OI_TREND_LABEL: Record<OiTrend, string> = {
  rising: "RISING ▲",
  falling: "FALLING ▼",
  flat: "FLAT —",
  unknown: "—",
};

export function oiTone(trend: OiTrend): "pos" | "neg" | "muted" {
  return trend === "rising" ? "pos" : trend === "falling" ? "neg" : "muted";
}

export const TEXT_TONE: Record<RadarTone, string> = {
  pos: "text-pos",
  neg: "text-neg",
  warn: "text-warn",
  muted: "text-muted-foreground",
};
