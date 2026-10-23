import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { toast } from "@/components/ui/sonner";
import { BTC_TRAP_SYMBOL } from "@/lib/wick/btcTrap";
import { readVolume } from "@/lib/wick/engines";
import {
  candidacy,
  evaluateExhaustion,
  headlineOf,
  reasonsOf,
  type ExhaustionRead,
} from "@/lib/wick/exhaustion";
import { WickFeed } from "@/lib/wick/feed";
import { readLiquidity } from "@/lib/wick/levels";
import { deliverRemote, playWickChime, showDesktop, type DeliveryResult } from "@/lib/wick/notify";
import { setupFellApart } from "@/lib/wick/rearm";
import { DEFAULT_WICK_RULES, sanitizeWickRules } from "@/lib/wick/rules";
import type {
  FeedStatus,
  LiquidityRead,
  TransportMode,
  WickAlert,
  WickRules,
} from "@/lib/wick/types";
import { BITCOIN_SYMBOL, isTracked, pruneUntracked } from "@/lib/wick/universe";
import { fmtPrice } from "@/lib/format";
import { loadState, saveState, uid } from "@/lib/storage";

const RULES_KEY = "wick-rules";
const PREFS_KEY = "wick-prefs";
const ALERTS_KEY = "wick-alerts";

const MAX_ALERTS = 200;
/** Deep symbols get their cached REST slices refreshed on this slower clock. */
const DEEP_REFRESH_MS = 25_000;

export interface WickPrefs {
  paused: boolean;
  desktop: boolean;
  sound: boolean;
  popup: boolean;
  telegramToken: string;
  telegramChatId: string;
  discordWebhook: string;
  selected: string;
  pinned: string[];
}

const DEFAULT_PREFS: WickPrefs = {
  paused: false,
  desktop: true,
  sound: true,
  popup: true,
  telegramToken: "",
  telegramChatId: "",
  discordWebhook: "",
  selected: "BTCUSDT",
  pinned: [],
};

interface WickValue {
  ready: boolean;
  rules: WickRules;
  patchRules: (patch: Partial<WickRules>) => void;
  resetRules: () => void;
  prefs: WickPrefs;
  patchPrefs: (patch: Partial<WickPrefs>) => void;

  /** Every scanned contract, closest to arming first. */
  reads: ExhaustionRead[];
  /** Per-symbol readouts backing the focus panel. */
  bySymbol: Map<string, ExhaustionRead>;
  /** The contract currently in the focus panel. */
  focus: ExhaustionRead | undefined;
  select: (symbol: string) => void;
  togglePin: (symbol: string) => void;
  /** Contracts with every gate passed, right now. */
  armedCount: number;
  /** Contracts scored on the last pass: Bitcoin plus altcoins priced inside the band. */
  tracked: number;
  /** Contracts with a live price outside the band, dropped before scoring. */
  excluded: number;

  alerts: WickAlert[];
  unseen: number;
  markAllSeen: () => void;
  dismiss: (id: string) => void;
  clearAlerts: () => void;

  status: FeedStatus;
  scannedAt: number;
  /** Re-fetch every input now, ignoring cache TTLs, then rescan. */
  refreshNow: () => void;
  /** True while a manual refresh is in flight. */
  refreshing: boolean;
  /** When the last manual refresh completed. */
  refreshedAt: number;
  /** Result of the last Telegram/Discord dispatch, for the settings panel. */
  lastDelivery: DeliveryResult[];
  testAlert: () => void;
  requestPermission: () => void;
  permission: NotificationPermission | "unsupported";
  /** Restart the socket search and force an immediate REST refresh. */
  retryFeed: () => void;
  /** Pin tier 1 to polling when the stream host is filtered on this network. */
  setTransportMode: (mode: TransportMode) => void;
}

const WickContext = createContext<WickValue | null>(null);

const EMPTY_STATUS: FeedStatus = {
  market: "idle",
  deep: "idle",
  universe: 0,
  deepCount: 0,
  restOk: true,
  marketRetries: 0,
  deepRetries: 0,
  transport: "none",
  mode: "auto",
  handshakeTimeouts: 0,
  pollFailures: 0,
};

interface StructuralMemo {
  key: string;
  liquidity?: LiquidityRead;
}

