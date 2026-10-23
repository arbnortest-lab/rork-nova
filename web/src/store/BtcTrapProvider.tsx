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

import { loadState, saveState, uid } from "@/lib/storage";
import {
  appendTrapRow,
  BTC_TRAP_STORAGE_KEY,
  liveTrapState,
  observeBtcTrap,
  sanitizeTrapRows,
  stepTrapWatch,
  type BtcTrapLive,
  type BtcTrapRow,
} from "@/lib/wick/btcTrap";
import { useWick } from "@/store/WickProvider";

interface BtcTrapValue {
  /** Every logged switch to pass, newest first. */
  rows: BtcTrapRow[];
  /** BTCUSDT's gate 3 right now. */
  live: BtcTrapLive;
  clear: () => void;
}

const BtcTrapContext = createContext<BtcTrapValue | null>(null);

/**
 * Watches BTCUSDT's failed-breakout gate on every engine scan and logs the
 * moment it flips to pass.
 *
 * Mounted above the routes, so the watch keeps running while another page is
 * open. It only reads the engine's output: nothing here can arm, alert or
 * change what the scanner does.
 */
export function BtcTrapProvider({ children }: { children: ReactNode }) {
  const { bySymbol, rules } = useWick();
  const [rows, setRows] = useState<BtcTrapRow[]>(() =>
    sanitizeTrapRows(loadState<unknown>(BTC_TRAP_STORAGE_KEY, [])),
  );

  const rowsRef = useRef<BtcTrapRow[]>(rows);
  /** Last measured gate state. Undefined until a baseline exists. */
  const prevRef = useRef<boolean | undefined>(undefined);
  /** Reads scored before this time were computed under an older threshold. */
  const notBeforeRef = useRef<number>(0);

  // Declared before the scan effect on purpose: when one render carries both a
  // new threshold and a new scan, the reset must land before that scan (which
  // was scored under the old threshold) is stepped.
  useEffect(() => {
    // Moving the wick threshold can flip the gate with no market event behind
    // it, so the watch restarts from a fresh baseline instead of logging it.
    prevRef.current = undefined;
    notBeforeRef.current = Date.now();
  }, [rules.wickPct]);

  useEffect(() => {
    const step = stepTrapWatch(prevRef.current, observeBtcTrap(bySymbol), notBeforeRef.current);
    prevRef.current = step.passed;
    if (!step.row) return;

    const next = appendTrapRow(rowsRef.current, { id: uid(), ...step.row });
    rowsRef.current = next;
    setRows(next);
    saveState(BTC_TRAP_STORAGE_KEY, next);
  }, [bySymbol]);

  const clear = useCallback(() => {
    rowsRef.current = [];
    setRows([]);
    saveState(BTC_TRAP_STORAGE_KEY, []);
  }, []);

  const live = liveTrapState(observeBtcTrap(bySymbol));
  const value = useMemo<BtcTrapValue>(() => ({ rows, live, clear }), [rows, live, clear]);

  return <BtcTrapContext.Provider value={value}>{children}</BtcTrapContext.Provider>;
}

export function useBtcTrap(): BtcTrapValue {
  const ctx = useContext(BtcTrapContext);
  if (!ctx) throw new Error("useBtcTrap must be used inside BtcTrapProvider");
  return ctx;
}
