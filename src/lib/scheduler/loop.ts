import { KalshiClient, fetchBtcSpot } from "../kalshi/client";
import { generateQuotes, type MarketState as AsMarketState } from "../strategy/asMm";
import { useBotStore, type MarketQuote, type LastQuoteRecord } from "../store";
import type { KalshiMarket } from "../kalshi/types";
import { reservedForQuote, actualReservedFromOpenOrders } from "../strategy/collateral";
import { mapLimit } from "../utils/mapLimit";

/** Max parallel Kalshi requests during bulk cancel — protects against 429s. */
const CANCEL_CONCURRENCY = 5;

function fmtUsd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message?.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const maybeMessage = Reflect.get(error, "message");
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage.trim();
    const maybeName = Reflect.get(error, "name");
    if (typeof maybeName === "string" && maybeName.trim()) return maybeName.trim();
  }
  return "Unknown error";
}

let timer: number | null = null;
let ticking = false;
let runGeneration = 0;

/** Per-ticker mutex to prevent overlapping quote operations. */
const tickerLocks = new Set<string>();

/** In-flight client_order_ids — avoid double-submitting the same logical order. */
const inFlightClientIds = new Set<string>();

async function makeClientId(
  ticker: string,
  side: "bid" | "ask",
  priceCents: number,
  size: number,
): Promise<string> {
  return crypto.randomUUID();
}

async function waitForCancels(client: KalshiClient, ticker: string, maxWaitMs = 3000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const remaining = await client.getOpenOrders(ticker);
      if (remaining.length === 0) return true;
    } catch {
      // ignore transient errors and retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function refreshMarkets(client: KalshiClient) {
  try {
    const markets = await client.getBtc15MinMarkets();
    useBotStore.getState().setMarkets(markets);
    useBotStore
      .getState()
      .log("info", `loaded ${markets.length} BTC 15-min markets`);
  } catch (e) {
    useBotStore.getState().log("warn", `refreshMarkets: ${errorMessage(e)}`);
    throw e;
  }
}

async function syncAccount(client: KalshiClient) {
  try {
    const [bal, positions, openOrders] = await Promise.all([
      client.getBalance(),
      client.getPositions(),
      client.getOpenOrders(),
    ]);
    if (![bal.balance, bal.portfolio_value].every(Number.isFinite)) throw new Error("Invalid cash or portfolio value");
    useBotStore.getState().setBalance(bal.balance / 100);
    useBotStore.getState().setPortfolioValue(bal.portfolio_value / 100);
    useBotStore.getState().setPositions(positions);
    const snap = actualReservedFromOpenOrders(openOrders);
    useBotStore.getState().setActualReserved({
      totalCents: snap.totalCents,
      perTicker: snap.perTicker,
      orderCount: openOrders.length,
      ts: Date.now(),
    });
  } catch (e) {
    useBotStore.getState().log("warn", `syncAccount: ${errorMessage(e)}`);
    throw e;
  }
}

