import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useBotStore } from "@/lib/store";
import { simulateStartCollateral } from "@/lib/strategy/collateral";
import { AlertTriangle, ListChecks, Play, RefreshCw, ShieldAlert, Target } from "lucide-react";
import { subscribeSpot, type SpotPollStatus } from "@/lib/kalshi/spotPoll";
import { KalshiClient } from "@/lib/kalshi/client";
import { runPreflight } from "@/lib/kalshi/preflight";
import { toast } from "sonner";

function fmtUsd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtAgo(ts: number) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  return `${min}m ago`;
}

export function PreStartSimulation({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
}) {
  const markets = useBotStore((s) => s.markets);
  const trackedTickers = useBotStore((s) => s.trackedTickers);
  const positions = useBotStore((s) => s.positions);
  const spot = useBotStore((s) => s.btcSpot);
  const strategy = useBotStore((s) => s.strategy);
  const balance = useBotStore((s) => s.balance);
  const safetyPct = useBotStore((s) => s.risk.collateralSafetyPct);
  const credentials = useBotStore((s) => s.credentials);
  const setMarkets = useBotStore((s) => s.setMarkets);
  const log = useBotStore((s) => s.log);
  const setRisk = useBotStore((s) => s.setRisk);
  const toggleTicker = useBotStore((s) => s.toggleTicker);
  const [showExpected, setShowExpected] = useState(false);
  const [refreshingMarkets, setRefreshingMarkets] = useState(false);

  const refreshMarkets = async () => {
    if (!credentials) {
      toast.error("Save credentials first (Settings tab)");
      return;
    }
    setRefreshingMarkets(true);
    try {
      const pf = await runPreflight(credentials);
      if (pf.status !== "ok") {
        log("error", `preflight failed: ${pf.label} — ${pf.detail ?? ""}`);
        toast.error(`${pf.label}: ${pf.detail ?? ""}`);
        return;
      }
      const client = new KalshiClient(credentials);
      const ms = await client.getBtc15MinMarkets();
      setMarkets(ms);
      log("info", `pre-start refresh: loaded ${ms.length} BTC 15-min markets`);
      if (ms.length === 0) toast.warning("No BTC 15-min markets returned by Kalshi");
      else toast.success(`Loaded ${ms.length} markets`);
    } catch (e) {
      const msg = (e as Error).message;
      log("error", `pre-start refresh failed: ${msg}`);
      toast.error(msg);
    } finally {
      setRefreshingMarkets(false);
    }
  };

  // Auto-load markets when the dialog opens and none are loaded yet.
  useEffect(() => {
    if (!open) return;
    if (markets.length > 0) return;
    if (!credentials) return;
    if (refreshingMarkets) return;
    refreshMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sim = useMemo(() => {
    if (!open || spot <= 0) return null;
    return simulateStartCollateral({
      markets,
      trackedTickers,
      positions,
      spot,
      strategy,
    });
  }, [open, markets, trackedTickers, positions, spot, strategy]);

  // Track when the simulation last recomputed so the user can see it auto-
  // refresh as BTC spot updates.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(0);
  useEffect(() => {
    if (sim) setLastRefreshedAt(Date.now());
  }, [sim]);

  // Re-render every second so the "updated Ns ago" label stays accurate
  // while the dialog is open.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  // While the dialog is open, poll BTC spot every 10s so the estimate stays
  // live without the user having to close + reopen.
  // Centralized, rate-limit-aware spot poller — also surfaces throttle state
  // so we can warn the user when polling has been slowed.
  const [pollStatus, setPollStatus] = useState<SpotPollStatus | null>(null);
  useEffect(() => {
    if (!open) return;
    return subscribeSpot((price, st) => {
      if (price != null) useBotStore.getState().setBtcSpot(price);
      setPollStatus(st);
    });
  }, [open]);

  const totalDollars = sim ? sim.totalCents / 100 : 0;
  const expectedTotalCents = sim
    ? sim.perMarket.reduce((acc, r) => acc + r.totalExpectedCents, 0)
    : 0;
  const expectedDollars = expectedTotalCents / 100;
  const overBalance = balance > 0 && totalDollars > balance;
  const utilization = balance > 0 ? (totalDollars / balance) * 100 : 0;
  const safetyLimitDollars = (balance * safetyPct) / 100;
  const exceedsSafety = balance > 0 && totalDollars > safetyLimitDollars;
  const blocked = !sim || sim.perMarket.length === 0 || !Number.isFinite(balance) || balance <= 0 || exceedsSafety;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pre-start collateral simulation</DialogTitle>
          <DialogDescription>
            Estimated cash that Kalshi will reserve from your balance the moment the bot
            posts its first round of quotes across all enabled markets.
          </DialogDescription>
        </DialogHeader>

        {!sim ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
            BTC spot not loaded yet — open the dashboard for a few seconds so the bot can
            fetch a price, then try again.
          </div>
        ) : sim.perMarket.length === 0 ? (
          <NoMarketsEnabled
            allMarkets={markets}
            spot={spot}
            onEnable={(t) => toggleTicker(t)}
            onRefresh={refreshMarkets}
            refreshing={refreshingMarkets}
            hasCredentials={!!credentials}
          />
        ) : (
          <>
            <PollStatusBar
              spot={spot}
              status={pollStatus}
              lastRefreshedAt={lastRefreshedAt}
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="sim-show-expected"
                  checked={showExpected}
                  onCheckedChange={setShowExpected}
                />
                <Label htmlFor="sim-show-expected" className="text-xs">
                  Show expected (prob-weighted) instead of worst-case
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="safety-pct" className="text-xs whitespace-nowrap">
                  Safety threshold
                </Label>
                <Input
                  id="safety-pct"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={safetyPct}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(100, Number(e.target.value) || 0));
                    setRisk({ collateralSafetyPct: v });
                  }}
                  className="h-8 w-20 text-xs"
                />
                <span className="text-xs text-muted-foreground">% of balance</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Markets" value={`${sim.perMarket.length}`} />
              <Stat label="Available balance" value={`$${balance.toFixed(2)}`} />
              <Stat
                label="Worst-case reserved"
                value={`$${totalDollars.toFixed(2)}`}
                tone={exceedsSafety ? "danger" : overBalance ? "danger" : "warn"}
              />
              <Stat
                label="Expected at risk"
                value={`$${expectedDollars.toFixed(2)}`}
                tone="warn"
              />
            </div>

            <div className="rounded-md border border-border">
              <ScrollArea className="h-[260px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Ticker</th>
                      <th className="px-3 py-2 text-right">FV</th>
                      <th className="px-3 py-2 text-right">Bid × n</th>
                      <th className="px-3 py-2 text-right">Ask × n</th>
                      <th className="px-3 py-2 text-right">
                        {showExpected ? "Expected" : "Worst-case"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.perMarket.map((r) => (
                      <tr key={r.ticker} className="border-t border-border/50">
                        <td className="px-3 py-2 font-mono text-xs">{r.ticker}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {(r.fairValue * 100).toFixed(1)}¢
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          <span className="text-bid">{r.bidCents}¢</span> × {r.size}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          <span className="text-ask">{r.askCents}¢</span> × {r.size}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs font-semibold">
                          {fmtUsd(showExpected ? r.totalExpectedCents : r.totalReservedCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="sticky bottom-0 bg-card">
                    <tr className="border-t border-border">
                      <td className="px-3 py-2 text-xs font-semibold uppercase text-muted-foreground" colSpan={4}>
                        Total ({utilization.toFixed(1)}% of balance)
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-sm font-bold text-warning">
                        {fmtUsd(showExpected ? expectedTotalCents : sim.totalCents)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </ScrollArea>
            </div>

            {exceedsSafety && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <strong>Blocked by safety threshold.</strong> Worst-case reserved
                  (${totalDollars.toFixed(2)}) exceeds {safetyPct}% of available balance
                  (${safetyLimitDollars.toFixed(2)}). Reduce <code>maxQuoteSize</code>,
                  untrack markets, or raise the threshold above to proceed.
                </div>
              </div>
            )}

            {overBalance && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <strong>Reserved exceeds available balance.</strong> Kalshi will reject
                  some orders with insufficient-funds errors. Reduce <code>maxQuoteSize</code>,
                  untrack markets, or top up your account.
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              <strong>Worst-case</strong> = <code>bid × size + (100 − ask) × size</code> (what Kalshi
              actually locks). <strong>Expected</strong> = worst-case × adverse probability implied
              by the price (<code>p × (100 − p) × size / 100</code> per leg) — a more realistic
              "money at risk" figure assuming the market price reflects true odds. Inventory
              offsets are applied to both.
            </p>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="bg-success text-success-foreground hover:bg-success/90"
            disabled={blocked}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            <Play className="mr-1 h-4 w-4" />
            {exceedsSafety ? "Blocked" : "Start bot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "danger";
}) {
  const toneClass =
    tone === "danger" ? "text-destructive" : tone === "warn" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function PollStatusBar({
  spot,
  status,
  lastRefreshedAt,
}: {
  spot: number;
  status: SpotPollStatus | null;
  lastRefreshedAt: number;
}) {
  const throttled = !!status?.throttled;
  const rateLimited = status?.reason === "rate-limited";
  const intervalSec = status ? Math.round(status.intervalMs / 1000) : 10;

  const tone = rateLimited
    ? "border-destructive/40 bg-destructive/10 text-destructive"
    : throttled
    ? "border-warning/40 bg-warning/10 text-warning"
    : "border-border bg-muted/20 text-muted-foreground";

  const iconClass = rateLimited
    ? "text-destructive"
    : throttled
    ? "text-warning"
    : "text-success animate-pulse";

  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${tone}`}>
      <div className="flex items-center gap-2">
        <RefreshCw className={`h-3.5 w-3.5 ${iconClass}`} />
        <span>
          {rateLimited
            ? "Coinbase rate-limited"
            : throttled
            ? "Polling slowed after errors"
            : "Auto-refreshes when BTC spot updates"}{" "}
          ·{" "}
          <span className="font-mono text-foreground">
            BTC ${spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        {(throttled || rateLimited) && (
          <span className="font-mono">every {intervalSec}s</span>
        )}
        {lastRefreshedAt > 0 && (
          <span className="font-mono">updated {fmtAgo(lastRefreshedAt)}</span>
        )}
      </div>
    </div>
  );
}

function NoMarketsEnabled({
  allMarkets,
  spot,
  onEnable,
  onRefresh,
  refreshing,
  hasCredentials,
}: {
  allMarkets: { ticker: string; floor_strike?: number; cap_strike?: number }[];
  spot: number;
  onEnable: (ticker: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  hasCredentials: boolean;
}) {
  const nearest = useMemo(() => {
    if (!allMarkets.length || spot <= 0) return null;
    let best = allMarkets[0];
    let bestDist = Infinity;
    for (const m of allMarkets) {
      const strike = m.floor_strike ?? m.cap_strike;
      if (strike == null) continue;
      const d = Math.abs(strike - spot);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    return best;
  }, [allMarkets, spot]);

  const empty = allMarkets.length === 0;

  return (
    <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          {empty ? (
            <>
              <strong>No markets are loaded yet.</strong>{" "}
              {refreshing
                ? "Fetching BTC 15-minute markets from Kalshi…"
                : hasCredentials
                ? "Click Refresh to fetch BTC 15-minute markets from Kalshi."
                : "Save your Kalshi credentials in the Settings tab first, then click Refresh."}
            </>
          ) : (
            <>
              <strong>No markets are enabled.</strong> Pick at least one BTC
              15-minute market to quote, or enable them all. You can change
              this anytime from the Markets panel.
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {empty ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={refreshing || !hasCredentials}
            className="border-warning/40"
          >
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh markets"}
          </Button>
        ) : (
          <>
            {nearest && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onEnable(nearest.ticker)}
                className="border-warning/40"
              >
                <Target className="mr-1 h-3.5 w-3.5" />
                Enable nearest to spot
                <span className="ml-2 font-mono text-xs opacity-80">
                  {nearest.ticker}
                </span>
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => allMarkets.forEach((m) => onEnable(m.ticker))}
              className="border-warning/40"
            >
              <ListChecks className="mr-1 h-3.5 w-3.5" />
              Enable all ({allMarkets.length})
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

