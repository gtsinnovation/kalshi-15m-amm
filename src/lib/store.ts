import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { KalshiCredentials, KalshiMarket, KalshiPosition } from "./kalshi/types";
import type { EncryptedCredentials } from "./security/vault";
import { appendAuditEntry, appendTickerMismatch, type TickerMismatchEntry } from "./audit/logStore";

export type RunState = "idle" | "running" | "paused" | "killed";

export interface CircuitBreakerTrip {
  /** Type of stop that triggered the kill switch. */
  type: "max-loss-per-minute" | "daily-stop-loss" | "consecutive-losing-cycles" | "intra-cycle-drawdown";
  /** Human-readable reason for the audit log + UI. */
  reason: string;
  /** $ drop measured in the rolling 60s window (only for max-loss/min). */
  dropDollars?: number;
  /** Configured limit ($) at the time of trip. */
  limitDollars?: number;
  /** Equity at trip ($). */
  equityAtTrip?: number;
  /** When the trip happened (ms). */
  ts: number;
  /** When (and by which limits) the user re-armed; cleared on next trip. */
  acknowledgedAt?: number;
}
export type LogLevel = "info" | "warn" | "error" | "quote" | "fill";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  ticker?: string;
}

export interface PnlPoint {
  ts: number;
  realized: number;
  unrealized: number;
  equity: number;
}

export interface FillabilityThresholds {
  pinnedBidMax: number;
  pinnedAskMin: number;
  outsideBookGap: number;
}

export interface StrategyParams {
  gamma: number; // risk aversion
  sigmaAnnual: number; // annualized vol of BTC (e.g. 0.6 = 60%)
  k: number; // order-flow intensity
  tickIntervalMs: number;
  minEdgeCents: number; // min edge above mid before quoting
  maxQuoteSize: number; // contracts per side
  requoteThresholdCents: number; // re-quote only if price moved by this much
  /** Max age (seconds) of book snapshot before we skip quoting. */
  maxBookAgeSec: number;
  /** Minimum ask/bid price ratio. e.g. 4 means ask ≥ 4 × bid. */
  askBidRatio: number;
  /** Global fillability validation thresholds. */
  fillability: FillabilityThresholds;
}

export interface RiskLimits {
  perMarketPositionCap: number;
  globalDollarExposureCap: number;
  dailyStopLossDollars: number;
  autoFlattenOnStop: boolean;
  /**
   * Pre-start safety threshold as a percent of available balance. If the
   * simulated worst-case reserved collateral would exceed
   *   balance × (collateralSafetyPct / 100)
   * the Start button in the pre-start simulation is disabled.
   */
  collateralSafetyPct: number;
  /**
   * Hard cap on the total number of resting orders across all tracked
   * tickers. The scheduler will skip placing new orders for a ticker
   * once this many orders are already on the book. 0 disables the cap.
   */
  maxOpenOrders: number;
  /**
   * 15-minute cycle safety stop: if this many consecutive *settled* 15-min
   * cycles realize a net loss, the bot auto-pauses. 0 disables.
   */
  maxConsecutiveLosingCycles: number;
  /**
   * 15-minute cycle safety stop: if equity drops more than this many dollars
   * from the cycle's starting equity *within* a single 15-min cycle, the bot
   * auto-pauses. 0 disables.
   */
  intraCycleDrawdownDollars: number;
  /**
   * Circuit breaker: if equity falls more than this many dollars within any
   * rolling 60-second window, the bot auto-pauses (kill-switch, no flatten).
   * Cooldown enforced via UI re-arm. 0 disables.
   */
  maxLossPerMinuteDollars: number;
}

export interface MarketQuote {
  ticker: string;
  fairValue: number; // 0..1 probability
  ourBid: number; // cents
  ourAsk: number; // cents
  bookBid: number;
  bookAsk: number;
  position: number;
  unrealizedPnl: number;
  lastUpdated: number;
}

/** Last quote we placed per ticker — used for idempotency / re-quote threshold. */
export interface LastQuoteRecord {
  bidCents: number;
  askCents: number;
  size: number;
  bidOrderId?: string;
  askOrderId?: string;
  bidClientId?: string;
  askClientId?: string;
  ts: number;
}

export type OrderLedgerStatus = "resting" | "cancelled" | "filled" | "expired" | "unknown";