async function pollFills(client: KalshiClient) {
  const s = useBotStore.getState();
  // Look back from the last fill we saw, with a 60s overlap to be safe.
  const sinceMs = s.lastFillTs > 0 ? s.lastFillTs - 60_000 : Date.now() - 5 * 60_000;
  try {
    const fills = await client.getFills({ min_ts: sinceMs, limit: 100 });
    if (fills.length === 0) return;
    const seen = new Set(s.seenFillIds);
    const fresh = fills.filter((f) => !seen.has(f.trade_id));
    if (fresh.length === 0) return;
    let maxTs = s.lastFillTs;
    for (const f of fresh) {
      // Newer Kalshi API returns prices as decimal-dollar strings
      // (`yes_price_dollars`) and counts as decimal strings (`count_fp`).
      // Legacy responses used integer cents (`yes_price`) and integer counts
      // (`count`). Support both so the log never shows "undefined".
      const yesPriceCents =
        f.yes_price ??
        (f.yes_price_dollars != null ? Math.round(parseFloat(f.yes_price_dollars) * 100) : undefined);
      const noPriceCents =
        f.no_price ??
        (f.no_price_dollars != null ? Math.round(parseFloat(f.no_price_dollars) * 100) : undefined);
      const price = f.side === "yes" ? yesPriceCents : noPriceCents;
      const count =
        f.count ?? (f.count_fp != null ? parseFloat(f.count_fp) : undefined);
      const ts = new Date(f.created_time).getTime();
      if (ts > maxTs) maxTs = ts;

      // ---- Ticker reconciliation ----
      // Prefer the fill's own ticker, falling back to market_ticker, then to
      // the order ledger's stored ticker. If the fill reports a ticker that
      // disagrees with what we placed, flag the mismatch on the ledger row
      // and emit a warn-level log entry so operators can investigate.
      const fillTickerRaw = f.ticker ?? f.market_ticker ?? null;
      const ledgerEntry = s.orderLedger.find((e) => e.orderId === f.order_id) ?? null;
      const expectedTicker = ledgerEntry?.ticker ?? null;

      let resolvedTicker: string | null =
        fillTickerRaw && fillTickerRaw !== "unknown" ? fillTickerRaw : expectedTicker;

      if (fillTickerRaw && expectedTicker && fillTickerRaw !== expectedTicker) {
        s.log(
          "warn",
          `fill ticker mismatch: order=${f.order_id} fill=${fillTickerRaw} expected=${expectedTicker}; using expected`,
          expectedTicker,
        );
        s.recordTickerMismatch({
          orderId: f.order_id,
          fillTicker: fillTickerRaw,
          expectedTicker,
          tradeId: f.trade_id,
          kind: "mismatch",
          ts,
        });
        // Prefer the ledger's expected ticker — that's the market we sized
        // collateral against and the one the user sees in the UI.
        resolvedTicker = expectedTicker;
      }

      // Hard assertion: we must always resolve a ticker. If neither the fill
      // nor the ledger gives us one, emit an error and skip logging/closing
      // so we don't poison the audit trail with "unknown".
      if (!resolvedTicker) {
        s.log(
          "error",
          `fill cannot resolve ticker (no fill.ticker / market_ticker and no ledger entry): order=${f.order_id} trade=${f.trade_id}`,
        );
        s.recordTickerMismatch({
          orderId: f.order_id,
          fillTicker: fillTickerRaw,
          expectedTicker,
          tradeId: f.trade_id,
          kind: "unresolved",
          ts,
        });
        continue;
      }

      s.log(
        "fill",
        `${f.action.toUpperCase()} ${count ?? "?"} @ ${price ?? "?"}¢ ${f.is_taker ? "(taker)" : "(maker)"} order=${f.order_id}`,
        resolvedTicker,
      );
      // Mark the order as filled in the ledger (releases collateral row).
      const complete = !!ledgerEntry && count === ledgerEntry.size;
      const { mismatch } = complete
        ? s.closeOrderLedger(f.order_id, "filled", price, fillTickerRaw ?? undefined)
        : { mismatch: !!(fillTickerRaw && expectedTicker && fillTickerRaw !== expectedTicker) };
      if (mismatch) {
        s.log(
          "warn",
          `ledger flagged ticker mismatch for order=${f.order_id}`,
          resolvedTicker,
        );
      }
    }
    s.addSeenFillIds(fresh.map((f) => f.trade_id));
    s.setLastFillTs(maxTs);
  } catch (e) {
    s.log("warn", `pollFills: ${errorMessage(e)}`);
  }
}

