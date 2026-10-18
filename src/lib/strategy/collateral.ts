import type { KalshiMarket } from "../kalshi/types";
import type { MarketQuote, StrategyParams } from "../store";
import type { KalshiPosition, KalshiOrder } from "../kalshi/types";
import { computeQuotes } from "./avellaneda";

export interface CollateralBreakdown {
  ticker: string;
  bidCents: number;
  askCents: number;
  size: number;
  bidReservedCents: number; // collateral locked by the resting BUY YES
  askReservedCents: number; // collateral locked by the resting SELL YES (short)
  totalReservedCents: number;
  /**
   * Probability-weighted expected loss (in cents) on this pair of quotes,
   * assuming both fill and the implied probabilities from the prices are
   * the true outcome distribution. For a BUY YES @ p the adverse outcome
   * is NO winning (prob ≈ (100−p)/100); for a SELL YES @ p the adverse
   * outcome is YES winning (prob ≈ p/100). Both reduce to
   *   p × (100 − p) × size / 100
   * per filled side. This is a more realistic "expected collateral at
   * risk" figure than the worst-case lock Kalshi actually reserves.
   */
  bidExpectedCents: number;
  askExpectedCents: number;
  totalExpectedCents: number;
}

/**
 * Kalshi locks collateral on resting limit orders:
 *  - BUY YES @ p¢  × n contracts → reserves p × n cents (max loss if NO wins).
 *  - SELL YES @ p¢ × n contracts → reserves (100 − p) × n cents (max loss if YES wins),
 *    but only the portion that would open / increase a short position.
 *
 * Inventory offsets:
 *  - When `inventoryYes > 0` (long YES), a SELL of up to that many contracts
 *    only flattens the long — no new collateral is reserved for that portion.
 *  - When `inventoryYes < 0` (short YES), a BUY of up to |inventoryYes|
 *    contracts only covers the short — no new collateral is reserved for
 *    that portion (the original short collateral is already locked).
 */
export function reservedForQuote(
  bidCents: number,
  askCents: number,
  size: number,
  inventoryYes = 0
): CollateralBreakdown {
  // BUY collateral only applies to the portion that opens / extends a long.
  // If inventory is short (negative), the first |inv| BUYs cover the short.
  const shortCovered = Math.max(0, -inventoryYes);
  const buyOpensLong = Math.max(0, size - shortCovered);
  const bidReservedCents = bidCents * buyOpensLong;

  // SELL collateral only applies to the portion that opens / extends a short.
  // If inventory is long (positive), the first inv SELLs flatten the long.
  const longCovered = Math.max(0, inventoryYes);
  const sellOpensShort = Math.max(0, size - longCovered);
  const askReservedCents = (100 - askCents) * sellOpensShort;

  // Expected loss = worst_case × P(adverse). The implied adverse probability
  // for the BUY YES leg is (100 − bid)/100 and for the SELL YES leg is ask/100.
  const bidExpectedCents = (bidCents * (100 - bidCents) * buyOpensLong) / 100;
  const askExpectedCents = ((100 - askCents) * askCents * sellOpensShort) / 100;

  return {
    ticker: "",
    bidCents,
    askCents,
    size,
    bidReservedCents,
    askReservedCents,
    totalReservedCents: bidReservedCents + askReservedCents,
    bidExpectedCents,
    askExpectedCents,
    totalExpectedCents: bidExpectedCents + askExpectedCents,
  };
}

/**
 * Estimate collateral that *will* be reserved on start, by simulating the
 * first round of A-S quotes for every tracked market at current spot.
 */
export function simulateStartCollateral(args: {
  markets: KalshiMarket[];
  trackedTickers: string[];
  positions: Record<string, KalshiPosition>;
  spot: number;
  strategy: StrategyParams;
  nowMs?: number;
}): {
  perMarket: (CollateralBreakdown & { fairValue: number })[];
  totalCents: number;
} {
  const now = args.nowMs ?? Date.now();
  const tracked = new Set(args.trackedTickers);
  const perMarket: (CollateralBreakdown & { fairValue: number })[] = [];
  let totalCents = 0;
  for (const m of args.markets) {
    if (!tracked.has(m.ticker)) continue;
    const pos = args.positions[m.ticker]?.position ?? 0;
    const q = computeQuotes(m, args.spot, pos, args.strategy, now);
    const r = reservedForQuote(q.bidCents, q.askCents, args.strategy.maxQuoteSize, pos);
    const row = { ...r, ticker: m.ticker, fairValue: q.fairValue };
    perMarket.push(row);
    totalCents += r.totalReservedCents;
  }
  return { perMarket, totalCents };
}

/**
 * Collateral currently reserved by quotes the bot is showing (using the live
 * `marketQuotes` map). Used by the dashboard panel.
 */
export function liveReservedFromQuotes(
  marketQuotes: Record<string, MarketQuote>,
  trackedTickers: string[],
  positions: Record<string, KalshiPosition>,
  size: number
): { perMarket: CollateralBreakdown[]; totalCents: number } {
  const tracked = new Set(trackedTickers);
  const perMarket: CollateralBreakdown[] = [];
  let totalCents = 0;
  for (const ticker of Object.keys(marketQuotes)) {
    if (!tracked.has(ticker)) continue;
    const q = marketQuotes[ticker];
    if (!q) continue;
    const pos = positions[ticker]?.position ?? 0;
    const r = reservedForQuote(q.ourBid, q.ourAsk, size, pos);
    perMarket.push({ ...r, ticker });
    totalCents += r.totalReservedCents;
  }
  return { perMarket, totalCents };
}

/**
 * Compute Kalshi's *actual* reserved collateral by summing the worst-case
 * loss across every resting limit order returned by `/portfolio/orders`.
 *
 * For each open order we use Kalshi's collateral rule directly:
 *   - BUY  YES @ p¢ × n → p       × n cents reserved
 *   - SELL YES @ p¢ × n → (100−p) × n cents reserved
 *   - BUY  NO  @ p¢ × n → p       × n cents reserved
 *   - SELL NO  @ p¢ × n → (100−p) × n cents reserved
 *
 * NOTE: This does not net against existing inventory because we don't know
 * which open orders Kalshi has already discounted for inventory offsets;
 * we treat the API's resting-orders list as the ground-truth basis for the
 * gross worst-case lock. Inventory-aware *estimates* live in the helpers
 * above for what the bot *will* place.
 */
export interface ActualReservedRow {
  ticker: string;
  orderId: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  priceCents: number;
  count: number;
  reservedCents: number;
}

export function actualReservedFromOpenOrders(
  orders: KalshiOrder[]
): { perOrder: ActualReservedRow[]; perTicker: Record<string, number>; totalCents: number } {
  const perOrder: ActualReservedRow[] = [];
  const perTicker: Record<string, number> = {};
  let totalCents = 0;
  for (const o of orders) {
    const priceCents = o.side === "yes" ? o.yes_price : o.no_price;
    if (!Number.isFinite(priceCents) || !Number.isFinite(o.count) || o.count < 0) {
      throw new Error("Invalid order collateral input");
    }
    const reservedCents =
      o.action === "buy" ? priceCents! * o.count : (100 - priceCents!) * o.count;
    perOrder.push({
      ticker: o.ticker,
      orderId: o.order_id,
      side: o.side,
      action: o.action,
      priceCents: priceCents!,
      count: o.count,
      reservedCents,
    });
    perTicker[o.ticker] = (perTicker[o.ticker] ?? 0) + reservedCents;
    totalCents += reservedCents;
  }
  return { perOrder, perTicker, totalCents };
}
