import { AdminControls } from '@/components/auth/AdminControls';
import { confirmAdminMfa, clearAdminSecrets } from '@/lib/adminAuth';
import { useIdleLock } from "@/lib/security/useIdleLock";
import { useEffect, useState, lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Landing from "./pages/Landing.tsx";
import { RiskDisclaimerGate } from "@/components/RiskDisclaimerGate";

const Index = lazy(() => import("./pages/Index.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
const Privacy = lazy(() => import("./pages/Privacy.tsx"));
const Credentials = lazy(() => import("./pages/Credentials.tsx"));
const Audit = lazy(() => import("./pages/Audit.tsx"));
const Backtest = lazy(() => import("./pages/Backtest.tsx"));

const queryClient = new QueryClient();

function useAuthorized() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true, sequence = 0;
    const evaluate = async () => {
      const current = ++sequence;
      let approved = false;
      try { await confirmAdminMfa(); approved = true; } catch { /* Fail closed on expiry or network failure. */ }
      if (alive && current === sequence) {
        setAuthorized(approved);
        if (!approved) clearAdminSecrets();
      }
    };
    const { data: sub } = supabase.auth.onAuthStateChange(() => { queueMicrotask(() => { void evaluate(); }); });
    void evaluate();
    const timer = window.setInterval(() => { void evaluate(); }, 15000);
    const visible = () => { if (document.visibilityState === 'visible') void evaluate(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; sequence++; window.clearInterval(timer); sub.subscription.unsubscribe(); document.removeEventListener('visibilitychange', visible); };
  }, [revision]);
  const refreshAuthorization = () => setRevision(value => value + 1);
  return [authorized, refreshAuthorization] as const;
}

function GatedHome() {
  const [authorized, setAuthorized] = useAuthorized();
  if (authorized) {
    return (
      <ErrorBoundary>
        <AdminControls />
        <Suspense
          fallback={
            <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
              Loading dashboard…
            </div>
          }
        >
          <RiskDisclaimerGate>
            <Index />
          </RiskDisclaimerGate>
        </Suspense>
      </ErrorBoundary>
    );
  }
  return <Landing onAuthorized={() => setAuthorized()} />;
}

function gatedPage(
  Component: React.ComponentType,
  fallbackLabel: string,
): () => JSX.Element {
  return function Gated() {
    const [authorized, setAuthorized] = useAuthorized();
    if (authorized) {
      return (
        <ErrorBoundary>
          <AdminControls />
          <Suspense
            fallback={
              <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
                {fallbackLabel}
              </div>
            }
          >
            <Component />
          </Suspense>
        </ErrorBoundary>
      );
    }
    return <Landing onAuthorized={() => setAuthorized()} />;
  };
}

const GatedCredentials = gatedPage(Credentials, "Loading credentials…");
const GatedAudit = gatedPage(Audit, "Loading audit log…");
const GatedBacktest = gatedPage(Backtest, "Loading backtester…");

const App = () => {
  useIdleLock();
  return (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<GatedHome />} />
          <Route path="/credentials" element={<GatedCredentials />} />
          <Route path="/audit" element={<GatedAudit />} />
          <Route path="/backtest" element={<GatedBacktest />} />
          <Route
            path="/privacy"
            element={
              <Suspense fallback={<div className="min-h-screen bg-background" />}>
                <Privacy />
              </Suspense>
            }
          />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route
            path="*"
            element={
              <Suspense fallback={<div className="min-h-screen bg-background" />}>
                <NotFound />
              </Suspense>
            }
          />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  );
};

export default App;
