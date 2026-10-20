import { signRequest } from "./signer";
import { normalizeOrder, normalizePosition } from "./normalize";
import { supabase } from "@/integrations/supabase/client";
import type {
  KalshiBalance,
  KalshiCredentials,
  KalshiFill,
  KalshiMarket,
  KalshiOrderbook,
  KalshiOrder,
  KalshiPosition,
} from "./types";

const BASE_URLS: Record<KalshiCredentials["env"], string> = {
  demo: "https://demo-api.kalshi.co/trade-api/v2",
  prod: "https://api.elections.kalshi.com/trade-api/v2",
};

/** Marker value for the built-in Lovable Cloud edge-function proxy. */
export const CLOUD_PROXY = "lovable-cloud";

function cloudProxyUrl(): string {
  return '/api/kalshi';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with jitter, capped at 8s. */
function backoffMs(attempt: number, baseMs = 400): number {
  const exp = Math.min(8000, baseMs * Math.pow(2, attempt));
  return Math.floor(exp * (0.7 + Math.random() * 0.6));
}

/**
 * Kalshi BTC 15-minute market detector. We accept a market if:
 *  - it's BTC (ticker or event_ticker contains BTC), and
 *  - it has at least one strike (floor and/or cap) — both single-strike
 *    "above" and dual-strike range contracts are supported, since the
 *    BTC 15-minute series is published as range buckets, and
 *  - it closes within the next ~30 minutes (15-min cadence, plus a small
 *    overlap so the next bucket is visible just before rollover).
 */
function isBtc15MinMarket(m: import("./types").KalshiMarket): boolean {
  // Kalshi's 15-minute BTC series ticker is `KXBTC15M`. Markets in that
  // series have tickers/event_tickers starting with `KXBTC15M-`.
  const t = m.ticker.toUpperCase();
  const et = (m.event_ticker ?? "").toUpperCase();
  const inSeries = t.startsWith("KXBTC15M") || et.startsWith("KXBTC15M");
  if (!inSeries) return false;
  const hasStrike = m.floor_strike != null || m.cap_strike != null;
  if (!hasStrike) return false;
  const closeMs = m.close_time ? new Date(m.close_time).getTime() : 0;
  if (closeMs === 0) return true; // keep if no close info — better than dropping
  // 15-min cadence + small overlap so the next bucket is visible just
  // before rollover. Don't drop markets that have just closed (negative
  // delta within a few seconds) — let the scheduler decide.
  const halfHour = 30 * 60 * 1000;
  return closeMs - Date.now() <= halfHour;
}

export class KalshiClient {
  constructor(private creds: KalshiCredentials, private mayMutate: () => boolean = () => true) {}

  private buildUrl(path: string): string {
    if (this.creds.corsProxy?.trim() && this.creds.corsProxy.trim() !== CLOUD_PROXY) throw new Error('Only the authenticated server relay is supported');
    const fullUrl = `${BASE_URLS[this.creds.env]}${path}`;
    // Default to the built-in Lovable Cloud edge-function proxy when no
    // proxy is configured. Calling Kalshi directly from the browser is
    // always blocked by CORS — there is no scenario where a missing
    // proxy is the right choice, so fall back instead of failing.
    const proxy = this.creds.corsProxy?.trim() || CLOUD_PROXY;
    // Built-in Lovable Cloud edge-function proxy.
    if (proxy === CLOUD_PROXY) {
      const apiSubPath = `/trade-api/v2${path}`;
      return `${cloudProxyUrl()}?env=${this.creds.env}&path=${encodeURIComponent(apiSubPath)}`;
    }
    // Two proxy styles:
    //  - "raw append" (target URL appended as-is): corsproxy.io style — proxy ends with `?`
    //  - "url-encoded query value": codetabs/allorigins/etc. — proxy ends with `=`
    // Anything else: assume path-style and url-encode the target.
    if (/\?$/.test(proxy)) return `${proxy}${fullUrl}`;
    if (/=$/.test(proxy)) return `${proxy}${encodeURIComponent(fullUrl)}`;
    return `${proxy}${encodeURIComponent(fullUrl)}`;
  }

  private async request<T>(
    method: string,
    pathWithQuery: string,
    body?: unknown
  ): Promise<T> {
    // Path used in signature must be the API path (not the proxy URL),
    // and Kalshi signs only the path portion (no query string).
    const pathOnly = pathWithQuery.split("?")[0];
    const apiSubPath = `/trade-api/v2${pathOnly}`;
    const url = this.buildUrl(pathWithQuery);
    const serializedBody = body ? JSON.stringify(body) : undefined;

    // Retry on 429 / 5xx with exponential backoff + jitter. Each retry
    // re-signs the request (timestamp must be fresh).
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { timestamp, signature } = await signRequest(
        this.creds.privateKeyPem,
        method,
        apiSubPath,
      );
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY": this.creds.keyId,
        "KALSHI-ACCESS-SIGNATURE": signature,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
      };
      const effectiveProxy = this.creds.corsProxy?.trim() || CLOUD_PROXY;
      if (effectiveProxy === CLOUD_PROXY) {
        // Attach the signed-in user's JWT so the edge function can verify
        // the email allowlist server-side. Falls back to anon key for
        // `apikey` (required by the gateway) but Authorization MUST be the
        // user session token, otherwise the edge function returns 401/403.
        const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
        let { data: { session } } = await supabase.auth.getSession();
        // If the access token is expired or near expiry, force a refresh so
        // the edge function never sees a stale JWT.
        const nowSec = Math.floor(Date.now() / 1000);
        if (!session || (session.expires_at != null && session.expires_at - nowSec < 30)) {
          const { data: refreshed } = await supabase.auth.refreshSession();
          session = refreshed.session ?? session;
        }
        const userJwt = session?.access_token;
        if (!userJwt) {
          throw new Error("Not signed in — please sign in with your password and authenticator to use the trade API.");
        }
        if (anon) headers["apikey"] = anon;
        headers["Authorization"] = `Bearer ${userJwt}`;
      }
      let res: Response;
      try {
        if (method === "POST" && !this.mayMutate()) throw new Error("Trading authority revoked");
        res = await fetch(url, { method, headers, body: serializedBody, signal: AbortSignal.timeout(15000) });
      } catch (e) {
        if (method === "POST" && !this.mayMutate()) throw e;
        lastErr = e;
        // Network error — backoff and retry.
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return res.json() as Promise<T>;

      const text = await res.text().catch(() => "");
      // Retry on rate-limit and transient server errors.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts - 1) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs(attempt, res.status === 429 ? 800 : 400);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`Kalshi ${method} ${pathOnly} → ${res.status}: ${text}`);
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Kalshi ${method} ${pathOnly}: retries exhausted`);
  }

  getBalance(): Promise<KalshiBalance> {
    return this.request<KalshiBalance>("GET", "/portfolio/balance");
  }

  async getMarkets(eventTicker?: string): Promise<KalshiMarket[]> {
    const q = new URLSearchParams({ status: "open", limit: "200" });
    if (eventTicker) q.set("event_ticker", eventTicker);
    const r = await this.request<{ markets: KalshiMarket[] }>(
      "GET",
      `/markets?${q.toString()}`
    );
    return r.markets ?? [];
  }

  /**
   * Fetch BTC 15-minute markets — short-cycle range/above contracts that
   * settle every 15 minutes. We probe the known KXBTC* 15-min series
   * tickers, then fall back to a broad open-markets scan filtered by
   * `isBtc15MinMarket` (BTC + has strike + closes within ~30 min).
   */
  async getBtc15MinMarkets(): Promise<KalshiMarket[]> {
    // Kalshi's BTC 15-minute series ticker is `KXBTC15M`. We probe it
    // first; the others are kept as fallbacks in case Kalshi renames
    // the series.
    const candidateSeries = ["KXBTC15M"];
    const collected = new Map<string, KalshiMarket>();

    for (const series of candidateSeries) {
      try {
        const q = new URLSearchParams({
          status: "open",
          series_ticker: series,
          limit: "200",
        });
        const r = await this.request<{ markets: KalshiMarket[] }>(
          "GET",
          `/markets?${q.toString()}`
        );
        for (const m of r.markets ?? []) {
          if (isBtc15MinMarket(m)) collected.set(m.ticker, m);
        }
      } catch {
        // some series tickers may 404 — keep trying
      }
    }

    // Fallback: broad scan of open markets, then filter to BTC 15-min.
    if (collected.size === 0) {
      try {
        const q = new URLSearchParams({ status: "open", limit: "1000" });
        const r = await this.request<{ markets: KalshiMarket[] }>(
          "GET",
          `/markets?${q.toString()}`
        );
        for (const m of r.markets ?? []) {
          if (isBtc15MinMarket(m)) collected.set(m.ticker, m);
        }
      } catch {
        // ignore — return whatever we have
      }
    }

    return Array.from(collected.values());
  }

  /** @deprecated Use getBtc15MinMarkets — kept as a thin alias for older callers. */
  getBtcHourlyMarkets(): Promise<KalshiMarket[]> {
    return this.getBtc15MinMarkets();
  }

  getOrderbook(ticker: string): Promise<{ orderbook: KalshiOrderbook }> {
    return this.request("GET", `/markets/${ticker}/orderbook?depth=5`);
  }

  async getPositions(): Promise<KalshiPosition[]> {
    return (await this.listAll("/portfolio/positions", "market_positions")).map(normalizePosition);
  }

  async getOpenOrders(ticker?: string): Promise<KalshiOrder[]> {
    const q = new URLSearchParams({ status: "resting" });
    if (ticker) q.set("ticker", ticker);
    return (await this.listAll(`/portfolio/orders?${q.toString()}`, "orders")).map(normalizeOrder);
  }

  private async listAll(path: string, key: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 1000; page++) {
      const queryPath = cursor ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : path;
      const response = await this.request<Record<string, unknown>>("GET", queryPath);
      const rows = response[key];
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object")) throw new Error(`Invalid ${key} response`);
      result.push(...rows);
      const next = response.cursor;
      if (next == null || next === "") return result;
      if (typeof next !== "string" || seen.has(next)) throw new Error("Invalid or repeated pagination cursor");
      seen.add(next);
      cursor = next;
    }
    throw new Error("Pagination safety limit reached; snapshot incomplete");
  }

  placeOrder(params: {
    ticker: string;
    side: "yes" | "no";
    action: "buy" | "sell";
    count: number;
    yes_price?: number; // cents 1..99
    no_price?: number;
    type?: "limit" | "market";
    client_order_id?: string;
    post_only?: boolean;
    expiration_ts?: number;
    reduce_only?: boolean;
  }): Promise<{ order: KalshiOrder }> {
    const type = params.type ?? "limit";
    // Kalshi requires *exactly one* of yes_price / no_price for limit orders,
    // and *none* for market orders. Strip undefined keys so we never send
    // `yes_price: undefined` (which JSON-serializes away but still trips
    // some validation paths when both fields are present).
    const payload: Record<string, unknown> = {
      ticker: params.ticker,
      side: params.side,
      action: params.action,
      count: params.count,
      type,
      ...(params.post_only != null ? { post_only: params.post_only } : {}),
      ...(params.expiration_ts != null ? { expiration_ts: params.expiration_ts } : {}),
      ...(params.reduce_only != null ? { reduce_only: params.reduce_only } : {}),
      client_order_id: params.client_order_id ?? crypto.randomUUID(),
    };
    if (type === "limit") {
      if (params.yes_price != null && params.no_price != null) {
        throw new Error("placeOrder: provide exactly one of yes_price / no_price");
      }
      if (params.yes_price != null) payload.yes_price = params.yes_price;
      else if (params.no_price != null) payload.no_price = params.no_price;
      else throw new Error("placeOrder: limit order requires yes_price or no_price");
    }
    return this.request("POST", "/portfolio/orders", payload);
  }

  cancelOrder(orderId: string): Promise<unknown> {
    return this.request("DELETE", `/portfolio/orders/${orderId}`);
  }

  async getFills(opts?: { ticker?: string; min_ts?: number; limit?: number }): Promise<KalshiFill[]> {
    const q = new URLSearchParams({ limit: String(opts?.limit ?? 100) });
    if (opts?.ticker) q.set("ticker", opts.ticker);
    if (opts?.min_ts) q.set("min_ts", String(Math.floor(opts.min_ts / 1000)));
    return await this.listAll(`/portfolio/fills?${q.toString()}`, "fills") as unknown as KalshiFill[];
  }
}

export async function fetchBtcSpot(): Promise<number> {
  // Coinbase public ticker — no auth, public CORS-friendly endpoint.
  const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Coinbase spot fetch failed: ${res.status}`);
  const j = (await res.json()) as { data: { amount: string } };
  const price = Number(j.data.amount);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid BTC spot price");
  return price;
}
