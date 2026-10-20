import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useBotStore } from "@/lib/store";
import { start, pause, killAll } from "@/lib/scheduler/loop";
import { KalshiClient, fetchBtcSpot } from "@/lib/kalshi/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Play, Pause, Skull, ShieldCheck, Loader2 } from "lucide-react";
import {
  runPreflight,
  PREFLIGHT_BADGE_CLASS,
  type PreflightResult,
} from "@/lib/kalshi/preflight";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PreStartSimulation } from "./PreStartSimulation";
import { PreparingSimulationDialog, type PrepStep } from "./PreparingSimulationDialog";

export function ControlBar() {
  const { runState, credentials, log } = useBotStore();
  const [flatten, setFlatten] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const [prepOpen, setPrepOpen] = useState(false);
  const [prepSteps, setPrepSteps] = useState<PrepStep[]>([]);
  const [preflight, setPreflight] = useState<PreflightResult>({
    status: "idle",
    label: "Not checked",
  });

  // Reset preflight whenever credentials change.
  useEffect(() => {
    setPreflight({ status: "idle", label: "Not checked" });
  }, [credentials?.keyId, credentials?.env, credentials?.corsProxy]);

  const check = async (): Promise<PreflightResult> => {
    setPreflight({ status: "checking", label: "Checking…" });
    const r = await runPreflight(credentials);
    setPreflight(r);
    log(
      r.status === "ok" ? "info" : "warn",
      `preflight: ${r.label}${r.detail ? ` — ${r.detail}` : ""}`
    );
    return r;
  };

  const handleStart = async () => {
    const r = preflight.status === "ok" ? preflight : await check();
    if (r.status !== "ok") {
      toast.error(`Preflight failed: ${r.label}`, { description: r.detail });
      return;
    }
    // Make sure the simulation has the data it needs: BTC spot price and the
    // BTC hourly markets list. Show a dedicated progress dialog while we
    // prefetch them so the user has clear feedback.
    const ok = await runPrep();
    if (!ok) return;
    setSimOpen(true);
  };

  const updateStep = (id: string, patch: Partial<PrepStep>) => {
    setPrepSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  /**
   * Prefetch BTC spot + markets list with live progress in a modal.
   * Returns true on success (caller can open the simulation dialog).
   */
  const runPrep = async (): Promise<boolean> => {
    const s = useBotStore.getState();
    if (!s.credentials) return false;
    // Refresh account inputs even when market and spot data are already cached.
    // Preflight only validates access; it does not populate the simulation store.
    try {
      const client = new KalshiClient(s.credentials);
      const [balance, positions] = await Promise.all([
        client.getBalance(),
        client.getPositions(),
      ]);
      const current = useBotStore.getState();
      if (current.credentials !== s.credentials || current.runState !== s.runState) return false;
      if (![balance.balance, balance.portfolio_value].every(Number.isFinite) || balance.balance < 0) {
        throw new Error("Invalid account snapshot");
      }
      current.setBalance(balance.balance / 100);
      current.setPortfolioValue(balance.portfolio_value / 100);
      current.setPositions(positions);
    } catch (error) {
      toast.error("Could not refresh account for simulation", {
        description: error instanceof Error ? error.message : "Account data unavailable",
      });
      return false;
    }
    const needsSpot = s.btcSpot <= 0;
    const needsMarkets = s.markets.length === 0;
    if (!needsSpot && !needsMarkets) return true;

    const initial: PrepStep[] = [
      {
        id: "spot",
        label: "Fetching BTC spot price",
        status: needsSpot ? "pending" : "skipped",
        detail: needsSpot ? "Coinbase public ticker" : "Already loaded",
      },
      {
        id: "markets",
        label: "Loading BTC 15-minute markets",
        status: needsMarkets ? "pending" : "skipped",
        detail: needsMarkets ? "Kalshi /markets" : "Already loaded",
      },
    ];
    setPrepSteps(initial);
    setPrepOpen(true);

    let allOk = true;
    const jobs: Promise<unknown>[] = [];

    if (needsSpot) {
      updateStep("spot", { status: "running" });
      jobs.push(
        fetchBtcSpot()
          .then((p) => {
            useBotStore.getState().setBtcSpot(p);
            updateStep("spot", {
              status: "done",
              detail: `$${p.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
            });
          })
          .catch((e) => {
            allOk = false;
            updateStep("spot", { status: "error", detail: (e as Error).message });
          }),
      );
    }

    if (needsMarkets && s.credentials) {
      updateStep("markets", { status: "running" });
      const client = new KalshiClient(s.credentials);
      jobs.push(
        client
          .getBtc15MinMarkets()
          .then((m) => {
            useBotStore.getState().setMarkets(m);
            updateStep("markets", {
              status: "done",
              detail: `${m.length} market${m.length === 1 ? "" : "s"} loaded`,
            });
          })
          .catch((e) => {
            allOk = false;
            updateStep("markets", { status: "error", detail: (e as Error).message });
          }),
      );
    }

    await Promise.all(jobs);

    if (!allOk) {
      // Leave the dialog open briefly so the user sees the error, then close.
      toast.error("Could not prepare simulation", {
        description: "See the preparation dialog for details.",
      });
      setTimeout(() => setPrepOpen(false), 1800);
      return false;
    }

    // Brief delay so the user actually sees the "done" state.
    setTimeout(() => setPrepOpen(false), 250);
    return true;
  };

  const canStart = !!credentials && runState !== "running";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
      <PreStartSimulation
        open={simOpen}
        onOpenChange={setSimOpen}
        onConfirm={() => start()}
      />
      <PreparingSimulationDialog open={prepOpen} steps={prepSteps} />
      <Button
        size="lg"
        variant="default"
        disabled={!canStart}
        onClick={() => void handleStart()}
        className="bg-success text-success-foreground hover:bg-success/90"
      >
        <Play /> Start
      </Button>
      <Button
        size="lg"
        variant="secondary"
        disabled={runState !== "running"}
        onClick={() => pause()}
      >
        <Pause /> Pause
      </Button>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void check()}
              disabled={preflight.status === "checking"}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:opacity-80 ${PREFLIGHT_BADGE_CLASS[preflight.status]}`}
            >
              {preflight.status === "checking" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              <span>{preflight.label}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p className="text-xs">
              {preflight.detail ?? "Click to run a preflight check (validates credentials, signature, and CORS proxy)."}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch id="flatten" checked={flatten} onCheckedChange={setFlatten} />
          <Label htmlFor="flatten">Auto-flatten on kill</Label>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="lg" variant="destructive" className="font-bold uppercase tracking-wider shadow-lg">
              <Skull /> Kill Switch
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Kill the bot?</AlertDialogTitle>
              <AlertDialogDescription>
                Cancels every open order immediately{flatten ? " and market-flattens all positions" : ""}. The scheduler stops.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void killAll(flatten)}
              >
                Kill it
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