async function quoteMarket(
  client: KalshiClient,
  market: KalshiMarket,
  spot: number
) {
  const s = useBotStore.getState();

  // Per-ticker mutex
  if (tickerLocks.has(market.ticker)) {
    s.log("warn", "skipped — quote in progress", market.ticker);
    return;
  }
  tickerLocks.add(market.ticker);

  try {
  const pos = s.positions[market.ticker]?.position ?? 0;

  // Risk: per-market position cap
  if (Math.abs(pos) >= s.risk.perMarketPositionCap) {
    s.log("warn", `position cap reached (${pos})`, market.ticker);
    return;
  }

  // Risk: global cap on total resting orders.
  if (s.risk.maxOpenOrders > 0) {
    const restingCount = s.orderLedger.filter((e) => e.status === "resting").length;
    if (restingCount >= s.risk.maxOpenOrders) {
      s.log("warn", `max open orders reached (${restingCount}/${s.risk.maxOpenOrders})`, market.ticker);
      return;
    }
  }

  // Skip markets that are closed or about to close — Kalshi rejects new
  // orders on closed markets with 409 market_closed. Use a small safety
  // buffer so we don't race the closing tick.
  const CLOSE_BUFFER_SEC = 15;
  const closeMs = market.close_time ? new Date(market.close_time).getTime() : 0;
  if (!Number.isFinite(closeMs) || closeMs <= 0) throw new Error("Missing or invalid market close time");
  if (closeMs - Date.now() <= CLOSE_BUFFER_SEC * 1000) {
    s.log(
      "info",
      `market closed or closing within ${CLOSE_BUFFER_SEC}s — skipping quote`,
      market.ticker,
    );
    return;
  }
  if (market.status && market.status !== "open" && market.status !== "active") {
    s.log("info", `market status=${market.status} — skipping quote`, market.ticker);
    return;
  }

  // Build MarketState for the AS market-maker. Book prices come from
  // Kalshi in cents (1..99); the strategy operates in dollars (0.01..0.99).
  const expMs = new Date(market.expiration_time).getTime();
  const secsToExpiry = Math.max(1, Math.floor((expMs - Date.now()) / 1000));
  const globalInventory = Object.values(s.positions).reduce((a, p) => a + (p.position ?? 0), 0);

  // Live book state — refreshed by retry loop if validation fails.
  let bestBid: number | null = market.yes_bid > 0 ? market.yes_bid / 100 : null;
  let bestAsk: number | null =
    market.yes_ask > 0 && market.yes_ask < 100 ? market.yes_ask / 100 : null;

  const asCfg = {
    gamma: s.strategy.gamma,
    sigmaAnnual: s.strategy.sigmaAnnual,
    k: s.strategy.k,
    minEdgeCents: s.strategy.minEdgeCents,
    maxQuoteSize: s.strategy.maxQuoteSize,
    maxInventoryPerMarket: s.risk.perMarketPositionCap,
    maxGlobalInventory: Number.MAX_SAFE_INTEGER,
    maxBookAgeSec:
      s.strategy.maxBookAgeSec ??
      Math.max(5, (s.strategy.tickIntervalMs ?? 5000) / 1000),
    askBidRatio:
      s.marketRatioOverrides?.[market.ticker] ?? s.strategy.askBidRatio,
    fillability: {
      ...s.strategy.fillability,
      ...(s.marketFillabilityOverrides?.[market.ticker] ?? {}),
    },
  };

  /**
   * Validate-and-recompute loop: if a quote fails validation (missing
   * bid/ask, or NO-mirror legs land outside 1..99¢), re-fetch the live
   * orderbook and recompute up to MAX_ATTEMPTS times before giving up.
   */
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 250;
  let asQuote!: ReturnType<typeof generateQuotes>[number];
  let asState!: AsMarketState;
  let validationFailure: string | null = null;
  let attempt = 0;
  for (; attempt < MAX_ATTEMPTS; attempt++) {
    asState = {
      ticker: market.ticker,
      strike: market.floor_strike ?? market.cap_strike ?? 0,
      timeToExpirySec: secsToExpiry,
      bestBid,
      bestAsk,
      positionYes: pos,
      lastBookTs: Date.now() / 1000,
      spotBtc: spot,
    };
    [asQuote] = generateQuotes([asState], asCfg);

    if (asQuote.debug) {
      const d = asQuote.debug;
      const fmt = (x: number) => (x * 100).toFixed(1);
      s.log(
        "quote",
        `quote-debug${attempt > 0 ? ` (retry ${attempt})` : ""} mid=${fmt(d.mid)}¢ r=${fmt(d.reservation)}¢ ratio=${d.askBidRatio.toFixed(2)}× ` +
          `raw[${fmt(d.rawBid)}¢/${fmt(d.rawAsk)}¢] final[${fmt(d.finalBid)}¢/${fmt(d.finalAsk)}¢]` +
          (d.unfillableReason ? ` UNFILLABLE: ${d.unfillableReason}` : ""),
        market.ticker,
      );
    }

    // Validation #1: both sides present
    if (asQuote.bidPrice == null || asQuote.askPrice == null) {
      validationFailure =
        asQuote.debug?.unfillableReason ??
        (asQuote.bidPrice == null && asQuote.askPrice == null
          ? "no quote (insufficient book)"
          : asQuote.bidPrice == null
          ? "missing bid side"
          : "missing ask side");
    } else {
      // Validation #2: NO-mirror legs all within 1..99¢
      const bidC = Math.round(asQuote.bidPrice * 100);
      const askC = Math.round(asQuote.askPrice * 100);
      const noBidC = 100 - askC;
      const noAskC = 100 - bidC;
      const allLegs = [bidC, askC, noBidC, noAskC];
      if (allLegs.some((p) => !Number.isFinite(p) || p < 1 || p > 99)) {
        validationFailure =
          `invalid NO-mirror legs (yesBid=${bidC}¢ yesAsk=${askC}¢ ` +
          `noBid=${noBidC}¢ noAsk=${noAskC}¢)`;
      } else {
        validationFailure = null;
        break; // success
      }
    }

    // Validation failed — re-fetch book and try again (unless last attempt).
    if (attempt < MAX_ATTEMPTS - 1) {
      s.log(
        "warn",
        `validation failed: ${validationFailure} — refetching orderbook (attempt ${attempt + 2}/${MAX_ATTEMPTS})`,
        market.ticker,
      );
      try {
        const { orderbook } = await client.getOrderbook(market.ticker);
        // yes[] = resting YES bids; best YES bid = max price.
        // no[]  = resting NO  bids; best YES ask = 100 − max(no).
        const yesBids = orderbook.yes ?? [];
        const noBids = orderbook.no ?? [];
        const topYes = yesBids.reduce((m, [p]) => (p > m ? p : m), 0);
        const topNo = noBids.reduce((m, [p]) => (p > m ? p : m), 0);
        bestBid = topYes > 0 ? topYes / 100 : null;
        bestAsk = topNo > 0 && topNo < 100 ? (100 - topNo) / 100 : null;
      } catch (e) {
        s.log("warn", `orderbook refetch failed: ${errorMessage(e)}`, market.ticker);
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  // Record fillability outcome on the final attempt.
  if (asQuote.debug?.unfillableReason) {
    s.recordUnfillableQuote(market.ticker, asQuote.debug.unfillableReason);
  } else if (!validationFailure) {
    s.recordFillableQuote(market.ticker);
  }

  // Give up: validation still failing after retries.
  if (validationFailure) {
    s.log(
      "info",
      `${validationFailure} — blocking placement after ${MAX_ATTEMPTS} attempt(s)`,
      market.ticker,
    );
    return;
  }

  // Adapt to the existing cents-based downstream code. Use a fairValue
  // derived from the book mid for logging/UI continuity.
  const midDollars =
    asState.bestBid != null && asState.bestAsk != null
      ? 0.5 * (asState.bestBid + asState.bestAsk)
      : asState.bestBid ?? asState.bestAsk ?? 0.5;
  const quote = {
    bidCents: Math.round(asQuote.bidPrice! * 100),
    askCents: Math.round(asQuote.askPrice! * 100),
    fairValue: midDollars,
  };
  const size = s.strategy.maxQuoteSize;

  // NO-mirror legs (validated above).
  const noBidCents = 100 - quote.askCents;
  const noAskCents = 100 - quote.bidCents;

  // Re-quote threshold: skip if previous quote within threshold and still resting.
  const prev = s.lastQuotes[market.ticker];
  const threshold = s.strategy.requoteThresholdCents;
  if (
    prev &&
    Math.abs(prev.bidCents - quote.bidCents) < threshold &&
    Math.abs(prev.askCents - quote.askCents) < threshold &&
    prev.size === size
  ) {
    try {
      const open = await client.getOpenOrders(market.ticker);
      const stillResting = open.length > 0;
      if (stillResting) {
        s.log("info", `no re-quote (Δ < ${threshold}¢)`, market.ticker);
        return;
      }
    } catch {
      // fall through and re-quote
    }
  }

  // Cancel existing open orders on this ticker, then place new bid/ask.
  let cancelledCount = 0;
  let releasedCents = 0;
  try {
    const open = await client.getOpenOrders(market.ticker);
    const owned = new Set(s.orderLedger.map(e => e.orderId));
    if (open.some(o => !owned.has(o.order_id))) throw new Error("Unrecognized resting order; review exchange state before quoting");
    for (const o of open) {
      const price = o.yes_price ?? o.no_price ?? 0;
      if (o.action === "buy") releasedCents += price * o.count;
      else releasedCents += (100 - price) * o.count;
    }
    const results = await Promise.allSettled(
      open.map((o) =>
        client.cancelOrder(o.order_id).then(() => {
          s.log(
            "info",
            `cancelled ${o.order_id} (${o.action} ${o.yes_price ?? o.no_price}¢ × ${o.count})`,
            market.ticker,
          );
          s.closeOrderLedger(o.order_id, "cancelled");
          return true;
        }),
      ),
    );
    cancelledCount = results.filter((r) => r.status === "fulfilled").length;
    if (results.some(r => r.status === "rejected")) throw new Error("Cancellation failed; no replacement permitted");
    if (cancelledCount > 0 && releasedCents > 0) {
      s.log(
        "info",
        `collateral released: ${fmtUsd(releasedCents)} (${cancelledCount} order${cancelledCount === 1 ? "" : "s"} cancelled)`,
        market.ticker,
      );
    }
  } catch (e) {
    s.log("warn", `cancel: ${(e as Error).message}`, market.ticker);
    throw e;
  }

  if (cancelledCount > 0) {
    const ok = await waitForCancels(client, market.ticker);
    if (!ok) {
      s.log("warn", "cancel-confirm timeout — skipping place", market.ticker);
      return;
    }
  }

  // A single YES pair avoids duplicate directional exposure from mirrored legs.
  const canBuy = pos + size <= s.risk.perMarketPositionCap;
  const canSell = pos - size >= -s.risk.perMarketPositionCap;
  if (!canBuy || !canSell) {
    s.log(
      "warn",
      `position cap would block ${!canBuy ? "buy" : "sell"} side — blocking quote pair (pos=${pos}, cap=${s.risk.perMarketPositionCap})`,
      market.ticker,
    );
    return;
  }

  const accountOpen = await client.getOpenOrders();
  const reservation = reservedForQuote(quote.bidCents, quote.askCents, size, pos).totalReservedCents;
  const reserved = actualReservedFromOpenOrders(accountOpen).totalCents;
  const positionExposure = Object.values(useBotStore.getState().positions).reduce((total, p) => total + Math.abs(p.position) * 100, 0);
  if (![reservation, reserved, positionExposure, s.balance].every(Number.isFinite)) throw new Error("Unknown exposure or balance");
  if (s.risk.maxOpenOrders > 0 && accountOpen.length + 2 > s.risk.maxOpenOrders) throw new Error("Prospective open-order limit exceeded");
  if (positionExposure + reserved + reservation > s.risk.globalDollarExposureCap * 100) throw new Error("Global exposure limit exceeded");
  if (s.balance <= 0 || reservation > s.balance * s.risk.collateralSafetyPct) throw new Error("Collateral safety budget exceeded");

  type Leg = {
    label: string;
    contractSide: "yes" | "no";
    action: "buy" | "sell";
    priceCents: number;
    ledgerSide: "bid" | "ask";
    bookSide: "bid" | "ask";
  };
  const legs: Leg[] = [
    { label: "YES BID", contractSide: "yes", action: "buy",  priceCents: quote.bidCents, ledgerSide: "bid", bookSide: "bid" },
    { label: "YES ASK", contractSide: "yes", action: "sell", priceCents: quote.askCents, ledgerSide: "ask", bookSide: "ask" },

  ];

  let yesBidOrderId: string | undefined;
  let yesAskOrderId: string | undefined;
  let yesBidClientId: string | undefined;
  let yesAskClientId: string | undefined;

  const acceptedOrderIds: string[] = [];
  try {
    for (const leg of legs) {
      const clientId = await makeClientId(
        market.ticker,
        `${leg.contractSide}-${leg.bookSide}` as unknown as "bid" | "ask",
        leg.priceCents,
        size,
      );
      if (inFlightClientIds.has(clientId)) continue;
      inFlightClientIds.add(clientId);
      try {
        const orderArgs: Parameters<typeof client.placeOrder>[0] = {
          ticker: market.ticker,
          side: leg.contractSide,
          action: leg.action,
          count: size,
          type: "limit",
          client_order_id: clientId,
          post_only: true,
          expiration_ts: Math.floor(Math.min(Date.now() + 30_000, closeMs - 15_000) / 1000),
        };
        if (leg.contractSide === "yes") orderArgs.yes_price = leg.priceCents;
        else orderArgs.no_price = leg.priceCents;
        const r = await client.placeOrder(orderArgs);
        const orderId = r.order?.order_id;
        if (!orderId) throw new Error("Order accepted without a reconcilable ID");
        acceptedOrderIds.push(orderId);
        const current = useBotStore.getState();
        if (current.runState !== "running" || current.credentials !== s.credentials) throw new Error("Trading stopped during placement");
        const reservedCents =
          leg.action === "buy"
            ? leg.priceCents * size
            : (100 - leg.priceCents) * size;
        s.log(
          "info",
          `placed ${leg.label} ${leg.priceCents}¢ × ${size} → reserves ${fmtUsd(reservedCents)} → ${orderId ?? "?"}`,
          market.ticker,
        );
        if (orderId) {
          s.appendOrderLedger({
            orderId,
            clientOrderId: clientId,
            ticker: market.ticker,
            side: leg.ledgerSide,
            action: leg.action,
            priceCents: leg.priceCents,
            size,
            reservedCents,
            releasedCents: 0,
            status: "resting",
            placedAt: Date.now(),
          });
        }
        if (leg.contractSide === "yes" && leg.bookSide === "bid") {
          yesBidOrderId = orderId;
          yesBidClientId = clientId;
        } else if (leg.contractSide === "yes" && leg.bookSide === "ask") {
          yesAskOrderId = orderId;
          yesAskClientId = clientId;
        }
      } finally {
        inFlightClientIds.delete(clientId);
      }
    }

    // Net collateral delta vs. what was just released by the cancellations above.
    const newReserved = reservedForQuote(quote.bidCents, quote.askCents, size, pos);
    const deltaCents = newReserved.totalReservedCents - releasedCents;
    const deltaSign = deltaCents > 0 ? "+" : deltaCents < 0 ? "−" : "±";
    s.log(
      "quote",
      `YES[${quote.bidCents}/${quote.askCents}] × ${size} (fv ${(quote.fairValue * 100).toFixed(1)}¢) · estimated reserves ${fmtUsd(newReserved.totalReservedCents)} (Δ ${deltaSign}${fmtUsd(Math.abs(deltaCents))})`,
      market.ticker,
    );

    const lastQ: LastQuoteRecord = {
      bidCents: quote.bidCents,
      askCents: quote.askCents,
      size,
      bidOrderId: yesBidOrderId,
      askOrderId: yesAskOrderId,
      bidClientId: yesBidClientId,
      askClientId: yesAskClientId,
      ts: Date.now(),
    };
    s.setLastQuote(market.ticker, lastQ);
  } catch (e) {
    s.log("error", `placeOrder: ${(e as Error).message}`, market.ticker);
    for (const orderId of acceptedOrderIds) {
      try { await client.cancelOrder(orderId); s.closeOrderLedger(orderId, "cancelled"); }
      catch { s.log("error", `Unresolved live order: ${orderId}; inspect the exchange`, market.ticker); }
    }
    throw e;
  }

  const mq: MarketQuote = {
    ticker: market.ticker,
    fairValue: quote.fairValue,
    ourBid: quote.bidCents,
    ourAsk: quote.askCents,
    bookBid: market.yes_bid,
    bookAsk: market.yes_ask,
    position: pos,
    unrealizedPnl: 0,
    lastUpdated: Date.now(),
  };
  s.upsertMarketQuote(mq);
  } finally {
    tickerLocks.delete(market.ticker);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  const s = useBotStore.getState();
  if (s.runState !== "running" || !s.credentials) {
    ticking = false;
    return;
  }
  const generation = runGeneration;
  const credentials = s.credentials;
  const authorized = () => {
    const current = useBotStore.getState();
    return generation === runGeneration && current.runState === "running" && current.credentials === credentials;
  };
  const client = new KalshiClient(credentials, authorized);
  try {
    s.setLastTickAt(Date.now());

    // Refresh BTC spot
    try {
      const spot = await fetchBtcSpot();
      s.setBtcSpot(spot);
    } catch (e) {
      s.log("warn", `spot: ${(e as Error).message}`);
      throw e;
    }

    // Refresh markets every tick so the book (yes_bid/yes_ask) shown in
    // MarketsPanel updates in realtime. Kalshi's /markets endpoint returns
    // a fresh snapshot per call and is cheap enough at our tick rate.
    await refreshMarkets(client);
    await syncAccount(client);
    await pollFills(client);

    if (!authorized()) return;
    const spot = useBotStore.getState().btcSpot;
    const tracked = useBotStore.getState().trackedTickers;
    const markets = useBotStore.getState().markets.filter((m) => tracked.includes(m.ticker));

    // Push P&L snapshot
    const st = useBotStore.getState();
    const positions = Object.values(st.positions);
    const realized = positions.reduce((acc, p) => acc + p.realized_pnl / 100, 0);
    const equity = st.balance + st.portfolioValue;
    if (!Number.isFinite(equity) || !Number.isFinite(realized)) throw new Error("Invalid equity snapshot");
    if (st.sessionStartEquity === 0) st.setSessionStartEquity(equity);
    st.pushPnl({ ts: Date.now(), realized, unrealized: 0, equity });

    // Daily stop-loss
    if (useBotStore.getState().sessionStartEquity > 0) {
      const dayPnl = equity - useBotStore.getState().sessionStartEquity;
      if (dayPnl <= -st.risk.dailyStopLossDollars) {
        st.log("error", `daily stop-loss hit (${dayPnl.toFixed(2)})`);
        st.setCircuitBreakerTrip({
          type: "daily-stop-loss",
          reason: `Daily stop-loss hit: $${dayPnl.toFixed(2)} (limit -$${st.risk.dailyStopLossDollars})`,
          equityAtTrip: equity,
          limitDollars: st.risk.dailyStopLossDollars,
          ts: Date.now(),
        });
        await killAll(st.risk.autoFlattenOnStop);
      }
    }

    // Circuit breaker: max loss within a rolling 60-second window. Uses the
    // pnlHistory we just pushed to find the highest equity in the last 60s
    // and trips if the current draw from that peak exceeds the limit.
    {
      const cutoff = Date.now() - 60_000;
      const window = useBotStore
        .getState()
        .pnlHistory.filter((p) => p.ts >= cutoff);
      if (window.length >= 2) {
        const peak = window.reduce((m, p) => (p.equity > m ? p.equity : m), -Infinity);
        const drop = Math.max(0, peak - equity);
        st.setLastMinuteDropDollars(drop);
        if (st.risk.maxLossPerMinuteDollars > 0 && drop >= st.risk.maxLossPerMinuteDollars) {
          const reason = `Max-loss/min circuit breaker: $${drop.toFixed(2)} drop in last 60s (limit $${st.risk.maxLossPerMinuteDollars})`;
          st.log("error", `circuit breaker: ${reason}`);
          st.setCircuitBreakerTrip({
            type: "max-loss-per-minute",
            reason,
            dropDollars: drop,
            limitDollars: st.risk.maxLossPerMinuteDollars,
            equityAtTrip: equity,
            ts: Date.now(),
          });
          await killAll(st.risk.autoFlattenOnStop);
        }
      } else {
        st.setLastMinuteDropDollars(0);
      }
    }

    // 15-minute cycle stops. Cycles align to wall-clock quarter hours
    // (:00, :15, :30, :45) — same cadence as Kalshi's BTC 15-min markets.
    const QUARTER_MS = 15 * 60 * 1000;
    const nowMs = Date.now();
    const currentCycleStart = Math.floor(nowMs / QUARTER_MS) * QUARTER_MS;
    if (st.cycleStartTs !== currentCycleStart) {
      // First tick of a new cycle. Settle the previous cycle's P&L (if any),
      // update the consecutive-losing-cycles counter, then snapshot equity
      // for the new cycle.
      if (st.cycleStartTs > 0) {
        const cyclePnl = equity - st.cycleStartEquity;
        const lost = cyclePnl < 0;
        st.recordCycleResult(lost);
        st.log(
          lost ? "warn" : "info",
          `cycle settled: ${cyclePnl >= 0 ? "+" : ""}$${cyclePnl.toFixed(2)} ` +
            `(${useBotStore.getState().consecutiveLosingCycles} consecutive losing)`,
        );
        const consec = useBotStore.getState().consecutiveLosingCycles;
        const limit = st.risk.maxConsecutiveLosingCycles;
        if (limit > 0 && consec >= limit) {
          const reason = `${consec} consecutive losing 15-min cycles (limit ${limit})`;
          st.log("error", `cycle stop: ${reason}`);
          st.setCircuitBreakerTrip({
            type: "consecutive-losing-cycles",
            reason,
            equityAtTrip: equity,
            limitDollars: limit,
            ts: Date.now(),
          });
          await killAll(st.risk.autoFlattenOnStop);
        }
      }
      st.setCycleSnapshot(equity, currentCycleStart);
    } else if (st.cycleStartEquity > 0 && st.risk.intraCycleDrawdownDollars > 0) {
      // Mid-cycle: enforce intra-cycle drawdown.
      const intraPnl = equity - st.cycleStartEquity;
      if (intraPnl <= -st.risk.intraCycleDrawdownDollars) {
        const reason = `Intra-cycle drawdown $${intraPnl.toFixed(2)} (limit -$${st.risk.intraCycleDrawdownDollars})`;
        st.log("error", `intra-cycle drawdown stop: ${reason}`);
        st.setCircuitBreakerTrip({
          type: "intra-cycle-drawdown",
          reason,
          equityAtTrip: equity,
          limitDollars: st.risk.intraCycleDrawdownDollars,
          ts: Date.now(),
        });
        await killAll(st.risk.autoFlattenOnStop);
      }
    }
    // Loss checks run before adding exposure. A stop invalidates this run.
    if (spot > 0) {
      for (const m of markets) {
        if (!authorized()) return;
        await quoteMarket(client, m, spot);
      }
    }
    // Tick completed without throwing — clear watchdog error streak.
    s.recordTickSuccess();
  } catch (e) {
    const msg = errorMessage(e);
    s.log("error", `tick: ${msg}`);
    s.recordTickError(msg);
    handleWatchdog();
  } finally {
    ticking = false;
  }
}

/**
 * Watchdog policy:
 *  - 1–2 consecutive tick errors → no action (transient: network blip, 429,
 *    Kalshi 5xx). The next tick will retry naturally.
 *  - 3rd consecutive error → restart the interval timer (defensive: covers
 *    cases where setInterval drift / a hung promise has made ticks stop
 *    firing) and log a warning.
 *  - 5th consecutive error → give up auto-restart, pause the bot, and raise
 *    a user-visible alert. Real-money safety: never keep retrying blindly.
 */
function handleWatchdog() {
  const s = useBotStore.getState();
  const errs = s.watchdog.consecutiveErrors;
  if (s.runState !== "running") return;
  if (errs === 3) {
    s.log("warn", `watchdog: restarting tick timer after ${errs} consecutive errors`);
    s.recordWatchdogRestart();
    if (timer != null) {
      window.clearInterval(timer);
    }
    timer = window.setInterval(tick, s.strategy.tickIntervalMs);
  } else if (errs >= 5) {
    const reason = `Bot paused: ${errs} consecutive tick errors. Last error: ${s.watchdog.lastError ?? "unknown"}`;
    s.log("error", `watchdog: ${reason}`);
    s.raiseWatchdogAlert(reason);
    pause();
  }
}

let trackedUnsub: (() => void) | null = null;
let immediateTickPending = false;

/**
 * Subscribe to `trackedTickers` changes so a cycle rollover (which
 * auto-carries tracking onto newly-listed markets in `setMarkets`) triggers
 * an immediate quoting tick instead of waiting up to `tickIntervalMs` for
 * the next scheduled run.
 */
function subscribeTrackedRollover() {
  if (trackedUnsub) return;
  let prev = useBotStore.getState().trackedTickers;
  trackedUnsub = useBotStore.subscribe((s) => {
    const next = s.trackedTickers;
    if (next === prev) return;
    const added = next.filter((t) => !prev.includes(t));
    prev = next;
    if (added.length === 0) return;
    if (s.runState !== "running") return;
    if (immediateTickPending || ticking) return;
    immediateTickPending = true;
    s.log(
      "info",
      `tracked rollover: ${added.length} new ticker(s) — forcing immediate quote refresh`,
    );
    queueMicrotask(() => {
      immediateTickPending = false;
      void tick();
    });
  });
}

export function start() {
  if (ticking) { useBotStore.getState().log("warn", "Wait for the previous tick to finish before restarting"); return; }
  runGeneration++;
  const s = useBotStore.getState();
  if (!s.credentials) {
    s.log("error", "Cannot start: credentials missing");
    return;
  }
  if (s.circuitBreakerTrip && !s.circuitBreakerTrip.acknowledgedAt) {
    s.log("error", "Cannot start: circuit breaker tripped — re-arm first");
    return;
  }
  s.resetCycleStats();
  s.setRunState("running");
  s.log("info", "Bot started");
  if (timer != null) window.clearInterval(timer);
  timer = window.setInterval(tick, s.strategy.tickIntervalMs);
  subscribeTrackedRollover();
  // Run immediately
  void tick();
}

export function pause() {
  runGeneration++;
  const s = useBotStore.getState();
  s.setRunState("paused");
  s.log("info", "Bot paused");
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}

export async function killAll(flatten: boolean) {
  runGeneration++;
  const s = useBotStore.getState();
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
  s.setRunState("killed");
  s.log("error", "KILL SWITCH ACTIVATED");
  if (!s.credentials) return;
  const client = new KalshiClient(s.credentials);
  try {
    const open = await client.getOpenOrders();
    let killReleasedCents = 0;
    for (const o of open) {
      const price = o.yes_price ?? o.no_price ?? 0;
      if (o.action === "buy") killReleasedCents += price * o.count;
      else killReleasedCents += (100 - price) * o.count;
    }
    let failedCancels = 0;
    await mapLimit(open, CANCEL_CONCURRENCY, async (o) => {
      try {
        await client.cancelOrder(o.order_id);
        s.closeOrderLedger(o.order_id, "cancelled");
      } catch {
        failedCancels++;
        s.log("error", `Unresolved cancellation: ${o.order_id}`);
      }
    });
    s.log(
      "info",
      `Cancellation results: ${open.length - failedCancels} succeeded, ${failedCancels} failed; verify exchange balances`
    );
    const remaining = await client.getOpenOrders();
    if (failedCancels || remaining.length) throw new Error("Unresolved orders remain; flatten blocked");
    if (flatten) {
      const positions = await client.getPositions();
      for (const p of positions) {
        if (p.position === 0) continue;
        const action = p.position > 0 ? "sell" : "buy";
        await client
          .placeOrder({
            ticker: p.ticker,
            side: "yes",
            action,
            count: Math.abs(p.position),
            type: "limit",
            yes_price: action === "sell" ? 1 : 99,
            reduce_only: true,
            expiration_ts: Math.floor(Date.now() / 1000) + 15,
          })
          .catch((e) => { s.log("error", `flatten: ${e.message}`, p.ticker); throw e; });
      }
      const residual = await client.getPositions();
      if (residual.some(p => p.position !== 0)) throw new Error("Flatten incomplete; positions remain");
      s.log("info", "Positions confirmed flat");
    }
  } catch (e) {
    s.log("error", `kill: ${(e as Error).message}`);
  }
}

export function restartTimerIfRunning() {
  const s = useBotStore.getState();
  if (s.runState === "running") {
    if (timer != null) window.clearInterval(timer);
    timer = window.setInterval(tick, s.strategy.tickIntervalMs);
  }
}

/**
 * Re-arm the bot after a circuit-breaker stop. Clears the trip record,
 * resets the rolling-drop snapshot and cycle stats, returns the bot to the
 * idle state so the user can press Start again. Called only after the user
 * has reviewed and confirmed the (possibly updated) risk limits.
 */
export function rearm() {
  const s = useBotStore.getState();
  s.setCircuitBreakerTrip(null);
  s.setLastMinuteDropDollars(0);
  s.resetCycleStats();
  s.setSessionStartEquity(0);
  s.resetPnlHistory();
  s.setRunState("idle");
  s.log("info", "Bot re-armed after circuit-breaker stop");
}
