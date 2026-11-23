import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Shell } from "@/components/Shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountProvider } from "@/store/AccountProvider";
import { AuthProvider, useAuth } from "@/store/AuthProvider";
import { BtcTrapProvider } from "@/store/BtcTrapProvider";
import { JournalProvider } from "@/store/JournalProvider";
import { OnChainProvider } from "@/store/OnChainProvider";
import { RadarProvider } from "@/store/RadarProvider";
import { WickProvider } from "@/store/WickProvider";

import Journal from "./pages/Journal";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import Settings from "./pages/Settings";
import Wick from "./pages/Wick";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

function BootScreen() {
  return (
    <div className="grid h-screen w-full place-items-center bg-background scanlines">
      <div className="flex items-center gap-2">
        <span className="h-[13px] w-[3px] rounded-full bg-primary" />
        <span className="num text-[12px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Nova<span className="text-primary">Exhaustion</span>
        </span>
        <span className="animate-blink text-[10px] text-primary">●</span>
      </div>
    </div>
  );
}

function Gate() {
  const { session, ready } = useAuth();

  if (!ready) return <BootScreen />;
  if (!session) return <Login />;

  return (
    <AccountProvider>
      <JournalProvider>
        <WickProvider>
          <OnChainProvider>
            <BtcTrapProvider>
              <RadarProvider>
                <Shell>
                  <Routes>
                    <Route path="/" element={<Wick />} />
                    <Route path="/pnl" element={<Journal />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/login" element={<Navigate to="/" replace />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </Shell>
              </RadarProvider>
            </BtcTrapProvider>
          </OnChainProvider>
        </WickProvider>
      </JournalProvider>
    </AccountProvider>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider delayDuration={200}>
        <Toaster position="bottom-right" theme="dark" richColors closeButton />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Gate />
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
