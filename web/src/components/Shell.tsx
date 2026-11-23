import { LogOut, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/store/AuthProvider";
import { useWick } from "@/store/WickProvider";

const NAV = [
  { to: "/", label: "Terminal" },
  { to: "/pnl", label: "P&L" },
  { to: "/settings", label: "Config" },
] as const;

/** One slim status bar, three destinations, nothing else. */
export function Shell({ children }: { children: ReactNode }) {
  const { session, signOut } = useAuth();
  const { pathname } = useLocation();
  const { unseen, status, prefs, armedCount } = useWick();
  const { theme, toggle } = useTheme();

  return (
    <div className="flex min-h-screen flex-col bg-background scanlines">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex h-10 items-center gap-5 px-3">
          <NavLink to="/" className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                "h-[13px] w-[3px] rounded-full transition-colors",
                armedCount > 0 ? "bg-neg shadow-[0_0_8px_hsl(var(--neg))]" : "bg-primary",
              )}
            />
            <span className="num text-[12px] font-semibold uppercase tracking-[0.16em] text-foreground">
              Nova<span className="text-primary">Exhaustion</span>
            </span>
          </NavLink>

          <nav className="flex items-center gap-px">
            {NAV.map(({ to, label }) => {
              const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
              const isTerminal = to === "/";
              const badge = isTerminal ? unseen : 0;
              const live = isTerminal && !prefs.paused && status.market !== "idle";
              const degradedDot = isTerminal && status.market !== "open";
              return (
                <NavLink
                  key={to}
                  to={to}
                  className={cn(
                    "num relative rounded-[3px] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.1em] transition-colors",
                    active
                      ? "bg-primary/12 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {label}
                  {badge > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 grid h-[14px] min-w-[14px] place-items-center rounded-full bg-primary px-[3px] text-[8.5px] font-bold leading-none text-primary-foreground">
                      {badge > 99 ? "99+" : badge}
                    </span>
                  ) : null}
                  {badge === 0 && live ? (
                    <span
                      className={cn(
                        "absolute right-0.5 top-0.5 h-1 w-1 rounded-full",
                        degradedDot ? "bg-warn" : "bg-pos/70",
                      )}
                    />
                  ) : null}
                </NavLink>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {armedCount > 0 ? (
              <span className="num rounded-[2px] border border-neg/40 bg-neg-soft px-1.5 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.1em] text-neg">
                {armedCount} armed
              </span>
            ) : null}
            <span className="num hidden text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground sm:block">
              {session?.username}
            </span>
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              title={theme === "dark" ? "Light theme" : "Dark theme"}
              className="grid h-7 w-7 place-items-center rounded-[3px] text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
            >
              {theme === "dark" ? <Sun className="h-[14px] w-[14px]" /> : <Moon className="h-[14px] w-[14px]" />}
            </button>
            <button
              type="button"
              onClick={signOut}
              aria-label="Sign out"
              className="grid h-7 w-7 place-items-center rounded-[3px] text-muted-foreground transition-colors hover:bg-secondary hover:text-neg"
            >
              <LogOut className="h-[14px] w-[14px]" />
            </button>
          </div>
        </div>
      </header>

      {/* The terminal uses the full width; other pages centre at 1440. */}
      <main
        className={cn(
          "w-full flex-1 px-3 py-2",
          pathname === "/" ? "" : "mx-auto max-w-[1440px] py-4",
        )}
      >
        {children}
      </main>
    </div>
  );
}
