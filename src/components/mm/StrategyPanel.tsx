import { useId } from "react";
import { useBotStore } from "@/lib/store";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { restartTimerIfRunning } from "@/lib/scheduler/loop";
import { AlertTriangle } from "lucide-react";

function Row({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label id={id} className="text-sm">{label}</Label>
        <span className="font-mono text-sm text-primary">{format ? format(value) : value}</span>
      </div>
      <Slider aria-labelledby={id} value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
    </div>
  );
}

export function StrategyPanel() {
  const { strategy, setStrategy, unfillableQuoteRuns } = useBotStore();
  // Surface tickers that have been ratio-unfillable for 3+ consecutive ticks.
  const stuckTickers = Object.entries(unfillableQuoteRuns).filter(([, v]) => v.count >= 3);
  return (
    <div className="space-y-5 rounded-lg border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">Strategy (Avellaneda–Stoikov)</h2>
      {stuckTickers.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <div className="font-semibold">
              Quotes blocked as unfillable on {stuckTickers.length} market{stuckTickers.length === 1 ? "" : "s"}
            </div>
            <div className="opacity-90">
              Both sides land outside the fillable range. Lower the ask/bid ratio,
              widen fillability thresholds, or set a per-market override.
            </div>
            <ul className="mt-1 list-disc pl-4 font-mono opacity-80">
              {stuckTickers.slice(0, 4).map(([t, v]) => (
                <li key={t}>{t} — {v.reason} (×{v.count})</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <Row label="γ (risk aversion)" value={strategy.gamma} min={0.05} max={3} step={0.05}
           onChange={(v) => setStrategy({ gamma: v })} format={(v) => v.toFixed(2)} />
      <Row label="σ (annualized vol)" value={strategy.sigmaAnnual} min={0.1} max={2} step={0.05}
           onChange={(v) => setStrategy({ sigmaAnnual: v })} format={(v) => `${(v * 100).toFixed(0)}%`} />
      <Row label="k (order-flow intensity)" value={strategy.k} min={0.1} max={10} step={0.1}
           onChange={(v) => setStrategy({ k: v })} format={(v) => v.toFixed(1)} />
      <Row label="Min edge (cents)" value={strategy.minEdgeCents} min={1} max={20} step={1}
           onChange={(v) => setStrategy({ minEdgeCents: v })} format={(v) => `${v}¢`} />
      <Row label="Ask / Bid ratio" value={strategy.askBidRatio} min={1} max={20} step={0.25}
           onChange={(v) => setStrategy({ askBidRatio: v })} format={(v) => `${v.toFixed(2)}×`} />

      <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="text-sm font-semibold">Fillability thresholds</div>
        <p className="text-xs text-muted-foreground">
          Used to flag quotes as unfillable. Per-market overrides can be set in the markets table.
        </p>
        <Row
          label="Pinned bid ≤"
          value={strategy.fillability.pinnedBidMax}
          min={0.01} max={0.10} step={0.001}
          onChange={(v) => setStrategy({ fillability: { ...strategy.fillability, pinnedBidMax: v } })}
          format={(v) => `${(v * 100).toFixed(1)}¢`}
        />
        <Row
          label="Pinned ask ≥"
          value={strategy.fillability.pinnedAskMin}
          min={0.90} max={0.99} step={0.001}
          onChange={(v) => setStrategy({ fillability: { ...strategy.fillability, pinnedAskMin: v } })}
          format={(v) => `${(v * 100).toFixed(1)}¢`}
        />
        <Row
          label="Outside-book gap"
          value={strategy.fillability.outsideBookGap}
          min={0.05} max={0.95} step={0.01}
          onChange={(v) => setStrategy({ fillability: { ...strategy.fillability, outsideBookGap: v } })}
          format={(v) => `${(v * 100).toFixed(0)}¢`}
        />
      </div>

      <Row label="Max quote size" value={strategy.maxQuoteSize} min={1} max={100} step={1}
           onChange={(v) => setStrategy({ maxQuoteSize: v })} format={(v) => `${v}`} />
      <Row label="Tick interval (s)" value={strategy.tickIntervalMs / 1000} min={1} max={60} step={1}
           onChange={(v) => { setStrategy({ tickIntervalMs: v * 1000 }); restartTimerIfRunning(); }}
           format={(v) => `${v}s`} />
      <Row label="Max book age (s)" value={strategy.maxBookAgeSec} min={1} max={60} step={0.5}
           onChange={(v) => setStrategy({ maxBookAgeSec: v })}
           format={(v) => `${v}s`} />
    </div>
  );
}
