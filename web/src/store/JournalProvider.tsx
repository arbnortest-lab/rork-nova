import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { JournalEntry } from "@/lib/journal";
import { loadState, saveState, uid } from "@/lib/storage";

interface JournalValue {
  entries: JournalEntry[];
  /** Logs one realized result. Sign carries the meaning: + profit, − loss. */
  addEntry: (input: { date: string; amount: number; tag?: string }) => JournalEntry | null;
  removeEntry: (id: string) => void;
  /** Deletes every entry logged on a given day key. */
  clearDay: (date: string) => void;
  clearAll: () => void;
  ready: boolean;
}

const JournalContext = createContext<JournalValue | null>(null);

const STORAGE_KEY = "journal";
const MAX_ENTRIES = 5000;

/** Drops anything that would poison the aggregations after a bad write. */
function sanitize(raw: unknown): JournalEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is JournalEntry => {
    if (typeof e !== "object" || e === null) return false;
    const c = e as Partial<JournalEntry>;
    return typeof c.id === "string" && typeof c.date === "string" && Number.isFinite(c.amount);
  });
}

export function JournalProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    setEntries(sanitize(loadState<unknown>(STORAGE_KEY, [])));
    setReady(true);
  }, []);

  const persist = useCallback((next: JournalEntry[]) => {
    saveState(STORAGE_KEY, next);
    return next;
  }, []);

  const addEntry = useCallback(
    ({ date, amount, tag }: { date: string; amount: number; tag?: string }) => {
      if (!Number.isFinite(amount)) return null;
      const entry: JournalEntry = {
        id: uid(),
        date,
        amount,
        tag: tag?.trim() ? tag.trim().slice(0, 24) : undefined,
        createdAt: Date.now(),
      };
      setEntries((prev) => persist([entry, ...prev].slice(0, MAX_ENTRIES)));
      return entry;
    },
    [persist],
  );

  const removeEntry = useCallback(
    (id: string) => {
      setEntries((prev) => persist(prev.filter((e) => e.id !== id)));
    },
    [persist],
  );

  const clearDay = useCallback(
    (date: string) => {
      setEntries((prev) => persist(prev.filter((e) => e.date !== date)));
    },
    [persist],
  );

  const clearAll = useCallback(() => {
    setEntries(persist([]));
  }, [persist]);

  const value = useMemo<JournalValue>(
    () => ({ entries, addEntry, removeEntry, clearDay, clearAll, ready }),
    [entries, addEntry, removeEntry, clearDay, clearAll, ready],
  );

  return <JournalContext.Provider value={value}>{children}</JournalContext.Provider>;
}

export function useJournal(): JournalValue {
  const ctx = useContext(JournalContext);
  if (!ctx) throw new Error("useJournal must be used inside JournalProvider");
  return ctx;
}
