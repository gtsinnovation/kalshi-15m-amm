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
  // Authorized = any signed-in Lovable Cloud user. Each user supplies their
  // own Kalshi API credentials, encrypted in their own browser vault.
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  useEffect(() => {
    const evaluate = (email: string | null | undefined) => setAuthorized(!!email);
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) =>
      evaluate(session?.user?.email),
    );
    supabase.auth.getSession().then(({ data: { session } }) => evaluate(session?.user?.email));
    return () => sub.subscription.unsubscribe();
  }, []);
  return [authorized, setAuthorized] as const;
}

function GatedHome() {
  const [authorized, setAuthorized] = useAuthorized();
  if (authorized) {
    return (
      <ErrorBoundary>
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
  return <Landing onAuthorized={() => setAuthorized(true)} />;
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
    return <Landing onAuthorized={() => setAuthorized(true)} />;
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
