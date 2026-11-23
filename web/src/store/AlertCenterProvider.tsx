/**
 * Alert Center — one centralized feed for every monitored condition,
 * categorised exactly as the specification lists them. The existing
 * exhaustion alert conditions and cooldown logic are untouched: this layer
 * observes the exhaustions engine's published alerts and adds independent
 * categories around them (wick, squeeze, wall, whale, open interest,
 * funding, liquidation).
 *
 * Every alert carries a timestamp, instrument, signal type and the source
 * data. Categories can be toggled individually; thresholds are user-tunable
 * and persisted; browser notifications and the chime reuse the existing
 * delivery helpers. Nothing here feeds back into any engine.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { toast } from "@/components/ui/sonner";
import { playWickChime, showDesktop } from "@/lib/wick/notify";
import type { WickAlert } from "@/lib/wick/types";
import { loadState, saveState, uid } from "@/lib/storage";
import { fmtCompactUsd, fmtSignedPct } from "@/lib/format";
import { useInstruments } from "@/store/InstrumentsProvider";
import { useWick } from "@/store/WickProvider";

export type AlertCategory =
  | "wick"
  | "exhaustion"
  | "squeeze"
  | "wall"
  | "whale"
  | "oi"
  | "funding"
  | "liquidation";

export const ALERT_CATEGORIES: { value: AlertCategory; label: string }[] = [
  { value: "wick", label: "Wick signals" },
  { value: "exhaustion", label: "Exhaustion" },
  { value: "squeeze", label: "Squeeze" },
  { value: "wall", label: "Liquidity walls" },
  { value: "whale", label: "Whale activity" },
  { value: "oi", label: "Open interest" },
  { value: "funding", label: "Funding" },
  { value: "liquidation", label: "Liquidations" },
];

export interface TerminalAlert {
  id: string;
  category: AlertCategory;
  symbol: string;
  /** Short signal type, e.g. "UPPER WICK", "SQUEEZE HOT", "WHALE BUY". */
  type: string;
  title: string;
  /** One line of source data behind the alert. */
  detail: string;
  at: number;
  seen: boolean;
}

export interface AlertThresholds {
  /** Squeeze volume (USD) that fires the squeeze category. */
  squeezeWarm: number;
  /** Single liquidation notional (USD) that fires the liquidation category. */
  liquidationNotional: number;
  /** |open-interest 5-minute change| in percent. */
  oiChangePct: number;
  /** |funding rate| in percent. */
  fundingPct: number;
  /** Whale print notional (USD) — 0 uses each instrument's dynamic whale line. */
  whaleNotional: number;
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  squeezeWarm: 0,
  liquidationNotional: 10_000,
  oiChangePct: 0.5,
  fundingPct: 0.03,
  whaleNotional: 0,
};

interface AlertPrefs {
  categories: Record<AlertCategory, boolean>;
  sound: boolean;
  desktop: boolean;
  thresholds: AlertThresholds;
}

const DEFAULT_PREFS: AlertPrefs = {
  categories: {
    wick: true,
    exhaustion: true,
    squeeze: true,
    wall: true,
    whale: false,
    oi: false,
    funding: false,
    liquidation: true,
  },
  sound: true,
  desktop: true,
  thresholds: DEFAULT_THRESHOLDS,
};

const ALERTS_KEY = "alert-center-v2";
const ALERTS_MAX = 500;
const PREFS_KEY = "alert-center-prefs-v2";

/** `showDesktop` speaks the engine's alert shape; wrap a terminal alert in it. */
function asWickAlert(a: TerminalAlert): WickAlert {
  return { id: a.id, symbol: a.symbol, side: "short", conviction: 0, price: 0, extreme: 0, reasons: [a.title], at: a.at, seen: false };
}

interface AlertCenterValue {
  alerts: TerminalAlert[];
  unseen: number;
  markAllSeen: () => void;
  clear: () => void;
  prefs: AlertPrefs;
  toggleCategory: (c: AlertCategory) => void;
  setChannel: (channel: "sound" | "desktop", on: boolean) => void;
  patchThresholds: (patch: Partial<AlertThresholds>) => void;
  test: () => void;
}