/** Mean gate progress, used only to break ties in the scanner ordering. */
function progressOf(read: ExhaustionRead): number {
  if (!read.gates.length) return 0;
  return read.gates.reduce((sum, g) => sum + Math.min(1, g.progress), 0) / read.gates.length;
}

function permissionNow(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export function WickProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState<boolean>(false);
  const [rules, setRules] = useState<WickRules>(DEFAULT_WICK_RULES);
  const [prefs, setPrefs] = useState<WickPrefs>(DEFAULT_PREFS);
  const [reads, setReads] = useState<ExhaustionRead[]>([]);
  const [bySymbol, setBySymbol] = useState<Map<string, ExhaustionRead>>(new Map());
  const [alerts, setAlerts] = useState<WickAlert[]>([]);
  const [status, setStatus] = useState<FeedStatus>(EMPTY_STATUS);
  const [scannedAt, setScannedAt] = useState<number>(0);
  const [lastDelivery, setLastDelivery] = useState<DeliveryResult[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [refreshedAt, setRefreshedAt] = useState<number>(0);
  const [excluded, setExcluded] = useState<number>(0);

  const rulesRef = useRef<WickRules>(DEFAULT_WICK_RULES);
  const prefsRef = useRef<WickPrefs>(DEFAULT_PREFS);
  const alertsRef = useRef<WickAlert[]>([]);
  const feedRef = useRef<WickFeed | null>(null);
  const memoRef = useRef<Map<string, StructuralMemo>>(new Map());
  const cooldownRef = useRef<Map<string, number>>(new Map());
  const rearmRef = useRef<Map<string, boolean>>(new Map());
  const deepRef = useRef<string[]>([]);
  // Guards against a second refresh being launched while one is in flight.
  const refreshingRef = useRef<boolean>(false);

  /* ---------------------------------------------------------------- */
  /* Boot                                                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const loadedRules = sanitizeWickRules(loadState<unknown>(RULES_KEY, null));
    const loadedPrefs = { ...DEFAULT_PREFS, ...(loadState<Partial<WickPrefs>>(PREFS_KEY, {}) ?? {}) };
    const loadedAlerts = loadState<WickAlert[]>(ALERTS_KEY, []);

    rulesRef.current = loadedRules;
    prefsRef.current = loadedPrefs;
    // Signals raised on contracts outside the tracked universe are history
    // the project no longer keeps, judged by the price they were raised at.
    const storedAlerts = Array.isArray(loadedAlerts) ? loadedAlerts.slice(0, MAX_ALERTS) : [];
    alertsRef.current = pruneUntracked(storedAlerts);
    if (alertsRef.current.length !== storedAlerts.length) saveState(ALERTS_KEY, alertsRef.current);

    setRules(loadedRules);
    setPrefs(loadedPrefs);
    setAlerts(alertsRef.current);
    setPermission(permissionNow());
    setReady(true);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Alert dispatch                                                   */
  /* ---------------------------------------------------------------- */

  const raise = useCallback((read: ExhaustionRead) => {
    const p = prefsRef.current;
    const alert: WickAlert = {
      id: uid(),
      symbol: read.symbol,
      side: read.side,
      conviction: read.conviction,
      price: read.price,
      // Always the 24h high: the only level this engine ever pins against.
      extreme: read.high24h,
      rvol: read.rvol,
      wickPct: read.wickPct,
      reasons: reasonsOf(read),
      at: Date.now(),
      seen: false,
    };

    const next = [alert, ...alertsRef.current].slice(0, MAX_ALERTS);
    alertsRef.current = next;
    setAlerts(next);
    saveState(ALERTS_KEY, next);

    if (p.sound) playWickChime();
    if (p.desktop) showDesktop(alert);
    if (p.popup) {
      toast(`${read.symbol} — ${headlineOf(read)}`, {
        description: `Price ${fmtPrice(read.price)} · conviction ${read.conviction}`,
      });
    }

    void deliverRemote(alert, {
      desktop: p.desktop,
      sound: p.sound,
      popup: p.popup,
      telegramToken: p.telegramToken,
      telegramChatId: p.telegramChatId,
      discordWebhook: p.discordWebhook,
    }).then((results) => {
      if (results.length) setLastDelivery(results);
      for (const r of results) {
        if (!r.ok) console.warn(`[wick] ${r.channel} delivery failed: ${r.error ?? "unknown"}`);
      }
    });
  }, []);

  const patchPrefs = useCallback((patch: Partial<WickPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefs(next);
    saveState(PREFS_KEY, next);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Scan loop                                                        */
  /* ---------------------------------------------------------------- */

  const runPass = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const r = rulesRef.current;
    const p = prefsRef.current;
    const now = Date.now();

    const universe = feed.symbols();
    const symbols = universe.length ? universe : [...feed.tickers.keys()];
    if (!symbols.length) return;

    const rows: ExhaustionRead[] = [];
    const next = new Map<string, ExhaustionRead>();
    const ranked: { symbol: string; weight: number }[] = [];
    const currentDeep = deepRef.current;
    let outside = 0;

    for (const symbol of symbols) {
      const ticker = feed.tickers.get(symbol);
      if (!ticker || ticker.last <= 0) continue;
      // The universe rule: Bitcoin, plus altcoins priced strictly inside the
      // band. Judged on every pass against the live price, so a contract that
      // crosses out is gone on the next tick and back only once it returns.
      if (!isTracked(symbol, ticker.last)) {
        outside++;
        continue;
      }
      if (ticker.quoteVolume < r.minVolume) continue;

      // Only history the feed is still refreshing comes back; anything that
      // stopped updating reads as missing, so it can never arm a contract.
      const klines = feed.klines(symbol, now);
      const daily = feed.daily(symbol, now);
      const volume = readVolume(ticker, feed.volSamples.get(symbol) ?? [], klines, r.rvolClimax);
      const isDeep = currentDeep.includes(symbol);

      // The liquidity map is only used to describe remaining depth on the
      // depletion gate, so it is memoised against the newest bar.
      let memo: StructuralMemo | undefined;
      if (isDeep && klines?.length) {
        const last = klines[klines.length - 1];
        const key = `${klines.length}:${last.openTime}:${last.quoteVolume}`;
        const cached = memoRef.current.get(symbol);
        if (cached?.key === key) {
          memo = cached;
        } else {
          memo = { key, liquidity: readLiquidity(klines, daily ?? [], ticker.last) };
          memoRef.current.set(symbol, memo);
        }
      }

      const read = evaluateExhaustion({
        symbol,
        ticker,
        volume,
        klines,
        daily,
        liquidity: memo?.liquidity,
        rules: r,
        at: now,
      });

      rows.push(read);
      next.set(symbol, read);

      ranked.push({
        symbol,
        weight:
          candidacy({
            extremeBps: read.extremeBps,
            rvol: read.rvol,
            quoteVolume: ticker.quoteVolume,
            pinBps: r.pinBps,
            rvolClimax: r.rvolClimax,
          }) + (isDeep ? 0.06 : 0), // hysteresis, so the watch list does not flap
      });

      /* --- alerting: all four gates, or nothing --- */
      if (read.armed && read.side !== "none") {
        const key = `${symbol}:${read.side}`;
        const last = cooldownRef.current.get(key) ?? 0;
        const rearmed = rearmRef.current.get(key) ?? true;

        if (rearmed && now - last >= r.cooldownMins * 60_000) {
          cooldownRef.current.set(key, now);
          rearmRef.current.set(key, false);
          raise(read);
        }
      } else if (setupFellApart(read)) {
        // Re-arm only once the setup has genuinely fallen apart, so one contract
        // hovering on the threshold cannot machine-gun the feed. Gates without
        // live history are unmeasured, not failed: a data gap never re-arms.
        rearmRef.current.set(`${symbol}:short`, true);
      }
    }

    // Closest to arming first: every gate passed, then how many passed, then
    // how far through the remaining ones it is.
    rows.sort(
      (a, b) =>
        Number(b.armed) - Number(a.armed) ||
        b.passedCount - a.passedCount ||
        b.conviction - a.conviction ||
        progressOf(b) - progressOf(a),
    );

    // A focused contract that has left the band leaves the panel too.
    let selected = p.selected;
    const focused = feed.tickers.get(selected);
    if (focused && focused.last > 0 && !isTracked(selected, focused.last)) {
      selected = BITCOIN_SYMBOL;
      patchPrefs({ selected });
    }

    // Deep watch: pinned and selected always, then the strongest candidates.
    const wanted = new Set<string>();
    for (const symbol of p.pinned) if (next.has(symbol)) wanted.add(symbol);
    if (next.has(selected)) wanted.add(selected);
    ranked.sort((a, b) => b.weight - a.weight);
    for (const row of ranked) {
      if (wanted.size >= r.deepWatch) break;
      wanted.add(row.symbol);
    }
    const deep = [...wanted].slice(0, Math.max(r.deepWatch, wanted.size > 0 ? 1 : 0));
    deepRef.current = deep;
    feed.setDeepWatch(deep);
    // The focused contract's history stays live even without a watch-list slot.
    feed.setFocus(selected);

    // Memo entries for contracts that left the watch set are dead weight.
    if (memoRef.current.size > 200) {
      for (const key of [...memoRef.current.keys()]) {
        if (!deep.includes(key)) memoRef.current.delete(key);
      }
    }

    setReads(rows);
    setBySymbol(next);
    setExcluded(outside);
    setScannedAt(now);
    setStatus(feed.status());
  }, [raise, patchPrefs]);

  /* ---------------------------------------------------------------- */
  /* Feed lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    const feed = new WickFeed({
      onStatus: () => setStatus(feed.status()),
      // The BTCUSDT failed-breakout log needs live candles whichever contract
      // is in focus. Kept fresh outside the watch list, so no slot is taken.
      alwaysFresh: [BTC_TRAP_SYMBOL],
    });
    feedRef.current = feed;
    if (!prefsRef.current.paused) feed.start();
    setStatus(feed.status());

    return () => {
      feed.stop();
      feedRef.current = null;
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const feed = feedRef.current;
    if (!feed) return;
    if (prefs.paused) {
      feed.stop();
      setStatus(feed.status());
      return;
    }
    feed.start();
    const scan = setInterval(runPass, rules.refreshMs);
    const refresh = setInterval(() => feed.refreshDeep(), DEEP_REFRESH_MS);
    // First pass shortly after mount, once the streams have delivered a frame.
    const kick = setTimeout(runPass, 1_200);
    return () => {
      clearInterval(scan);
      clearInterval(refresh);
      clearTimeout(kick);
    };
  }, [ready, prefs.paused, rules.refreshMs, runPass]);

  /* ---------------------------------------------------------------- */
  /* Mutators                                                         */
  /* ---------------------------------------------------------------- */

  const patchRules = useCallback((patch: Partial<WickRules>) => {
    const next = sanitizeWickRules({ ...rulesRef.current, ...patch });
    rulesRef.current = next;
    setRules(next);
    saveState(RULES_KEY, next);
  }, []);

  const resetRules = useCallback(() => {
    rulesRef.current = { ...DEFAULT_WICK_RULES };
    setRules({ ...DEFAULT_WICK_RULES });
    saveState(RULES_KEY, DEFAULT_WICK_RULES);
  }, []);

  const select = useCallback(
    (symbol: string) => {
      patchPrefs({ selected: symbol });
    },
    [patchPrefs],
  );

  const togglePin = useCallback(
    (symbol: string) => {
      const current = prefsRef.current.pinned;
      const next = current.includes(symbol)
        ? current.filter((s) => s !== symbol)
        : [...current, symbol].slice(-8);
      patchPrefs({ pinned: next });
    },
    [patchPrefs],
  );

  const markAllSeen = useCallback(() => {
    if (!alertsRef.current.some((a) => !a.seen)) return;
    const next = alertsRef.current.map((a) => (a.seen ? a : { ...a, seen: true }));
    alertsRef.current = next;
    setAlerts(next);
    saveState(ALERTS_KEY, next);
  }, []);

  const dismiss = useCallback((id: string) => {
    const next = alertsRef.current.filter((a) => a.id !== id);
    alertsRef.current = next;
    setAlerts(next);
    saveState(ALERTS_KEY, next);
  }, []);

  const clearAlerts = useCallback(() => {
    alertsRef.current = [];
    setAlerts([]);
    saveState(ALERTS_KEY, []);
  }, []);

  const requestPermission = useCallback(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    void Notification.requestPermission().then((result) => {
      setPermission(result);
      if (result === "granted") patchPrefs({ desktop: true });
    });
  }, [patchPrefs]);

  /**
   * Fires the full delivery path with a synthetic alert, to prove wiring.
   * Deliberately never routed through the gates — it is a transport check and
   * says so in every channel it reaches.
   */
  const testAlert = useCallback(() => {
    const symbol = prefsRef.current.selected;
    const live = bySymbol.get(symbol);
    const price = live?.price ?? 0;
    const alert: WickAlert = {
      id: uid(),
      symbol,
      side: "short",
      conviction: 0,
      price,
      extreme: live?.high24h ?? price,
      rvol: live?.rvol,
      wickPct: live?.wickPct,
      reasons: ["Test alert — delivery path check, not a live signal"],
      at: Date.now(),
      seen: false,
    };

    const next = [alert, ...alertsRef.current].slice(0, MAX_ALERTS);
    alertsRef.current = next;
    setAlerts(next);
    saveState(ALERTS_KEY, next);

    const p = prefsRef.current;
    if (p.sound) playWickChime();
    if (p.desktop) showDesktop(alert);
    if (p.popup) toast(`${symbol} — test alert`, { description: "Delivery path check, not a live signal" });

    void deliverRemote(alert, {
      desktop: p.desktop,
      sound: p.sound,
      popup: p.popup,
      telegramToken: p.telegramToken,
      telegramChatId: p.telegramChatId,
      discordWebhook: p.discordWebhook,
    }).then((results) => {
      if (results.length) setLastDelivery(results);
    });
  }, [bySymbol]);

  const focus = useMemo(() => bySymbol.get(prefs.selected), [bySymbol, prefs.selected]);
  const unseen = useMemo(() => alerts.filter((a) => !a.seen).length, [alerts]);
  const armedCount = useMemo(() => reads.filter((x) => x.armed).length, [reads]);
  const tracked = reads.length;

  const retryFeed = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    feed.retryNow();
    setStatus(feed.status());
  }, []);

  /**
   * Manual refresh: re-fetch every input ignoring cache TTLs, then rescan
   * immediately so the panel and feed reflect the new data without waiting for
   * the next tick of the scan clock.
   *
   * Runs even while paused — a paused engine is exactly when a trader is most
   * likely to want one deliberate look at the current numbers.
   */
  const refreshNow = useCallback(() => {
    const feed = feedRef.current;
    if (!feed || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);

    void feed
      .refreshNow(prefsRef.current.selected)
      .catch((err: unknown) => {
        console.warn(`[wick] manual refresh failed: ${err instanceof Error ? err.message : "unknown"}`);
      })
      .finally(() => {
        runPass();
        refreshingRef.current = false;
        setRefreshing(false);
        setRefreshedAt(Date.now());
      });
  }, [runPass]);

  const setTransportMode = useCallback((mode: TransportMode) => {
    const feed = feedRef.current;
    if (!feed) return;
    feed.setMode(mode);
    setStatus(feed.status());
  }, []);

  const value = useMemo<WickValue>(
    () => ({
      ready,
      rules,
      patchRules,
      resetRules,
      prefs,
      patchPrefs,
      reads,
      bySymbol,
      focus,
      select,
      togglePin,
      armedCount,
      tracked,
      excluded,
      alerts,
      unseen,
      markAllSeen,
      dismiss,
      clearAlerts,
      status,
      scannedAt,
      refreshNow,
      refreshing,
      refreshedAt,
      lastDelivery,
      testAlert,
      requestPermission,
      permission,
      retryFeed,
      setTransportMode,
    }),
    [
      ready,
      rules,
      patchRules,
      resetRules,
      prefs,
      patchPrefs,
      reads,
      bySymbol,
      focus,
      select,
      togglePin,
      armedCount,
      tracked,
      excluded,
      alerts,
      unseen,
      markAllSeen,
      dismiss,
      clearAlerts,
      status,
      scannedAt,
      refreshNow,
      refreshing,
      refreshedAt,
      lastDelivery,
      testAlert,
      requestPermission,
      permission,
      retryFeed,
      setTransportMode,
    ],
  );

  return <WickContext.Provider value={value}>{children}</WickContext.Provider>;
}

export function useWick(): WickValue {
  const ctx = useContext(WickContext);
  if (!ctx) throw new Error("useWick must be used inside WickProvider");
  return ctx;
}
