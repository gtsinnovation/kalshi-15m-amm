import type { KalshiOrder, KalshiPosition } from "./types";

function numeric(value: unknown, field: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || value === "" || !Number.isFinite(Number(value))) {
    throw new Error(`Invalid or missing Kalshi ${field}`);
  }
  return Number(value);
}

function cents(row: Record<string, unknown>, legacy: string, dollars: string): number {
  return row[dollars] != null ? numeric(row[dollars], dollars) * 100 : numeric(row[legacy], legacy);
}

export function normalizePosition(row: Record<string, unknown>): KalshiPosition {
  if (typeof row.ticker !== "string" || !row.ticker) throw new Error("Missing position ticker");
  return {
    ...row,
    ticker: row.ticker,
    position: numeric(row.position_fp ?? row.position, "position"),
    realized_pnl: cents(row, "realized_pnl", "realized_pnl_dollars"),
    market_exposure: cents(row, "market_exposure", "market_exposure_dollars"),
    total_traded: cents(row, "total_traded", "total_traded_dollars"),
    resting_orders_count: numeric(row.resting_orders_count ?? 0, "resting_orders_count"),
  };
}

export function normalizeOrder(row: Record<string, unknown>): KalshiOrder {
  if (typeof row.order_id !== "string" || typeof row.ticker !== "string" || !["yes", "no"].includes(String(row.side)) || !["buy", "sell"].includes(String(row.action))) {
    throw new Error("Unsupported Kalshi order schema");
  }
  const yes = cents(row, "yes_price", "yes_price_dollars");
  const no = row.no_price != null || row.no_price_dollars != null ? cents(row, "no_price", "no_price_dollars") : 100 - yes;
  const count = numeric(row.remaining_count_fp ?? row.remaining_count ?? row.count, "remaining count");
  if (count < 0 || yes < 0 || yes > 100 || no < 0 || no > 100) throw new Error("Invalid order quantities");
  return { ...row, order_id: row.order_id, ticker: row.ticker, side: row.side as "yes" | "no", action: row.action as "buy" | "sell", type: row.type === "market" ? "market" : "limit", yes_price: yes, no_price: no, count, status: String(row.status ?? "unknown"), created_time: String(row.created_time ?? "") };
}
