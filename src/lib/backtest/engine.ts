/**
 * Synthetic backtester for K15M AMM.
 *
 * Kalshi does not expose a free public history endpoint for settled BTC
 * 15-minute markets, so we reconstruct cycles from a public BTC-USD spot
 * series instead. The fidelity tradeoff:
 *
 *   - Spot path:  REAL — Coinbase /products/BTC-USD/candles, 15m granularity.
 *   - Strikes:    synthesized as a $250 grid around each cycle's open price
 *                 (mirrors how Kalshi's BTC 15-min "above" markets look).
 *   - Fair value: the closed-form lognormal P(S_T ≥ K) probability — same
 *                 model the live bot uses inside `aboveProbability`.
 *   - Synthetic book: a symmetric spread around fair value with width
 *                 `bookHalfSpreadCents`. This stands in for real Kalshi
 *                 liquidity.
 *   - Fills:      a bid fills if our bid ≥ synthetic_ask, an ask fills if
 *                 our ask ≤ synthetic_bid (i.e. we crossed). Otherwise the
 *                 quote rests for the cycle and expires worthless.
 *   - Settlement: each cycle settles at the bucket's close price; YES pays
 *                 100¢ if close ≥ strike, else 0¢.
 *
 * This is good enough to validate parameter sensitivity (γ, σ, k, edge,
 * size) and to compute realistic-shape P&L curves, hit rate, and drawdown,
 * but it WILL be optimistic vs. live — real markets won't always have a
 * neat symmetric book and real fills require a counterparty.
 */

import { aboveProbability } from "@/lib/strategy/avellaneda";
import type { StrategyParams } from "@/lib/store";

export interface BacktestParams {
  /** Number of 15-minute cycles to backtest (most recent N). */
  cycles: number;
  /** Strike grid spacing in dollars. */
  strikeStepDollars: number;
  /** Number of strikes on each side of the cycle's open price. */
  strikesPerSide: number;
  /** Half-spread of the *synthetic book* in cents (1..50). */
  bookHalfSpreadCents: number;
  /**
   * Optional override of the strategy params used for quoting. If omitted
   * the engine falls back to the live store's defaults.
   */
  strategy: Pick<
    StrategyParams,
    "gamma" | "sigmaAnnual" | "k" | "minEdgeCents" | "maxQuoteSize"
  >;
}

export interface CycleResult {
  /** ms timestamp of the cycle start (aligned to :00/:15/:30/:45). */
  startTs: number;
  /** ms timestamp the cycle settled. */
  endTs: number;
  /** BTC spot at cycle start. */
  openSpot: number;
  /** BTC spot at cycle close — settles all strikes. */
  closeSpot: number;
  /** Number of strikes simulated this cycle. */
  strikes: number;
  /** Total fills across all strikes this cycle. */
  fills: number;
  /** Net cents P&L this cycle (after settlement). */
  pnlCents: number;
}

export interface BacktestSummary {
  cycles: CycleResult[];
  totals: {
    cycles: number;
    fills: number;
    pnlDollars: number;
    /** Fraction of cycles with non-negative P&L (0..1). */
    hitRate: number;
    /** Max peak-to-trough drawdown of cumulative P&L, in dollars. */
    maxDrawdownDollars: number;
    /** Average dollar P&L per cycle. */
    avgCyclePnl: number;
    /** Sample standard deviation of cycle P&L. */
    cyclePnlStdDev: number;
    /** Sharpe-like ratio: mean / std (dimensionless, per-cycle). */
    sharpePerCycle: number;
  };
}

export interface CandleBar {
  /** Bucket start time in ms. */
  ts: number;
  open: number;
  close: number;
  high: number;
  low: number;
}

/**
 * Fetch 15-minute BTC-USD candles from Coinbase public exchange API.
 * Returns oldest-first. Coinbase returns at most 300 candles per call,
 * so we page backwards as needed.
 */
export async function fetchBtcCandles15m(count: number): Promise<CandleBar[]> {
  const granularity = 900; // 15 min in seconds
  const all: CandleBar[] = [];
  // Align "now" down to the most recent CLOSED 15-min boundary so we never
  // include a partially-formed bucket.
  const nowSec = Math.floor(Date.now() / 1000);
  let endSec = Math.floor(nowSec / granularity) * granularity;
  // Coinbase caps responses at 300 candles per request.
  const chunk = 300;
  while (all.length < count) {
    const startSec = endSec - chunk * granularity;
    const url =
      `https://api.exchange.coinbase.com/products/BTC-USD/candles` +
      `?granularity=${granularity}` +
      `&start=${new Date(startSec * 1000).toISOString()}` +
      `&end=${new Date(endSec * 1000).toISOString()}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(
        `Coinbase candles fetch failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
    // Coinbase returns rows as [time, low, high, open, close, volume],
    // newest-first, with `time` in seconds.
    const rows = (await res.json()) as number[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      all.push({
        ts: r[0] * 1000,
        low: r[1],
        high: r[2],
        open: r[3],
        close: r[4],
      });
    }
    endSec = startSec;
    if (rows.length < chunk) break; // ran out of history
  }
  // Dedup + sort oldest-first, then take the most recent `count`.
  const seen = new Map<number, CandleBar>();
  for (const c of all) seen.set(c.ts, c);
  const closedBefore = Math.floor(nowSec / granularity) * granularity * 1000;
  const sorted = Array.from(seen.values()).filter(c => c.ts < closedBefore && c.ts + granularity * 1000 <= closedBefore && [c.open, c.close, c.high, c.low].every(v => Number.isFinite(v) && v > 0)).sort((a, b) => a.ts - b.ts);
  return sorted.slice(-count);
}