/**
 * One row per order placed by the bot, linking the order id to the
 * collateral reserved when it was placed and what was released when it
 * left the book (cancel / fill).
 */
export interface OrderLedgerEntry {
  orderId: string;
  clientOrderId?: string;
  ticker: string;
  side: "bid" | "ask"; // logical side from the bot's POV
  action: "buy" | "sell";
  priceCents: number;
  size: number;
  /** Cents Kalshi locked when this order was placed (worst-case). */
  reservedCents: number;
  /** Cents released back when the order left the book. */
  releasedCents: number;
  status: OrderLedgerStatus;
  placedAt: number;
  closedAt?: number;
  /** Last price seen if filled (cents). */
  fillPriceCents?: number;
  /**
   * Set when a fill's reported ticker disagreed with the ticker stored on
   * this order when it was placed. Surfaced in the UI as a warning badge
   * so operators can investigate Kalshi → bot reconciliation issues.
   */
  tickerMismatch?: { fillTicker: string; expectedTicker: string };
}

export interface ActualReservedSnapshot {
  totalCents: number;
  perTicker: Record<string, number>;
  /** Number of resting orders observed when this snapshot was taken. */
  orderCount: number;
  ts: number;
}

interface BotState {
  credentials: KalshiCredentials | null;
  setCredentials: (c: KalshiCredentials | null) => void;

  runState: RunState;
  setRunState: (s: RunState) => void;

  strategy: StrategyParams;
  setStrategy: (p: Partial<StrategyParams>) => void;

  risk: RiskLimits;
  setRisk: (r: Partial<RiskLimits>) => void;

  trackedTickers: string[];
  toggleTicker: (t: string) => void;

  /** Per-ticker overrides for the global StrategyParams.askBidRatio. */
  marketRatioOverrides: Record<string, number>;
  setMarketRatioOverride: (ticker: string, ratio: number | null) => void;

  /** Per-ticker overrides for fillability thresholds (partial allowed). */
  marketFillabilityOverrides: Record<string, Partial<FillabilityThresholds>>;
  setMarketFillabilityOverride: (
    ticker: string,
    patch: Partial<FillabilityThresholds> | null,
  ) => void;

  markets: KalshiMarket[];
  setMarkets: (m: KalshiMarket[]) => void;

  /** Wall-clock minute marks (0–59) at which to reload the markets list. */
  marketReloadMinutes: number[];
  setMarketReloadMinutes: (mins: number[]) => void;

  marketQuotes: Record<string, MarketQuote>;
  upsertMarketQuote: (q: MarketQuote) => void;

  positions: Record<string, KalshiPosition>;
  setPositions: (p: KalshiPosition[]) => void;

  balance: number;
  setBalance: (b: number) => void;
  portfolioValue: number;
  setPortfolioValue: (value: number) => void;

  btcSpot: number;
  setBtcSpot: (s: number) => void;

  lastTickAt: number;
  setLastTickAt: (t: number) => void;

  lastFillTs: number;
  setLastFillTs: (t: number) => void;
  seenFillIds: string[];
  addSeenFillIds: (ids: string[]) => void;

  lastQuotes: Record<string, LastQuoteRecord>;
  setLastQuote: (ticker: string, q: LastQuoteRecord) => void;
  clearLastQuote: (ticker: string) => void;

  orderLedger: OrderLedgerEntry[];
  appendOrderLedger: (entry: OrderLedgerEntry) => void;
  closeOrderLedger: (
    orderId: string,
    status: Exclude<OrderLedgerStatus, "resting" | "unknown">,
    fillPriceCents?: number,
    fillTicker?: string,
  ) => { entry: OrderLedgerEntry | null; mismatch: boolean };
  clearOrderLedger: () => void;

  actualReserved: ActualReservedSnapshot | null;
  setActualReserved: (s: ActualReservedSnapshot | null) => void;

  logs: LogEntry[];
  log: (level: LogLevel, msg: string, ticker?: string) => void;
  clearLogs: () => void;

  /** In-memory ring of structured ticker-mismatch audit entries (newest first, capped at 200). Mirrored to IndexedDB via appendTickerMismatch for export. */
  tickerMismatches: TickerMismatchEntry[];
  recordTickerMismatch: (entry: Omit<TickerMismatchEntry, "ts"> & { ts?: number }) => void;
  clearTickerMismatchStream: () => void;

