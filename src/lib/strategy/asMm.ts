/**
 * Avellaneda–Stoikov market-maker — TypeScript port of the reference
 * Python class (`AvellanedaStoikovMM.generate_quotes`). Operates in
 * dollar-price space (0..1) and emits one Quote per market.
 *
 * The scheduler loop builds `MarketState` from live Kalshi data
 * (best_bid/best_ask in dollars from yes_bid/yes_ask cents, current
 * YES position, seconds to expiry) and submits orders at the resulting
 * bid_price/ask_price × bid_size/ask_size.
 */

export interface MarketState {
  ticker: string;
  strike: number;
  /** Seconds until contract expiry. */
  timeToExpirySec: number;
  /** Best bid in dollars (e.g. 0.47), or null if no book. */
  bestBid: number | null;
  /** Best ask in dollars (e.g. 0.49), or null if no book. */
  bestAsk: number | null;
  /** +N = long YES, -N = short YES. */
  positionYes: number;
  /** Epoch seconds when the book snapshot was last updated. */
  lastBookTs: number;
  /** Current BTC spot price (USD). Used by per-strike pricing model. */
  spotBtc: number;
}

export interface AsMmConfig {
  gamma: number;
  sigmaAnnual: number;
  k: number;
  minEdgeCents: number;
  maxQuoteSize: number;
  maxInventoryPerMarket: number;
  maxGlobalInventory: number;
  /** Max age (seconds) of book snapshot before we skip quoting. */
  maxBookAgeSec: number;
  /** Minimum ask/bid price ratio enforced on quotes. Default 4. */
  askBidRatio?: number;
  /** Fillability validation thresholds (all in dollars 0..1). */
  fillability?: FillabilityThresholds;
}

export interface FillabilityThresholds {
  /** Bid ≤ this price is considered "pinned" at the floor. Default 0.0101. */
  pinnedBidMax: number;
  /** Ask ≥ this price is considered "pinned" at the ceiling. Default 0.9899. */
  pinnedAskMin: number;
  /**
   * If both bid and ask are farther outside the live book than this many
   * dollars, the quote is marked unfillable. Default 0.5 (= 50¢).
   */
  outsideBookGap: number;
}

export const DEFAULT_FILLABILITY: FillabilityThresholds = {
  pinnedBidMax: 0.0101,
  pinnedAskMin: 0.9899,
  outsideBookGap: 0.5,
};

export interface QuoteDebug {
  mid: number;
  reservation: number;
  askBidRatio: number;
  rawBid: number;
  rawAsk: number;
  finalBid: number;
  finalAsk: number;
  /** Set when the ratio-enforced quote is judged non-fillable. */
  unfillableReason?: string;
}

export interface AsMmQuote {
  ticker: string;
  /** Dollars, rounded to 2dp; null = do not quote this side. */
  bidPrice: number | null;
  askPrice: number | null;
  bidSize: number;
  askSize: number;
  /** Diagnostics for the scheduler/UI. Optional — empty quotes may omit. */
  debug?: QuoteDebug;
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26). */
function normCdf(x: number): number {
  // erf approximation
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Fair probability that BTC settles ≥ strike at expiry, using a
 * lognormal/Black–Scholes-style approximation: P ≈ N(d2).
 * Placeholder model — replace with a richer one (drift, smile) later.
 */
export function fairPriceProbAbove(m: MarketState, cfg: AsMmConfig): number {
  const S = m.spotBtc;
  const K = m.strike;
  const T = Math.max(m.timeToExpirySec, 1) / SECONDS_PER_YEAR;
  const sigma = cfg.sigmaAnnual;
  if (S <= 0 || K <= 0 || sigma <= 0 || T <= 0) return 0.5;
  const denom = sigma * Math.sqrt(T);
  if (denom === 0) return 0.5;
  const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * T) / denom;
  const prob = normCdf(d2);
  return Math.min(0.99, Math.max(0.01, prob));
}

function computeMid(m: MarketState, cfg: AsMmConfig): number | null {
  const bid = m.bestBid;
  const ask = m.bestAsk;

  // Per-strike model probability — used as fallback or blend partner.
  const modelMid = fairPriceProbAbove(m, cfg);

  // Both sides present and sane → blend 70% book, 30% model
  if (bid != null && ask != null && bid > 0 && ask > 0 && bid < ask) {
    const bookMid = 0.5 * (bid + ask);
    return 0.7 * bookMid + 0.3 * modelMid;
  }
  // One-sided book → shade then blend lightly toward model
  if (bid != null && bid > 0) {
    const shaded = Math.min(0.99, bid + 0.02);
    return 0.7 * shaded + 0.3 * modelMid;
  }
  if (ask != null && ask > 0) {
    const shaded = Math.max(0.01, ask - 0.02);
    return 0.7 * shaded + 0.3 * modelMid;
  }
  // No book → fall back to pure model estimate
  return modelMid;
}

