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

import { fetchStatus, requestScan, verifyKey } from "@/lib/onchain/client";
import {
  applyOutcome,
  isTestAlert,
  manualJobId,
  MAX_SIGNAL_AGE_MS,
  newJob,
  nextWake,
  phaseFor,
  pickDue,
  rescanJob,
  type OnChainJob,
} from "@/lib/onchain/schedule";
import type { ScannerStatus, VerifyResult } from "@/lib/onchain/types";
import { loadState, saveState } from "@/lib/storage";
import { useWick } from "@/store/WickProvider";

const JOBS_KEY = "onchain-jobs";
const PREFS_KEY = "onchain-prefs";
const MAX_JOBS = 80;
const STATUS_REFRESH_MS = 3 * 60_000;
/** Countdown resolution while a scan is live, and the slower tick for "ago" stamps otherwise. */
const CLOCK_MS = 5_000;
const IDLE_CLOCK_MS = 30_000;
/** Longest the wake-up timer sleeps, so a drifted clock never strands a job. */
const MAX_SLEEP_MS = 60_000;

export interface OnChainPrefs {
  enabled: boolean;
}

const DEFAULT_PREFS: OnChainPrefs = { enabled: true };

interface OnChainValue {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Every tracked signal, newest first. */
  jobs: OnChainJob[];
  /** Jobs keyed by alert id (or manual id). */
  byId: Map<string, OnChainJob>;
  /** The newest job for a contract, for the focus panel. */
  forSymbol: (symbol: string) => OnChainJob | undefined;
  /** Scan a contract right now, anchored at the current time. */
  scanNow: (symbol: string) => void;
  /** Run a job's final scan again, bypassing the backend cache. */
  rescan: (id: string) => void;
  clear: () => void;
  /** True while a scan request is in flight. */
  busy: boolean;
  /** Ticks every few seconds while any job is live, for countdowns. */
  clock: number;

  status: ScannerStatus | undefined;
  statusAt: number;
  /** True when the last status fetch could not reach the backend. */
  statusFailed: boolean;
  refreshStatus: () => void;
  verify: () => void;
  verifying: boolean;
  verifyResult: VerifyResult | undefined;
}

const OnChainContext = createContext<OnChainValue | null>(null);

function sanitizeJobs(raw: unknown): OnChainJob[] {
  if (!Array.isArray(raw)) return [];
  const out: OnChainJob[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const j = item as Partial<OnChainJob>;
    if (typeof j.id !== "string" || typeof j.symbol !== "string" || typeof j.at !== "number") continue;
    out.push({
      id: j.id,
      symbol: j.symbol,
      side: j.side === "short" ? "short" : "none",
      at: j.at,
      source: j.source === "manual" ? "manual" : "alert",
      early: j.early,
      final: j.final,
      attempts: typeof j.attempts === "number" ? j.attempts : 0,
      polls: typeof j.polls === "number" ? j.polls : 0,
      nextAt: typeof j.nextAt === "number" ? j.nextAt : 0,
      done: j.done === true,
      force: j.force === true ? true : undefined,
      lastError: typeof j.lastError === "string" ? j.lastError : undefined,
      updatedAt: typeof j.updatedAt === "number" ? j.updatedAt : 0,
    });
  }
  return out;
}

function trim(jobs: OnChainJob[]): OnChainJob[] {
  return [...jobs].sort((a, b) => b.at - a.at).slice(0, MAX_JOBS);
}

/**
 * The on-chain intelligence add-on.
 *
 * Listens to the Wick engine's alert feed and, for every real signal, asks
 * the backend for the exchange flow around it: an early read right away and
 * a final read once the window has closed and Arkham has indexed it. One
 * request at a time, retries with backoff, every failure recorded as a
 * verdict of "unavailable".
 *
 * This provider only reads from the engine. It cannot arm, alert, re-arm or
 * change a gate, and nothing in the engine waits on it.
 */