  pnlHistory: PnlPoint[];
  pushPnl: (p: PnlPoint) => void;
  resetPnlHistory: () => void;

  sessionStartEquity: number;
  setSessionStartEquity: (n: number) => void;

  /** Encrypted credential blob persisted across reloads. */
  encryptedCredentials: EncryptedCredentials | null;
  setEncryptedCredentials: (e: EncryptedCredentials | null) => void;

  /** True when an encrypted vault exists but PEM hasn't been decrypted yet. */
  vaultLocked: boolean;
  setVaultLocked: (b: boolean) => void;

  /** Idle auto-lock timeout in minutes. 0 disables. */
  idleLockMinutes: number;
  setIdleLockMinutes: (n: number) => void;

  /**
   * 15-minute cycle tracker. We snapshot equity at the start of each
   * cycle and count consecutive losing cycles to enforce the
   * `maxConsecutiveLosingCycles` and `intraCycleDrawdownDollars` stops.
   */
  cycleStartEquity: number;
  cycleStartTs: number;
  consecutiveLosingCycles: number;
  setCycleSnapshot: (equity: number, ts: number) => void;
  recordCycleResult: (loss: boolean) => void;
  resetCycleStats: () => void;

  /** Most recent circuit-breaker trip; null until first trip or after re-arm reset. */
  circuitBreakerTrip: CircuitBreakerTrip | null;
  setCircuitBreakerTrip: (t: CircuitBreakerTrip | null) => void;
  acknowledgeCircuitBreaker: () => void;

  /** Rolling 60s drop snapshot (purely for the status panel). */
  lastMinuteDropDollars: number;
  setLastMinuteDropDollars: (n: number) => void;

  /** Whether the dashboard scheduler/polling is allowed to run. */
  autoRefreshEnabled: boolean;
  setAutoRefreshEnabled: (b: boolean) => void;

  /** Watchdog telemetry: tick error tracking + auto-restart book-keeping. */
  watchdog: {
    consecutiveErrors: number;
    lastErrorAt: number;
    lastError: string | null;
    restartCount: number;
    /** Set when watchdog has given up auto-restarting and needs user attention. */
    alertActive: boolean;
    alertReason: string | null;
    alertAt: number;
  };
  recordTickError: (msg: string) => void;
  recordTickSuccess: () => void;
  recordWatchdogRestart: () => void;
  raiseWatchdogAlert: (reason: string) => void;
  dismissWatchdogAlert: () => void;

  /** Per-ticker count of consecutive ratio-unfillable quotes (resets on a fillable one). */
  unfillableQuoteRuns: Record<string, { count: number; reason: string; ts: number }>;
  recordUnfillableQuote: (ticker: string, reason: string) => void;
  recordFillableQuote: (ticker: string) => void;
}

const DEFAULT_STRATEGY: StrategyParams = {
  gamma: 0.5,
  sigmaAnnual: 0.6,
  k: 1.5,
  tickIntervalMs: 5000,
  minEdgeCents: 2,
  maxQuoteSize: 5,
  requoteThresholdCents: 1,
  maxBookAgeSec: 5.0,
  askBidRatio: 4,
  fillability: { pinnedBidMax: 0.0101, pinnedAskMin: 0.9899, outsideBookGap: 0.5 },
};

const DEFAULT_RISK: RiskLimits = {
  perMarketPositionCap: 20,
  globalDollarExposureCap: 500,
  dailyStopLossDollars: 100,
  autoFlattenOnStop: false,
  collateralSafetyPct: 95,
  maxOpenOrders: 20,
  maxConsecutiveLosingCycles: 3,
  intraCycleDrawdownDollars: 25,
  maxLossPerMinuteDollars: 50,
};