function inventorySkew(posYes: number, globalInventory: number): number {
  const invScale = 0.01;
  const globalScale = 0.005;
  return invScale * posYes + globalScale * globalInventory;
}

function clampPrice(p: number): number {
  return Math.max(0.01, Math.min(0.99, p));
}

function quoteCore(
  m: MarketState,
  globalInventory: number,
  cfg: AsMmConfig,
): { bid: number; ask: number; size: number; debug: QuoteDebug } | null {
  const mid = computeMid(m, cfg);
  if (mid == null) return null;

  const T = Math.max(m.timeToExpirySec, 1) / SECONDS_PER_YEAR;
  const sigma = cfg.sigmaAnnual;
  const spread = cfg.gamma * sigma * sigma * T + 2.0 / Math.max(cfg.k, 1e-6);
  let half = spread / 2;
  const skew = inventorySkew(m.positionYes, globalInventory);

  const r = mid - skew;

  // Cap half-spread so quotes stay inside the fillable window when
  // geometrically feasible. The AS formula's `2/k` term dominates on
  // short-dated contracts and otherwise blows quotes out to 1¢/99¢.
  const thrPre = { ...DEFAULT_FILLABILITY, ...(cfg.fillability ?? {}) };
  const minEdgeDollars = cfg.minEdgeCents / 100;
  const maxHalfFillable = Math.min(
    r - thrPre.pinnedBidMax,
    thrPre.pinnedAskMin - r,
  );
  if (maxHalfFillable >= minEdgeDollars && half > maxHalfFillable) {
    half = maxHalfFillable;
  }

  let bid = r - half;
  let ask = r + half;

  const minEdge = cfg.minEdgeCents / 100;
  bid = Math.min(bid, r - minEdge);
  ask = Math.max(ask, r + minEdge);

  const rawBid = bid;
  const rawAsk = ask;

  const ASK_BID_RATIO = Math.max(1, cfg.askBidRatio ?? 4);
  bid = clampPrice(bid);
  ask = clampPrice(ask);
  if (bid > 0 && ask < ASK_BID_RATIO * bid) {
    const maxBidForAsk = ask / ASK_BID_RATIO;
    if (maxBidForAsk >= 0.01) {
      bid = maxBidForAsk;
    } else {
      bid = 0.01;
      ask = Math.min(0.99, ASK_BID_RATIO * bid);
    }
  }

  bid = clampPrice(bid);
  ask = clampPrice(ask);

  // Fillability check: if BOTH sides are pinned at the clamp extremes
  // (bid≈0.01 and ask≈0.99), the quote can't realistically be filled.
  // Attribute the cause correctly: ratio enforcement vs. raw spread too wide.
  let unfillableReason: string | undefined;
  const thr = { ...DEFAULT_FILLABILITY, ...(cfg.fillability ?? {}) };
  const bidPinned = bid <= thr.pinnedBidMax;
  const askPinned = ask >= thr.pinnedAskMin;
  const rawViolatedRatio = rawBid > 0 && rawAsk < ASK_BID_RATIO * rawBid;
  if (bidPinned && askPinned) {
    if (rawViolatedRatio) {
      unfillableReason =
        `ratio ${ASK_BID_RATIO}× forces bid≤${(thr.pinnedBidMax * 100).toFixed(1)}¢ ` +
        `and ask≥${(thr.pinnedAskMin * 100).toFixed(1)}¢`;
    } else {
      unfillableReason =
        `spread too wide: raw bid ${(rawBid * 100).toFixed(0)}¢ / ask ` +
        `${(rawAsk * 100).toFixed(0)}¢ clamps to ${(thr.pinnedBidMax * 100).toFixed(1)}¢/` +
        `${(thr.pinnedAskMin * 100).toFixed(1)}¢`;
    }
  } else if (m.bestBid != null && m.bestAsk != null) {
    const bidGap = m.bestBid - bid;
    const askGap = ask - m.bestAsk;
    if (bidGap > thr.outsideBookGap && askGap > thr.outsideBookGap) {
      unfillableReason =
        `both sides >${(thr.outsideBookGap * 100).toFixed(0)}¢ outside book ` +
        `(bid −${(bidGap * 100).toFixed(0)}¢, ask +${(askGap * 100).toFixed(0)}¢)`;
    }
  }

  const debug: QuoteDebug = {
    mid,
    reservation: r,
    askBidRatio: ASK_BID_RATIO,
    rawBid,
    rawAsk,
    finalBid: bid,
    finalAsk: ask,
    unfillableReason,
  };

  return { bid, ask, size: cfg.maxQuoteSize, debug };
}

