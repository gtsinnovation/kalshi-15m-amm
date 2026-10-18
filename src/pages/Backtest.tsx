import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  PlayCircle,
  Loader2,
  TrendingUp,
  TrendingDown,
  Target,
  History,
  AlertTriangle,
} from "lucide-react";
import {
  fetchBtcCandles15m,
  runBacktest,
  type BacktestSummary,
  type CandleBar,
} from "@/lib/backtest/engine";
import { useBotStore } from "@/lib/store";
import { toast } from "sonner";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

/**
 * Backtest mode page. Replays the last N 15-minute BTC cycles using public
 * Coinbase candles and reports P&L, max drawdown, and hit rate.
 *
 * The strategy parameters used for the backtest mirror the *current* live
 * settings from the bot store so users can tune live params and immediately
 * see how the same configuration would have performed historically.
 */
export default function Backtest() {
  const liveStrategy = useBotStore((s) => s.strategy);

  const [cycles, setCycles] = useState(96); // 24h of 15-min cycles
  const [strikeStep, setStrikeStep] = useState(250);
  const [strikesPerSide, setStrikesPerSide] = useState(5);
  const [bookHalfSpread, setBookHalfSpread] = useState(2);

  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  const [candles, setCandles] = useState<CandleBar[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const equityCurve = useMemo(() => {
    if (!summary) return [];
    let cum = 0;
    return summary.cycles.map((c) => {
      cum += c.pnlCents / 100;
      return { ts: c.startTs, equity: cum, pnl: c.pnlCents / 100 };
    });
  }, [summary]);

  const drawdownCurve = useMemo(() => {
    if (equityCurve.length === 0) return [];
    let peak = 0;
    return equityCurve.map((p) => {
      if (p.equity > peak) peak = p.equity;
      return { ts: p.ts, drawdown: -(peak - p.equity) };
    });
  }, [equityCurve]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const candleCount = Math.min(2000, Math.max(4, cycles));
      const bars = await fetchBtcCandles15m(candleCount);
      if (bars.length === 0) {
        throw new Error("No candles returned by Coinbase");
      }
      setCandles(bars);
      const result = runBacktest(bars, {
        cycles: candleCount,
        strikeStepDollars: strikeStep,
        strikesPerSide,
        bookHalfSpreadCents: bookHalfSpread,
        strategy: {
          gamma: liveStrategy.gamma,
          sigmaAnnual: liveStrategy.sigmaAnnual,
          k: liveStrategy.k,
          minEdgeCents: liveStrategy.minEdgeCents,
          maxQuoteSize: liveStrategy.maxQuoteSize,
        },
      });
      setSummary(result);
      toast.success(
        `Backtest complete — ${result.totals.cycles} cycles, ` +
          `${result.totals.pnlDollars >= 0 ? "+" : ""}$${result.totals.pnlDollars.toFixed(2)} P&L`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast.error("Backtest failed", { description: msg });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>Backtest — K15M AMM Kalshi BTC Strategy Replay</title>
        <meta
          name="description"
          content="Synthetic pricing demonstration using BTC candles. Does not validate historical Kalshi execution or strategy profitability."
        />
        <link rel="canonical" href="https://k15mamm.webpwa.io/backtest" />
        <meta property="og:title" content="Backtest — K15M AMM" />
        <meta property="og:description" content="Synthetic pricing demonstration; not a replay of historical Kalshi orders or fills." />
        <meta property="og:url" content="https://k15mamm.webpwa.io/backtest" />
      </Helmet>
      <header className="border-b border-border bg-card/50 backdrop-blur">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <History className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Backtest mode</h1>
              <p className="text-xs text-muted-foreground">
                Replay the last N 15-min BTC cycles against your current strategy params.
                Synthetic — uses public BTC spot history, not real Kalshi books.
              </p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to dashboard
            </Link>
          </Button>
        </div>
      </header>

      <main className="container space-y-6 py-6">
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 rounded-lg border border-border bg-card p-4 lg:col-span-1">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Backtest parameters
            </h2>
            <div className="space-y-3">
              <NumberField
                label="Cycles to replay (15-min each)"
                value={cycles}
                min={4}
                max={2000}
                onChange={setCycles}
                hint="96 cycles ≈ 24 hours."
              />
              <NumberField
                label="Strike step ($)"
                value={strikeStep}
                min={50}
                max={2000}
                onChange={setStrikeStep}
                hint="Spacing between simulated 'above' strikes around spot."
              />
              <NumberField
                label="Strikes per side"
                value={strikesPerSide}
                min={1}
                max={20}
                onChange={setStrikesPerSide}
                hint="Total strikes per cycle = 2 × this + 1."
              />
              <NumberField
                label="Synthetic book half-spread (¢)"
                value={bookHalfSpread}
                min={1}
                max={50}
                onChange={setBookHalfSpread}
                hint="Stand-in for real Kalshi liquidity. Smaller ⇒ tighter market ⇒ harder to fill."
              />
            </div>
            <div className="rounded-md border border-border bg-background/50 p-3 text-xs text-muted-foreground">
              <div className="mb-1 font-semibold text-foreground">Live strategy params (read-only)</div>
              <div className="grid grid-cols-2 gap-1 font-mono">
                <span>γ:</span>
                <span className="text-right">{liveStrategy.gamma}</span>
                <span>σ annual:</span>
                <span className="text-right">{liveStrategy.sigmaAnnual}</span>
                <span>k:</span>
                <span className="text-right">{liveStrategy.k}</span>
                <span>min edge ¢:</span>
                <span className="text-right">{liveStrategy.minEdgeCents}</span>
                <span>quote size:</span>
                <span className="text-right">{liveStrategy.maxQuoteSize}</span>
              </div>
              <p className="mt-2 leading-relaxed">
                Tune these in the dashboard's Strategy panel, then re-run to compare.
              </p>
            </div>
            <Button onClick={run} disabled={running} className="w-full">
              {running ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…
                </>
              ) : (
                <>
                  <PlayCircle className="mr-2 h-4 w-4" /> Run backtest
                </>
              )}
            </Button>
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <div className="lg:col-span-2">
            {summary ? (
              <ResultsPanel summary={summary} candles={candles} />
            ) : (
              <EmptyState />
            )}
          </div>
        </section>

        {summary && summary.cycles.length > 0 && (
          <section className="space-y-4">
            <ChartCard title="Cumulative P&L ($)" tone="primary">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={equityCurve}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                    labelFormatter={(t) => new Date(t as number).toLocaleString()}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, "Equity"]}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 2" />
                  <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Drawdown ($)" tone="destructive">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={drawdownCurve}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
                    labelFormatter={(t) => new Date(t as number).toLocaleString()}
                    formatter={(v: number) => [`$${v.toFixed(2)}`, "Drawdown"]}
                  />
                  <Line type="monotone" dataKey="drawdown" stroke="hsl(var(--destructive))" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>
        )}
      </main>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (n: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
        }}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ResultsPanel({ summary, candles }: { summary: BacktestSummary; candles: CandleBar[] | null }) {
  const { totals } = summary;
  const profitable = totals.pnlDollars >= 0;
  const window = candles && candles.length > 0
    ? `${new Date(candles[0].ts).toLocaleString()} → ${new Date(
        candles[candles.length - 1].ts + 15 * 60_000,
      ).toLocaleString()}`
    : "—";

  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-3">
      <Stat
        label="Net P&L"
        value={`${profitable ? "+" : ""}$${totals.pnlDollars.toFixed(2)}`}
        tone={profitable ? "success" : "error"}
        icon={profitable ? TrendingUp : TrendingDown}
      />
      <Stat
        label="Hit rate"
        value={`${(totals.hitRate * 100).toFixed(1)}%`}
        tone={totals.hitRate >= 0.5 ? "success" : "warn"}
        icon={Target}
      />
      <Stat
        label="Max drawdown"
        value={`$${totals.maxDrawdownDollars.toFixed(2)}`}
        tone="error"
        icon={TrendingDown}
      />
      <Stat label="Cycles replayed" value={String(totals.cycles)} tone="muted" />
      <Stat label="Total fills" value={String(totals.fills)} tone="muted" />
      <Stat
        label="Avg P&L / cycle"
        value={`${totals.avgCyclePnl >= 0 ? "+" : ""}$${totals.avgCyclePnl.toFixed(3)}`}
        tone={totals.avgCyclePnl >= 0 ? "success" : "error"}
      />
      <Stat
        label="P&L stdev / cycle"
        value={`$${totals.cyclePnlStdDev.toFixed(3)}`}
        tone="muted"
      />
      <Stat
        label="Sharpe (per cycle)"
        value={totals.sharpePerCycle.toFixed(3)}
        tone={totals.sharpePerCycle >= 0 ? "success" : "error"}
      />
      <div className="col-span-2 rounded-md border border-border bg-background/50 p-2 text-[11px] text-muted-foreground md:col-span-3">
        <span className="font-semibold text-foreground">Window:</span> {window}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone: "muted" | "success" | "warn" | "error";
  icon?: typeof TrendingUp;
}) {
  const cls =
    tone === "success"
      ? "border-success/30 text-success"
      : tone === "error"
        ? "border-destructive/30 text-destructive"
        : tone === "warn"
          ? "border-warning/30 text-warning"
          : "border-border text-muted-foreground";
  return (
    <div className={`rounded-md border ${cls} bg-background/40 p-3`}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-80">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className="mt-1 font-mono text-lg text-foreground">{value}</div>
    </div>
  );
}

function ChartCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "primary" | "destructive";
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className={`mb-2 text-sm font-semibold ${tone === "destructive" ? "text-destructive" : "text-foreground"}`}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/40 p-8 text-center">
      <History className="h-8 w-8 text-muted-foreground" />
      <div>
        <h3 className="font-semibold">No backtest run yet</h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Configure parameters on the left and click <span className="font-medium">Run backtest</span>{" "}
          to replay recent BTC 15-min cycles against your live strategy.
        </p>
      </div>
    </div>
  );
}