export const useBotStore = create<BotState>()(
  persist(
    (set, get) => ({
      credentials: null,
      setCredentials: (c) => set({ credentials: c }),

      runState: "idle",
      setRunState: (s) => set({ runState: s }),

      strategy: DEFAULT_STRATEGY,
      setStrategy: (p) => set({ strategy: { ...get().strategy, ...p } }),

      risk: DEFAULT_RISK,
      setRisk: (r) => set({ risk: { ...get().risk, ...r } }),

      trackedTickers: [],
      toggleTicker: (t) =>
        set((s) => ({
          trackedTickers: s.trackedTickers.includes(t)
            ? s.trackedTickers.filter((x) => x !== t)
            : [...s.trackedTickers, t],
        })),

      markets: [],
      setMarkets: (m) =>
        set((s) => {
          // Diff incoming list against current to preserve object identity
          // for unchanged markets, reducing UI churn / re-renders.
          const prev = s.markets;
          const prevByTicker = new Map(prev.map((x) => [x.ticker, x]));
          let changed = prev.length !== m.length;
          const next = m.map((incoming) => {
            const old = prevByTicker.get(incoming.ticker);
            if (!old) {
              changed = true;
              return incoming;
            }
            // Shallow JSON compare is fine — KalshiMarket is a flat record.
            if (JSON.stringify(old) === JSON.stringify(incoming)) return old;
            changed = true;
            return incoming;
          });

          // Cycle rollover: when a tracked ticker expires (no longer in the
          // open markets list) carry the tracking onto the newly-listed
          // markets so the bot continues quoting after the cycle closes
          // instead of sitting idle on dead tickers.
          const openTickers = new Set(m.map((x) => x.ticker));
          const prevTickers = new Set(prev.map((x) => x.ticker));
          const tracked = s.trackedTickers;
          const survivingTracked = tracked.filter((t) => openTickers.has(t));
          const expiredTrackedCount = tracked.length - survivingTracked.length;
          let nextTracked = tracked;
          if (expiredTrackedCount > 0 || (tracked.length > 0 && survivingTracked.length === 0)) {
            // A new market requires an explicit selection and risk review.
            nextTracked = survivingTracked;
          } else if (survivingTracked.length !== tracked.length) {
            nextTracked = survivingTracked;
          }

          const patch: Partial<BotState> = {};
          if (changed) patch.markets = next;
          if (nextTracked !== tracked) patch.trackedTickers = nextTracked;
          return patch;
        }),

      marketReloadMinutes: [0, 16, 31, 45],
      setMarketReloadMinutes: (mins) => {
        const cleaned = Array.from(
          new Set(
            mins
              .map((n) => Math.floor(Number(n)))
              .filter((n) => Number.isFinite(n) && n >= 0 && n <= 59),
          ),
        ).sort((a, b) => a - b);
        set({ marketReloadMinutes: cleaned.length ? cleaned : [0, 16, 31, 45] });
      },

      marketRatioOverrides: {},
      setMarketRatioOverride: (ticker, ratio) =>
        set((s) => {
          const next = { ...s.marketRatioOverrides };
          if (ratio == null || !Number.isFinite(ratio)) {
            delete next[ticker];
          } else {
            next[ticker] = Math.max(1, ratio);
          }
          return { marketRatioOverrides: next };
        }),

      marketFillabilityOverrides: {},
      setMarketFillabilityOverride: (ticker, patch) =>
        set((s) => {
          const next = { ...s.marketFillabilityOverrides };
          if (patch == null) {
            delete next[ticker];
          } else {
            const merged = { ...(next[ticker] ?? {}), ...patch };
            // Strip undefined / non-finite values so unsetting one field works.
            for (const k of Object.keys(merged) as (keyof FillabilityThresholds)[]) {
              const v = merged[k];
              if (v == null || !Number.isFinite(v)) delete merged[k];
            }
            if (Object.keys(merged).length === 0) {
              delete next[ticker];
            } else {
              next[ticker] = merged;
            }
          }
          return { marketFillabilityOverrides: next };
        }),

      marketQuotes: {},
      upsertMarketQuote: (q) =>
        set((s) => ({ marketQuotes: { ...s.marketQuotes, [q.ticker]: q } })),

      positions: {},
      setPositions: (p) =>
        set({ positions: Object.fromEntries(p.map((x) => [x.ticker, x])) }),

      balance: 0,
      setBalance: (b) => set({ balance: b }),
      portfolioValue: 0,
      setPortfolioValue: (value) => set({ portfolioValue: value }),

      btcSpot: 0,
      setBtcSpot: (s) => set({ btcSpot: s }),

      lastTickAt: 0,
      setLastTickAt: (t) => set({ lastTickAt: t }),

      lastFillTs: 0,
      setLastFillTs: (t) => set({ lastFillTs: t }),
      seenFillIds: [],
      addSeenFillIds: (ids) =>
        set((s) => ({ seenFillIds: [...s.seenFillIds, ...ids].slice(-500) })),

      lastQuotes: {},
      setLastQuote: (ticker, q) =>
        set((s) => ({ lastQuotes: { ...s.lastQuotes, [ticker]: q } })),
      clearLastQuote: (ticker) =>
        set((s) => {
          const next = { ...s.lastQuotes };
          delete next[ticker];
          return { lastQuotes: next };
        }),

      orderLedger: [],
      appendOrderLedger: (entry) =>
        set((s) => ({
          orderLedger: [entry, ...s.orderLedger.filter((e) => e.orderId !== entry.orderId)].slice(0, 500),
        })),
      closeOrderLedger: (orderId, status, fillPriceCents, fillTicker) => {
        const prior = get().orderLedger.find((e) => e.orderId === orderId) ?? null;
        const mismatch = !!(
          prior && fillTicker && fillTicker !== "unknown" && prior.ticker !== fillTicker
        );
        let closed: OrderLedgerEntry | null = null;
        set((s) => ({
          orderLedger: s.orderLedger.map((e) => {
            if (e.orderId !== orderId || e.status !== "resting") return e;
            const next: OrderLedgerEntry = {
              ...e,
              status,
              closedAt: Date.now(),
              releasedCents: e.reservedCents,
              fillPriceCents: fillPriceCents ?? e.fillPriceCents,
              tickerMismatch:
                mismatch && fillTicker
                  ? { fillTicker, expectedTicker: e.ticker }
                  : e.tickerMismatch,
            };
            closed = next;
            return next;
          }),
        }));
        return { entry: closed ?? prior, mismatch };
      },
      clearOrderLedger: () => set({ orderLedger: [] }),

      actualReserved: null,
      setActualReserved: (snap) => set({ actualReserved: snap }),

      logs: [],
      log: (level, msg, ticker) =>
        set((s) => {
          const entry: LogEntry = { ts: Date.now(), level, msg, ticker };
          // Mirror to IndexedDB for export / post-mortem. Best effort —
          // failures must not break the in-memory log.
          void appendAuditEntry(entry).catch(() => {});
          return { logs: [entry, ...s.logs].slice(0, 500) };
        }),
      clearLogs: () => set({ logs: [] }),

      tickerMismatches: [],
      recordTickerMismatch: (raw) => {
        const entry: TickerMismatchEntry = {
          ts: raw.ts ?? Date.now(),
          orderId: raw.orderId,
          fillTicker: raw.fillTicker,
          expectedTicker: raw.expectedTicker,
          tradeId: raw.tradeId,
          kind: raw.kind,
        };
        // Mirror to IndexedDB for export / post-mortem. Best effort.
        void appendTickerMismatch(entry).catch(() => {});
        set((s) => ({
          tickerMismatches: [entry, ...s.tickerMismatches].slice(0, 200),
        }));
      },
      clearTickerMismatchStream: () => set({ tickerMismatches: [] }),

      pnlHistory: [],
      pushPnl: (p) =>
        set((s) => ({ pnlHistory: [...s.pnlHistory, p].slice(-720) })),
      resetPnlHistory: () => set({ pnlHistory: [] }),

      sessionStartEquity: 0,
      setSessionStartEquity: (n) => set({ sessionStartEquity: n }),

      encryptedCredentials: null,
      setEncryptedCredentials: (e) => set({ encryptedCredentials: e }),

      vaultLocked: false,
      setVaultLocked: (b) => set({ vaultLocked: b }),

      idleLockMinutes: 15,
      setIdleLockMinutes: (n) => set({ idleLockMinutes: n }),

      cycleStartEquity: 0,
      cycleStartTs: 0,
      consecutiveLosingCycles: 0,
      setCycleSnapshot: (equity, ts) =>
        set({ cycleStartEquity: equity, cycleStartTs: ts }),
      recordCycleResult: (loss) =>
        set((s) => ({
          consecutiveLosingCycles: loss ? s.consecutiveLosingCycles + 1 : 0,
        })),
      resetCycleStats: () =>
        set({ cycleStartEquity: 0, cycleStartTs: 0, consecutiveLosingCycles: 0 }),

      circuitBreakerTrip: null,
      setCircuitBreakerTrip: (t) => set({ circuitBreakerTrip: t }),
      acknowledgeCircuitBreaker: () =>
        set((s) =>
          s.circuitBreakerTrip
            ? { circuitBreakerTrip: { ...s.circuitBreakerTrip, acknowledgedAt: Date.now() } }
            : {},
        ),

      lastMinuteDropDollars: 0,
      setLastMinuteDropDollars: (n) => set({ lastMinuteDropDollars: n }),

      autoRefreshEnabled: true,
      setAutoRefreshEnabled: (b) => set({ autoRefreshEnabled: b }),

      watchdog: {
        consecutiveErrors: 0,
        lastErrorAt: 0,
        lastError: null,
        restartCount: 0,
        alertActive: false,
        alertReason: null,
        alertAt: 0,
      },
      recordTickError: (msg) =>
        set((s) => ({
          watchdog: {
            ...s.watchdog,
            consecutiveErrors: s.watchdog.consecutiveErrors + 1,
            lastErrorAt: Date.now(),
            lastError: msg,
          },
        })),
      recordTickSuccess: () =>
        set((s) =>
          s.watchdog.consecutiveErrors === 0
            ? {}
            : { watchdog: { ...s.watchdog, consecutiveErrors: 0, lastError: null } },
        ),
      recordWatchdogRestart: () =>
        set((s) => ({
          watchdog: { ...s.watchdog, restartCount: s.watchdog.restartCount + 1 },
        })),
      raiseWatchdogAlert: (reason) =>
        set((s) => ({
          watchdog: {
            ...s.watchdog,
            alertActive: true,
            alertReason: reason,
            alertAt: Date.now(),
          },
        })),
      dismissWatchdogAlert: () =>
        set((s) => ({
          watchdog: { ...s.watchdog, alertActive: false, alertReason: null, alertAt: 0 },
        })),

      unfillableQuoteRuns: {},
      recordUnfillableQuote: (ticker, reason) =>
        set((s) => {
          const prev = s.unfillableQuoteRuns[ticker];
          return {
            unfillableQuoteRuns: {
              ...s.unfillableQuoteRuns,
              [ticker]: { count: (prev?.count ?? 0) + 1, reason, ts: Date.now() },
            },
          };
        }),
      recordFillableQuote: (ticker) =>
        set((s) => {
          if (!s.unfillableQuoteRuns[ticker]) return {} as Partial<BotState>;
          const next = { ...s.unfillableQuoteRuns };
          delete next[ticker];
          return { unfillableQuoteRuns: next };
        }),
    }),
    {
      name: "kalshi-mm-store",
      version: 2,
      partialize: (s) => ({
        strategy: s.strategy,
        risk: s.risk,
        trackedTickers: s.trackedTickers,
        marketRatioOverrides: s.marketRatioOverrides,
        marketFillabilityOverrides: s.marketFillabilityOverrides,
        encryptedCredentials: s.encryptedCredentials,
        idleLockMinutes: s.idleLockMinutes,
        autoRefreshEnabled: s.autoRefreshEnabled,
        circuitBreakerTrip: s.circuitBreakerTrip,
        marketReloadMinutes: s.marketReloadMinutes,
      }),
      // Backfill new fields onto stores persisted before they existed so
      // old localStorage blobs don't crash the UI on reload.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<BotState>;
        return {
          ...current,
          ...p,
          risk: { ...current.risk, ...(p.risk ?? {}) },
          strategy: {
            ...current.strategy,
            ...(p.strategy ?? {}),
            fillability: {
              ...current.strategy.fillability,
              ...((p.strategy as Partial<StrategyParams> | undefined)?.fillability ?? {}),
            },
          },
          marketRatioOverrides: p.marketRatioOverrides ?? {},
          marketFillabilityOverrides: p.marketFillabilityOverrides ?? {},
          marketReloadMinutes:
            Array.isArray(p.marketReloadMinutes) && p.marketReloadMinutes.length
              ? p.marketReloadMinutes
              : current.marketReloadMinutes,
        };
      },
    }
  )
);