export function OnChainProvider({ children }: { children: ReactNode }) {
  const { alerts, bySymbol, ready: wickReady } = useWick();

  const [ready, setReady] = useState<boolean>(false);
  const [enabled, setEnabledState] = useState<boolean>(DEFAULT_PREFS.enabled);
  const [jobs, setJobs] = useState<OnChainJob[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [clock, setClock] = useState<number>(() => Date.now());
  const [status, setStatus] = useState<ScannerStatus | undefined>(undefined);
  const [statusAt, setStatusAt] = useState<number>(0);
  const [statusFailed, setStatusFailed] = useState<boolean>(false);
  const [verifying, setVerifying] = useState<boolean>(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | undefined>(undefined);

  const jobsRef = useRef<OnChainJob[]>([]);
  const enabledRef = useRef<boolean>(DEFAULT_PREFS.enabled);
  const busyRef = useRef<boolean>(false);
  /** Alert ids already considered, so historical alerts are never back-filled. */
  const knownRef = useRef<Set<string> | null>(null);
  const wakeRef = useRef<() => void>(() => {});

  const commit = useCallback((next: OnChainJob[]) => {
    jobsRef.current = next;
    setJobs(next);
    saveState(JOBS_KEY, next);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Boot                                                             */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const prefs = { ...DEFAULT_PREFS, ...(loadState<Partial<OnChainPrefs>>(PREFS_KEY, {}) ?? {}) };
    const stored = trim(sanitizeJobs(loadState<unknown>(JOBS_KEY, [])));
    enabledRef.current = prefs.enabled;
    jobsRef.current = stored;
    setEnabledState(prefs.enabled);
    setJobs(stored);
    setReady(true);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Backend status                                                   */
  /* ---------------------------------------------------------------- */

  const refreshStatus = useCallback(() => {
    void fetchStatus().then((s) => {
      setStatus(s);
      setStatusFailed(!s);
      setStatusAt(Date.now());
    });
  }, []);

  useEffect(() => {
    if (!ready) return;
    refreshStatus();
    const t = window.setInterval(refreshStatus, STATUS_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [ready, refreshStatus]);

  const verify = useCallback(() => {
    setVerifying(true);
    void verifyKey()
      .then((r) => setVerifyResult(r))
      .finally(() => {
        setVerifying(false);
        refreshStatus();
      });
  }, [refreshStatus]);

  /* ---------------------------------------------------------------- */
  /* Runner — one request at a time, woken by a timer                 */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    let timer: number | undefined;
    let disposed = false;

    const arm = () => {
      if (disposed || !enabledRef.current) return;
      if (timer !== undefined) window.clearTimeout(timer);
      const now = Date.now();
      const due = pickDue(jobsRef.current, now);
      const wake = due ? now : nextWake(jobsRef.current, now);
      if (wake === undefined) return;
      timer = window.setTimeout(run, Math.max(50, Math.min(wake - now, MAX_SLEEP_MS)));
    };

    const run = async () => {
      timer = undefined;
      if (disposed || busyRef.current || !enabledRef.current) return;
      const now = Date.now();
      const job = pickDue(jobsRef.current, now);
      if (!job) {
        arm();
        return;
      }
      busyRef.current = true;
      setBusy(true);
      const phase = phaseFor(job, now);
      try {
        const outcome = await requestScan({
          symbol: job.symbol,
          at: job.at,
          side: job.side,
          phase,
          force: job.force,
        });
        if (disposed) return;
        const latest = jobsRef.current.find((j) => j.id === job.id);
        if (latest) {
          const updated = applyOutcome(latest, phase, outcome, Date.now());
          commit(jobsRef.current.map((j) => (j.id === job.id ? updated : j)));
          if (updated.done || updated.early) refreshStatus();
        }
      } catch (err) {
        // requestScan never throws; this guards the add-on against its own bugs.
        console.warn(`[onchain] scan step failed: ${err instanceof Error ? err.message : "unknown"}`);
      } finally {
        busyRef.current = false;
        if (!disposed) {
          setBusy(false);
          setClock(Date.now());
          arm();
        }
      }
    };

    wakeRef.current = arm;
    arm();
    return () => {
      disposed = true;
      wakeRef.current = () => {};
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [ready, enabled, commit, refreshStatus]);

  /* Countdown clock: fast while something is live, slow while there is only history to stamp. */
  const live = useMemo(() => jobs.some((j) => !j.done), [jobs]);
  const hasJobs = jobs.length > 0;
  useEffect(() => {
    if (!hasJobs) return;
    const t = window.setInterval(() => setClock(Date.now()), live ? CLOCK_MS : IDLE_CLOCK_MS);
    return () => window.clearInterval(t);
  }, [live, hasJobs]);

  /* ---------------------------------------------------------------- */
  /* Alert listener                                                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    // The engine publishes its stored alerts together with `ready`, so the
    // first pass after that seeds the known set: alerts that pre-date this
    // session are history, and scanning them would only spend credits.
    if (!ready || !wickReady) return;
    if (knownRef.current === null) {
      const ids = new Set(alerts.map((a) => a.id));
      knownRef.current = ids;
      // A scan anchored to a signal the engine no longer keeps (pruned from the
      // tracked universe, or cleared) has nothing left to attach to.
      const kept = jobsRef.current.filter((j) => j.source !== "alert" || ids.has(j.id));
      if (kept.length !== jobsRef.current.length) commit(kept);
      return;
    }
    const known = knownRef.current;
    const now = Date.now();
    const added: OnChainJob[] = [];
    for (const alert of alerts) {
      if (known.has(alert.id)) continue;
      known.add(alert.id);
      if (!enabledRef.current || isTestAlert(alert) || now - alert.at > MAX_SIGNAL_AGE_MS) continue;
      added.push(newJob({ id: alert.id, symbol: alert.symbol, side: alert.side, at: alert.at, source: "alert" }, now));
    }
    if (!added.length) return;
    commit(trim([...added, ...jobsRef.current]));
    wakeRef.current();
  }, [alerts, ready, wickReady, commit]);

  /* ---------------------------------------------------------------- */
  /* Mutators                                                         */
  /* ---------------------------------------------------------------- */

  const setEnabled = useCallback((next: boolean) => {
    enabledRef.current = next;
    setEnabledState(next);
    saveState(PREFS_KEY, { enabled: next } satisfies OnChainPrefs);
  }, []);

  const scanNow = useCallback(
    (symbol: string) => {
      const now = Date.now();
      const read = bySymbol.get(symbol);
      const job = newJob(
        { id: manualJobId(symbol, now), symbol, side: read?.side ?? "none", at: now, source: "manual" },
        now,
      );
      commit(trim([job, ...jobsRef.current]));
      wakeRef.current();
    },
    [bySymbol, commit],
  );

  const rescan = useCallback(
    (id: string) => {
      const now = Date.now();
      const target = jobsRef.current.find((j) => j.id === id);
      if (!target) return;
      commit(jobsRef.current.map((j) => (j.id === id ? rescanJob(j, now) : j)));
      wakeRef.current();
    },
    [commit],
  );

  const clear = useCallback(() => commit([]), [commit]);

  const byId = useMemo(() => new Map(jobs.map((j) => [j.id, j] as const)), [jobs]);
  const forSymbol = useCallback(
    (symbol: string) => {
      let best: OnChainJob | undefined;
      for (const j of jobs) if (j.symbol === symbol && (!best || j.at > best.at)) best = j;
      return best;
    },
    [jobs],
  );

  const value = useMemo<OnChainValue>(
    () => ({
      enabled,
      setEnabled,
      jobs,
      byId,
      forSymbol,
      scanNow,
      rescan,
      clear,
      busy,
      clock,
      status,
      statusAt,
      statusFailed,
      refreshStatus,
      verify,
      verifying,
      verifyResult,
    }),
    [
      enabled,
      setEnabled,
      jobs,
      byId,
      forSymbol,
      scanNow,
      rescan,
      clear,
      busy,
      clock,
      status,
      statusAt,
      statusFailed,
      refreshStatus,
      verify,
      verifying,
      verifyResult,
    ],
  );

  return <OnChainContext.Provider value={value}>{children}</OnChainContext.Provider>;
}

export function useOnChain(): OnChainValue {
  const ctx = useContext(OnChainContext);
  if (!ctx) throw new Error("useOnChain must be used inside OnChainProvider");
  return ctx;
}
