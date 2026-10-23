import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { loadState, saveState, clearState } from "@/lib/storage";

/** Default desk operator credentials. Changeable from Settings → Access. */
export const DEFAULT_CREDENTIALS = { username: "Admin", password: "Lumi1996++" };

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

interface Credentials {
  username: string;
  password: string;
}

interface Session {
  username: string;
  since: number;
}

interface AuthValue {
  session: Session | null;
  credentials: Credentials;
  ready: boolean;
  failures: number;
  signIn: (username: string, password: string) => { ok: boolean; error?: string };
  signOut: () => void;
  updateCredentials: (next: Credentials) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<Credentials>(DEFAULT_CREDENTIALS);
  const [session, setSession] = useState<Session | null>(null);
  const [failures, setFailures] = useState<number>(0);
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    const storedCreds = loadState<Credentials>("credentials", DEFAULT_CREDENTIALS);
    setCredentials(storedCreds);
    const stored = loadState<Session | null>("session", null);
    if (stored && Date.now() - stored.since < SESSION_TTL_MS) {
      setSession(stored);
    } else if (stored) {
      clearState("session");
    }
    setReady(true);
  }, []);

  const signIn = useCallback(
    (username: string, password: string) => {
      const u = username.trim();
      if (!u || !password) return { ok: false, error: "Both fields are required." };
      if (u.toLowerCase() !== credentials.username.toLowerCase() || password !== credentials.password) {
        setFailures((f) => f + 1);
        return { ok: false, error: "Access denied — credentials rejected by the desk." };
      }
      const next: Session = { username: credentials.username, since: Date.now() };
      setSession(next);
      setFailures(0);
      saveState("session", next);
      return { ok: true };
    },
    [credentials],
  );

  const signOut = useCallback(() => {
    setSession(null);
    clearState("session");
  }, []);

  const updateCredentials = useCallback((next: Credentials) => {
    setCredentials(next);
    saveState("credentials", next);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ session, credentials, ready, failures, signIn, signOut, updateCredentials }),
    [session, credentials, ready, failures, signIn, signOut, updateCredentials],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
