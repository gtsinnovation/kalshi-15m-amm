import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { StatusHeader } from "@/components/mm/StatusHeader";
import { ControlBar } from "@/components/mm/ControlBar";
import { BotStatusBanner } from "@/components/mm/BotStatusBanner";
import { MarketsPanel } from "@/components/mm/MarketsPanel";
import { StrategyPanel } from "@/components/mm/StrategyPanel";
import { RiskPanel } from "@/components/mm/RiskPanel";
import { CircuitBreakerPanel } from "@/components/mm/CircuitBreakerPanel";
import { WatchdogBanner } from "@/components/mm/WatchdogBanner";
import { ActivityLog } from "@/components/mm/ActivityLog";
import { PnlChart } from "@/components/mm/PnlChart";
import { SettingsPanel } from "@/components/mm/SettingsPanel";
import { CollateralPanel } from "@/components/mm/CollateralPanel";
import { OrderLedgerPanel } from "@/components/mm/OrderLedgerPanel";
import { UnlockGate } from "@/components/mm/UnlockGate";
import { useSettingsSync } from "@/lib/security/useSettingsSync";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBotStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { KeyRound, History, ScrollText, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { subscribeSpot } from "@/lib/kalshi/spotPoll";

const Index = () => {
  const [tab, setTab] = useState("dashboard");
  const credentials = useBotStore((s) => s.credentials);
  const encryptedCredentials = useBotStore((s) => s.encryptedCredentials);
  const autoRefresh = useBotStore((s) => s.autoRefreshEnabled);
  const setAutoRefresh = useBotStore((s) => s.setAutoRefreshEnabled);
  useSettingsSync();
  const hasAnyCreds = !!credentials || !!encryptedCredentials;

  const [pollStatus, setPollStatus] = useState<{ intervalMs: number; lastOkAt: number; throttled: boolean; reason: string }>({
    intervalMs: 0,
    lastOkAt: 0,
    throttled: false,
    reason: "idle",
  });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  // Prefetch BTC spot via the centralized rate-limit-aware poller so the
  // pre-start simulation has a price ready even before the bot is running.
  // Gated on the auto-refresh toggle so users can pause background polling.
  useEffect(() => {
    if (!autoRefresh) {
      setPollStatus((s) => ({ ...s, reason: "paused" }));
      return;
    }
    return subscribeSpot((price, status) => {
      if (price != null) useBotStore.getState().setBtcSpot(price);
      setPollStatus({
        intervalMs: status.intervalMs,
        lastOkAt: status.lastOkAt,
        throttled: status.throttled,
        reason: status.reason,
      });
    });
  }, [autoRefresh]);

  const intervalLabel = pollStatus.intervalMs
    ? pollStatus.intervalMs >= 1000
      ? `${Math.round(pollStatus.intervalMs / 1000)}s`
      : `${pollStatus.intervalMs}ms`
    : "—";
  const lastRefreshLabel = !autoRefresh
    ? "paused"
    : pollStatus.lastOkAt
      ? `${Math.max(0, Math.round((now - pollStatus.lastOkAt) / 1000))}s ago`
      : "never";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>Dashboard — K15M AMM Kalshi BTC Market Maker</title>
        <meta
          name="description"
          content="Live control panel for the K15M AMM bot: tracked markets, strategy parameters, risk caps, P&L, and activity log for Kalshi BTC 15-minute contracts."
        />
        <link rel="canonical" href="https://k15mamm.webpwa.io/" />
        <meta property="og:title" content="Dashboard — K15M AMM" />
        <meta property="og:description" content="Live Kalshi BTC market maker control panel — quotes, fills, risk, and P&L." />
        <meta property="og:url" content="https://k15mamm.webpwa.io/" />
      </Helmet>
      <UnlockGate />
      <header className="border-b border-border bg-card/50 backdrop-blur">
        <div className="container flex flex-wrap gap-4 items-center justify-between py-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              K15M AMM — Automated Market Maker for Kalshi BTC
            </h1>
            <p className="text-xs text-muted-foreground">
              Avellaneda–Stoikov · Kalshi BTC 15-minute contracts · Local browser bot
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-1 flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
              <RefreshCw
                className={`h-3.5 w-3.5 ${autoRefresh ? (pollStatus.throttled ? "text-warning" : "text-success") : "text-muted-foreground"}`}
              />
              <Label htmlFor="auto-refresh" className="text-xs">
                Auto-refresh
              </Label>
              <Switch
                id="auto-refresh"
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
              />
              <div
                className="ml-1 flex flex-col leading-tight border-l border-border pl-2"
                title={`Poll reason: ${pollStatus.reason}`}
              >
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  every {intervalLabel}
                </span>
                <span
                  className={`font-mono text-[10px] ${
                    !autoRefresh
                      ? "text-muted-foreground"
                      : pollStatus.lastOkAt && now - pollStatus.lastOkAt < pollStatus.intervalMs * 2
                        ? "text-success"
                        : "text-warning"
                  }`}
                >
                  {lastRefreshLabel}
                </span>
              </div>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/backtest">
                <History className="mr-2 h-4 w-4" /> Backtest
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/audit">
                <ScrollText className="mr-2 h-4 w-4" /> Audit log
              </Link>
            </Button>
            <Button
              asChild
              variant={hasAnyCreds ? "outline" : "default"}
              size="sm"
            >
              <Link to="/credentials">
                <KeyRound className="mr-2 h-4 w-4" />
                {hasAnyCreds ? "Manage credentials" : "Add API credentials"}
              </Link>
            </Button>
          </div>
        </div>
      </header>
      <main className="container space-y-6 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="dashboard" className="space-y-6">
            <WatchdogBanner />
            <BotStatusBanner />
            <StatusHeader />
            <ControlBar />
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2 space-y-6">
                <MarketsPanel />
                <CollateralPanel />
                <OrderLedgerPanel />
                <PnlChart />
                <ActivityLog />
              </div>
              <div className="space-y-6">
                <CircuitBreakerPanel />
                <StrategyPanel />
                <RiskPanel />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="settings">
            <SettingsPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