function emptyQuote(ticker: string): AsMmQuote {
  return { ticker, bidPrice: null, askPrice: null, bidSize: 0, askSize: 0 };
}

/** True if the book snapshot is older than cfg.maxBookAgeSec. */
export function isBookStale(m: MarketState, cfg: AsMmConfig, nowSec = Date.now() / 1000): boolean {
  if (!Number.isFinite(m.lastBookTs) || m.lastBookTs <= 0) return true;
  return nowSec - m.lastBookTs > cfg.maxBookAgeSec;
}

/**
 * Freshness score in [0, 1]: 1.0 = perfect, 0.0 = unusable.
 * Combines book age and spread quality (50/50 blend).
 * Useful for diagnostics and "only quote on healthy markets" selection.
 */
export function computeFreshnessScore(
  m: MarketState,
  cfg: AsMmConfig,
  nowSec = Date.now() / 1000,
): number {
  // Age component
  let ageScore = 0;
  if (Number.isFinite(m.lastBookTs) && m.lastBookTs > 0) {
    const age = nowSec - m.lastBookTs;
    const denom = Math.max(cfg.maxBookAgeSec, 1.0);
    ageScore = Math.max(0, 1 - age / denom);
  }

  // Spread component: 0–10¢ spread maps to 1.0–0.0
  let spreadScore = 0;
  if (m.bestBid != null && m.bestAsk != null && m.bestBid < m.bestAsk) {
    const spread = m.bestAsk - m.bestBid;
    spreadScore = Math.max(0, 1 - spread / 0.10);
  }

  return 0.5 * ageScore + 0.5 * spreadScore;
}

/** Quote one market normally (both sides). */
export function quoteNormal(
  m: MarketState,
  globalInventory: number,
  cfg: AsMmConfig,
): AsMmQuote {
  const c = quoteCore(m, globalInventory, cfg);
  if (!c) return emptyQuote(m.ticker);
  if (c.debug.unfillableReason) {
    return { ...emptyQuote(m.ticker), debug: c.debug };
  }
  return {
    ticker: m.ticker,
    bidPrice: Math.floor((c.bid + Number.EPSILON) * 100) / 100,
    askPrice: Math.ceil((c.ask - Number.EPSILON) * 100) / 100,
    bidSize: c.size,
    askSize: c.size,
    debug: c.debug,
  };
}

/** Quote only the side that reduces exposure when per-market cap is hit. */
export function quoteWithInventoryCap(
  m: MarketState,
  globalInventory: number,
  cfg: AsMmConfig,
): AsMmQuote {
  const c = quoteCore(m, globalInventory, cfg);
  if (!c) return emptyQuote(m.ticker);
  if (c.debug.unfillableReason) {
    return { ...emptyQuote(m.ticker), debug: c.debug };
  }
  if (m.positionYes > 0) {
    return { ticker: m.ticker, bidPrice: null, askPrice: Math.ceil((c.ask - Number.EPSILON) * 100) / 100, bidSize: 0, askSize: c.size, debug: c.debug };
  }
  if (m.positionYes < 0) {
    return { ticker: m.ticker, bidPrice: Math.floor((c.bid + Number.EPSILON) * 100) / 100, askPrice: null, bidSize: c.size, askSize: 0, debug: c.debug };
  }
  return { ...emptyQuote(m.ticker), debug: c.debug };
}

/**
 * Batch entrypoint mirroring the Python `generate_quotes` API.
 */
export function generateQuotes(markets: MarketState[], cfg: AsMmConfig): AsMmQuote[] {
  const globalInventory = markets.reduce((s, m) => s + m.positionYes, 0);
  const nowSec = Date.now() / 1000;
  return markets.map((m) => {
    // Combined freshness gate (covers staleness + wide spreads).
    const freshness = computeFreshnessScore(m, cfg, nowSec);
    if (freshness < 0.3) {
      return emptyQuote(m.ticker);
    }
    if (Math.abs(m.positionYes) >= cfg.maxInventoryPerMarket) {
      return quoteWithInventoryCap(m, globalInventory, cfg);
    }
    return quoteNormal(m, globalInventory, cfg);
  });
}