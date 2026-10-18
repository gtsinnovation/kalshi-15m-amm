import { useId } from "react";
import { useBotStore } from "@/lib/store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldAlert } from "lucide-react";

/**
 * Per-user configurable risk limits. Splits caps into two groups:
 *
 *  - Position & exposure: classic mid-frequency limits (per-market position,
 *    global $ exposure, max resting orders, daily stop-loss).
 *  - 15-minute cycle stops: short-cycle safety nets that only make sense for
 *    Kalshi BTC 15-min markets — they auto-pause the bot if a cycle bleeds.
 */
export function RiskPanel() {
  const { risk, setRisk, consecutiveLosingCycles, cycleStartEquity } = useBotStore();
  return (
    <div className="space-y-5 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">Risk limits</h2>
        <p className="text-xs text-muted-foreground">
          Hard caps. The scheduler enforces them every tick and auto-pauses on stop-out.
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Position &amp; exposure
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Per-market position cap (contracts)"
            value={risk.perMarketPositionCap}
            min={0}
            onChange={(n) => setRisk({ perMarketPositionCap: n })}
          />
          <Field
            label="Global $ exposure cap"
            value={risk.globalDollarExposureCap}
            min={0}
            onChange={(n) => setRisk({ globalDollarExposureCap: n })}
          />
          <Field
            label="Max open orders (0 = unlimited)"
            value={risk.maxOpenOrders}
            min={0}
            onChange={(n) => setRisk({ maxOpenOrders: n })}
          />
          <Field
            label="Daily stop-loss ($)"
            value={risk.dailyStopLossDollars}
            min={0}
            onChange={(n) => setRisk({ dailyStopLossDollars: n })}
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="autoflat"
            checked={risk.autoFlattenOnStop}
            onChange={(e) => setRisk({ autoFlattenOnStop: e.target.checked })}
            className="h-4 w-4"
          />
          <Label htmlFor="autoflat" className="text-xs">
            Auto-flatten positions on stop-out
          </Label>
        </div>
      </section>

      <section className="space-y-3 rounded-md border border-warning/30 bg-warning/5 p-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 text-warning" />
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-warning">
              15-minute cycle stops
            </h3>
            <p className="text-xs text-muted-foreground">
              Auto-pause if the bot bleeds across short cycles. Cycles align to wall-clock
              :00 / :15 / :30 / :45 — same cadence as Kalshi's BTC 15-min markets.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Max consecutive losing cycles (0 = off)"
            value={risk.maxConsecutiveLosingCycles}
            min={0}
            onChange={(n) => setRisk({ maxConsecutiveLosingCycles: n })}
          />
          <Field
            label="Intra-cycle drawdown stop ($, 0 = off)"
            value={risk.intraCycleDrawdownDollars}
            min={0}
            onChange={(n) => setRisk({ intraCycleDrawdownDollars: n })}
          />
          <Field
            label="Max loss / 60s circuit breaker ($, 0 = off)"
            value={risk.maxLossPerMinuteDollars}
            min={0}
            onChange={(n) => setRisk({ maxLossPerMinuteDollars: n })}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          Current streak:{" "}
          <span className="font-mono text-foreground">
            {consecutiveLosingCycles}
          </span>{" "}
          losing cycle{consecutiveLosingCycles === 1 ? "" : "s"} in a row
          {cycleStartEquity > 0 && (
            <>
              {" · "}cycle started at{" "}
              <span className="font-mono text-foreground">${cycleStartEquity.toFixed(2)}</span>
            </>
          )}
          .
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? Math.max(min ?? -Infinity, n) : 0);
        }}
      />
    </div>
  );
}
