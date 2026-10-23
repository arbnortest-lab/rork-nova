import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { loadState, saveState } from "@/lib/storage";

/** Account-level settings. Only what the result log actually needs. */
export interface Settings {
  traderName: string;
  /** Account size in quote currency, used to express P&L as a share of equity. */
  equity: number;
}

export const DEFAULT_SETTINGS: Settings = {
  traderName: "Trader",
  equity: 25_000,
};

interface AccountValue {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;
  ready: boolean;
}

const AccountContext = createContext<AccountValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    setSettings({ ...DEFAULT_SETTINGS, ...loadState<Partial<Settings>>("settings", {}) });
    setReady(true);
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveState("settings", next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    saveState("settings", DEFAULT_SETTINGS);
  }, []);

  const value = useMemo<AccountValue>(
    () => ({ settings, updateSettings, resetSettings, ready }),
    [settings, updateSettings, resetSettings, ready],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