const AlertCenterContext = createContext<AlertCenterValue | null>(null);

function loadPrefs(): AlertPrefs {
  const raw = loadState<Partial<AlertPrefs>>(PREFS_KEY, {});
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };
  return {
    categories: { ...DEFAULT_PREFS.categories, ...(raw.categories ?? {}) },
    sound: raw.sound ?? true,
    desktop: raw.desktop ?? true,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
  };
}

export function AlertCenterProvider({ children }: { children: ReactNode }) {
  const { signals, reads: instrumentReads, now } = useInstruments();
  const { alerts: exhaustionAlerts } = useWick();

  const [alerts, setAlerts] = useState<TerminalAlert[]>(() => {
    const raw = loadState<TerminalAlert[]>(ALERTS_KEY, []);
    return Array.isArray(raw) ? raw.slice(0, ALERTS_MAX) : [];
  });
  const [prefs, setPrefs] = useState<AlertPrefs>(loadPrefs);

  const alertsRef = useRef(alerts);
  const prefsRef = useRef(prefs);
  const exhaustionSeenRef = useRef<Set<string>>(new Set());
  const signalSeenRef = useRef<Set<string>>(new Set());
  const squeezeLevelRef = useRef<Map<string, number>>(new Map());
  const wallRef = useRef<Map<string, number>>(new Map());
  const oiRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    alertsRef.current = alerts;
  }, [alerts]);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const push = useCallback((alert: TerminalAlert) => {
    const p = prefsRef.current;
    const next = [alert, ...alertsRef.current].slice(0, ALERTS_MAX);
    alertsRef.current = next;
    setAlerts(next);
    saveState(ALERTS_KEY, next);
    if (p.sound) playWickChime();
    if (p.desktop) showDesktop(asWickAlert(alert));
    toast(`${alert.symbol} — ${alert.type}`, { description: alert.title });
  }, []);

  const pushMany = useCallback(
    (incoming: TerminalAlert[]) => {
      if (!incoming.length) return;
      const enabled = prefsRef.current.categories;
      const fresh = incoming.filter((a) => enabled[a.category]);
      if (!fresh.length) return;
      const next = [...fresh, ...alertsRef.current].slice(0, ALERTS_MAX);
      alertsRef.current = next;
      setAlerts(next);
      saveState(ALERTS_KEY, next);
      const p = prefsRef.current;
      const first = fresh[fresh.length - 1];
      if (p.sound) playWickChime();
      if (p.desktop) showDesktop(asWickAlert(first));
    },
    [],
  );

  /* Watchers: each source contributes alerts, deduped by its own key. */

  useEffect(() => {
    // 1 — exhaustion alerts relayed from the untouched engine feed.
    const incoming: TerminalAlert[] = [];
    for (const a of exhaustionAlerts) {
      if (exhaustionSeenRef.current.has(a.id)) continue;
      exhaustionSeenRef.current.add(a.id);
      incoming.push({
        id: `ex:${a.id}`,
        category: "exhaustion",
        symbol: a.symbol,
        type: "EXHAUSTION",
        title: a.reasons[0] ?? "All four gates passed",
        detail: `price ${fmtCompactUsd(a.price)} · conviction ${a.conviction}`,
        at: a.at,
        seen: false,
      });
    }
    pushMany(incoming);
  }, [exhaustionAlerts, pushMany]);

  useEffect(() => {
    // 2 — wick signals from the 1H monitor.
    const incoming: TerminalAlert[] = [];
    for (const s of signals) {
      if (signalSeenRef.current.has(s.id)) continue;
      signalSeenRef.current.add(s.id);
      incoming.push({
        id: `wk:${s.id}`,
        category: "wick",
        symbol: s.symbol,
        type: s.type === "upper" ? "UPPER WICK" : "LOWER WICK",
        title: `1H ${s.type} wick ${s.wickPct.toFixed(1)}% of range — closed ${new Date(s.closeTime).toLocaleTimeString()}`,
        detail: `close ${s.close} · RVOL ${Number.isFinite(s.rvol) ? `${Math.round(s.rvol)}%` : "n/a"}`,
        at: s.signalTime,
        seen: false,
      });
    }
    // Only the newest few per pass, so a history seed does not stampede.
    pushMany(incoming.slice(0, 8));
  }, [signals, pushMany]);

  useEffect(() => {
    // 3-8 — the instrument streams: squeeze transitions, walls, whales, OI, funding, liquidations.
    const incoming: TerminalAlert[] = [];
    const t = prefsRef.current.thresholds;
    for (const read of instrumentReads.values()) {
      // squeeze: fire on the transition into warm/hot, not on every snapshot.
      const prevLevel = squeezeLevelRef.current.get(read.symbol) ?? 0;
      const rank = read.squeeze.level === "hot" ? 2 : read.squeeze.level === "warm" ? 1 : 0;
      if (rank > prevLevel && rank > (t.squeezeWarm > 0 ? 1 : 0) && read.squeeze.volume >= t.squeezeWarm) {
        incoming.push({
          id: `sq:${read.symbol}:${read.squeeze.lastAt ?? now}`,
          category: "squeeze",
          symbol: read.symbol,
          type: `SQUEEZE ${read.squeeze.level.toUpperCase()}`,
          title: `${read.squeeze.direction.replace("-", " ")} — ${fmtCompactUsd(read.squeeze.volume)} forced orders (1h)`,
          detail: `short ${fmtCompactUsd(read.squeeze.shortLiq)} · long ${fmtCompactUsd(read.squeeze.longLiq)} · ratio ${read.squeeze.longLiq > 0 ? (read.squeeze.shortLiq / read.squeeze.longLiq).toFixed(2) : "∞"}`,
          at: read.squeeze.lastAt ?? now,
          seen: false,
        });
      }
      squeezeLevelRef.current.set(read.symbol, Math.max(prevLevel, rank));

      // walls: a new dominant wall appearing on either side.
      const wallKey = read.bidWalls[0] ?? read.askWalls[0];
      const wallCount = read.bidWalls.length + read.askWalls.length;
      const prevWalls = wallRef.current.get(read.symbol) ?? 0;
      if (wallCount > prevWalls && wallKey) {
        incoming.push({
          id: `wall:${read.symbol}:${wallKey.price}`,
          category: "wall",
          symbol: read.symbol,
          type: wallKey.side === "buy" ? "BID WALL" : "ASK WALL",
          title: `${wallKey.side === "buy" ? "Bid" : "Ask"} wall ${fmtCompactUsd(wallKey.notional)} at ${wallKey.price} (${wallKey.distance.toFixed(2)}% away)`,
          detail: `${wallCount} walls live · strength ×${wallKey.strength.toFixed(1)}`,
          at: read.lastDepthAt ?? now,
          seen: false,
        });
      }
      wallRef.current.set(read.symbol, wallCount);

      // whale prints (off by default; the tape shows them regardless).
      const newestWhale = read.whales[0];
      if (newestWhale) {
        const line = t.whaleNotional > 0 ? t.whaleNotional : read.whaleAt;
        if (newestWhale.notional >= line && now - newestWhale.at < 5_000) {
          incoming.push({
            id: `wh:${read.symbol}:${newestWhale.at}`,
            category: "whale",
            symbol: read.symbol,
            type: newestWhale.isBuy ? "WHALE BUY" : "WHALE SELL",
            title: `${fmtCompactUsd(newestWhale.notional)} ${newestWhale.isBuy ? "aggressive buy" : "aggressive sell"}`,
            detail: `${newestWhale.qty} @ ${newestWhale.price}`,
            at: newestWhale.at,
            seen: false,
          });
        }
      }

      // open interest: |5m change| past the threshold, once per direction flip.
      const oiDelta = read.oi.read.change5m;
      if (oiDelta !== undefined && Math.abs(oiDelta) >= t.oiChangePct) {
        const key = `${read.symbol}:${oiDelta >= 0 ? "+" : "-"}`;
        if (oiRef.current.get(read.symbol) !== Number(oiDelta >= 0)) {
          oiRef.current.set(read.symbol, Number(oiDelta >= 0));
          incoming.push({
            id: `oi:${key}:${now}`,
            category: "oi",
            symbol: read.symbol,
            type: "OPEN INTEREST",
            title: `OI ${fmtSignedPct(oiDelta, 2)} in 5m`,
            detail: read.oi.read.regime.replace("-", " "),
            at: read.oiPolledAt ?? now,
            seen: false,
          });
        }
      }

      // funding: |rate| past the threshold.
      const fr = read.mark?.fundingRate;
      if (fr !== undefined && Math.abs(fr) >= t.fundingPct) {
        incoming.push({
          id: `fr:${read.symbol}:${read.mark?.at ?? now}`,
          category: "funding",
          symbol: read.symbol,
          type: "FUNDING",
          title: `Funding ${fmtSignedPct(fr, 4)} — ${fr >= 0 ? "longs pay" : "shorts pay"}`,
          detail: `mark ${read.mark?.markPrice ?? "n/a"}`,
          at: read.mark?.at ?? now,
          seen: false,
        });
      }

      // liquidations: single forced order past the notional line.
      const biggest = read.liquidations[0];
      if (biggest && biggest.notional >= t.liquidationNotional && now - biggest.at < 5_000) {
        incoming.push({
          id: `lq:${read.symbol}:${biggest.at}`,
          category: "liquidation",
          symbol: read.symbol,
          type: biggest.side === "BUY" ? "SHORT LIQUIDATED" : "LONG LIQUIDATED",
          title: `${fmtCompactUsd(biggest.notional)} ${biggest.side === "BUY" ? "short" : "long"} liquidated @ ${biggest.price}`,
          detail: `${biggest.qty} contracts · !forceOrder@arr`,
          at: biggest.at,
          seen: false,
        });
      }
    }
    pushMany(incoming.slice(0, 12));
  }, [instrumentReads, now, pushMany]);

  const markAllSeen = useCallback(() => {
    const next = alertsRef.current.map((a) => (a.seen ? a : { ...a, seen: true }));
    alertsRef.current = next;
    setAlerts(next);
    saveState(ALERTS_KEY, next);
  }, []);

  const clear = useCallback(() => {
    alertsRef.current = [];
    setAlerts([]);
    saveState(ALERTS_KEY, []);
  }, []);

  const toggleCategory = useCallback((c: AlertCategory) => {
    setPrefs((prev) => {
      const next = { ...prev, categories: { ...prev.categories, [c]: !prev.categories[c] } };
      saveState(PREFS_KEY, next);
      return next;
    });
  }, []);

  const setChannel = useCallback((channel: "sound" | "desktop", on: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, [channel]: on };
      saveState(PREFS_KEY, next);
      return next;
    });
  }, []);

  const patchThresholds = useCallback((patch: Partial<AlertThresholds>) => {
    setPrefs((prev) => {
      const next = { ...prev, thresholds: { ...prev.thresholds, ...patch } };
      saveState(PREFS_KEY, next);
      return next;
    });
  }, []);

  const test = useCallback(() => {
    push({
      id: `test:${uid()}`,
      category: "wick",
      symbol: "BTCUSDT",
      type: "TEST",
      title: "Alert Center test — delivery path check, not a live signal",
      detail: "browser notification + chime",
      at: Date.now(),
      seen: false,
    });
  }, [push]);

  const unseen = useMemo(() => alerts.filter((a) => !a.seen).length, [alerts]);

  const value = useMemo<AlertCenterValue>(
    () => ({ alerts, unseen, markAllSeen, clear, prefs, toggleCategory, setChannel, patchThresholds, test }),
    [alerts, unseen, markAllSeen, clear, prefs, toggleCategory, setChannel, patchThresholds, test],
  );

  return <AlertCenterContext.Provider value={value}>{children}</AlertCenterContext.Provider>;
}

export function useAlertCenter(): AlertCenterValue {
  const ctx = useContext(AlertCenterContext);
  if (!ctx) throw new Error("useAlertCenter must be used inside AlertCenterProvider");
  return ctx;
}