/** Run the synthetic backtest. Pure function — no network, no store. */
export function runBacktest(
  candles: CandleBar[],
  params: BacktestParams,
): BacktestSummary {
  const cycles: CycleResult[] = [];
  const cycleSec = 15 * 60;
  const yearSec = 365 * 24 * 3600;

  for (const bar of candles.slice(-Math.max(0, Math.floor(params.cycles)))) {
    const open = bar.open;
    const close = bar.close;
    if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) continue;

    // Build strike grid centered on open, snapped to step.
    const step = params.strikeStepDollars;
    const center = Math.round(open / step) * step;
    const strikes: number[] = [];
    for (let i = -params.strikesPerSide; i <= params.strikesPerSide; i++) {
      strikes.push(center + i * step);
    }

    let cycleFills = 0;
    let cyclePnlCents = 0;

    for (const strike of strikes) {
      // We quote ONCE at cycle start with full time-to-expiry. A more
      // ambitious sim would re-quote intra-cycle as spot drifts; this
      // single-shot model is conservative and far cheaper.
      const T = cycleSec / yearSec;
      const fair = aboveProbability(open, strike, undefined, params.strategy.sigmaAnnual, T);

      // Synthetic book around the true fair value.
      const halfDollar = params.bookHalfSpreadCents / 100;
      const bookBid = Math.max(0.01, Math.min(0.99, fair - halfDollar));
      const bookAsk = Math.max(0.01, Math.min(0.99, fair + halfDollar));

      // Avellaneda-Stoikov half-spread (no inventory: r ≡ fair).
      const sig = params.strategy.sigmaAnnual;
      const sig2 = sig * sig;
      const delta =
        (params.strategy.gamma * sig2 * T) / 2 +
        (1 / params.strategy.gamma) *
          Math.log(1 + params.strategy.gamma / params.strategy.k);
      const minEdge = params.strategy.minEdgeCents / 100;
      const halfSpread = Math.max(delta, minEdge);

      const ourBid = Math.max(0.01, Math.min(0.99, fair - halfSpread));
      const ourAsk = Math.max(0.01, Math.min(0.99, fair + halfSpread));
      const size = params.strategy.maxQuoteSize;

      // Settlement: YES pays 100¢ if close ≥ strike.
      const yesPayoutCents = close >= strike ? 100 : 0;

      // Bid fills when we cross the synthetic ask.
      if (ourBid > bookAsk) {
        const fillPriceCents = Math.round(bookAsk * 100);
        cycleFills += size;
        cyclePnlCents += (yesPayoutCents - fillPriceCents) * size;
      }
      // Ask fills (sell YES) when we cross the synthetic bid.
      if (ourAsk < bookBid) {
        const fillPriceCents = Math.round(bookBid * 100);
        cycleFills += size;
        cyclePnlCents += (fillPriceCents - yesPayoutCents) * size;
      }
    }

    cycles.push({
      startTs: bar.ts,
      endTs: bar.ts + cycleSec * 1000,
      openSpot: open,
      closeSpot: close,
      strikes: strikes.length,
      fills: cycleFills,
      pnlCents: cyclePnlCents,
    });
  }

  return summarize(cycles);
}

function summarize(cycles: CycleResult[]): BacktestSummary {
  if (cycles.length === 0) {
    return {
      cycles,
      totals: {
        cycles: 0,
        fills: 0,
        pnlDollars: 0,
        hitRate: 0,
        maxDrawdownDollars: 0,
        avgCyclePnl: 0,
        cyclePnlStdDev: 0,
        sharpePerCycle: 0,
      },
    };
  }
  const pnls = cycles.map((c) => c.pnlCents / 100);
  const fills = cycles.reduce((a, c) => a + c.fills, 0);
  const pnlDollars = pnls.reduce((a, b) => a + b, 0);
  const activeCycles = cycles.filter(c => c.fills > 0);
  const hits = activeCycles.filter((c) => c.pnlCents >= 0).length;

  // Equity curve + max drawdown.
  let peak = 0;
  let maxDd = 0;
  let running = 0;
  for (const p of pnls) {
    running += p;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDd) maxDd = dd;
  }

  const mean = pnlDollars / pnls.length;
  const variance =
    pnls.reduce((a, p) => a + (p - mean) * (p - mean), 0) / Math.max(1, pnls.length - 1);
  const std = Math.sqrt(variance);

  return {
    cycles,
    totals: {
      cycles: cycles.length,
      fills,
      pnlDollars,
      hitRate: activeCycles.length ? hits / activeCycles.length : 0,
      maxDrawdownDollars: maxDd,
      avgCyclePnl: mean,
      cyclePnlStdDev: std,
      sharpePerCycle: std > 0 ? mean / std : 0,
    },
  };
}
