// Boulevard adapter: the only code that knows Boulevard speaks GraphQL. The rest of our
// functions call these methods and get our own shapes and our own errors back.
//
// Works against the mock and Boulevard's sandbox/production the same way; only
// baseUrl and credentials change (mock: <SUPABASE_URL>/functions/v1/mock-boulevard,
// sandbox: https://sandbox.joinblvd.com).

import { timed, type Log } from "./log.ts";

export type BoulevardConfig = {
  baseUrl: string;
  clientId: string;
  /** Base64 text, as the developer portal shows it. */
  clientSecret: string;
  businessId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per attempt. Boulevard date/time queries are usually fast; fail before the browser gives up. */
  timeoutMs?: number;
  maxRetries?: number;
};

export type BookableTime = { id: string; start: string };

/** What our functions need from a booking vendor. Another vendor would implement the same. */
export interface BookingProvider {
  startCart(locationId: string, serviceId: string): Promise<{ cartId: string }>;
  bookableDates(cartId: string, from: string, to: string): Promise<string[]>;
  bookableTimes(cartId: string, date: string): Promise<BookableTime[]>;
  reserve(cartId: string, timeId: string): Promise<{ start: string; expiresAt: string }>;
}

/**
 * Our error for anything that went wrong talking to Boulevard. `code` is Boulevard's
 * when it sent one (e.g. CART_TIME_NOT_AVAILABLE); `userMessage` is safe to show.
 */
export class BoulevardError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly retryable: boolean;
  constructor(code: string, userMessage: string, retryable = false) {
    super(`Boulevard ${code}`);
    this.name = "BoulevardError";
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = retryable;
  }
}

const API_PATH = "/api/2026-06/client";
const UNAVAILABLE = "Booking is temporarily unavailable. Please try again in a moment.";

// One token per isolate, reused across requests until a minute before it expires.
// Client credentials tokens last 24 hours, so this saves a token call on nearly every request.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export const clearTokenCache = () => tokenCache.clear();

export function createBoulevard(config: BoulevardConfig, log: Log): BookingProvider {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 8000;
  const maxRetries = config.maxRetries ?? 2;
  const cacheKey = `${config.baseUrl}|${config.clientId}|${config.businessId}`;

  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) throw new BoulevardError("TIMEOUT", UNAVAILABLE, true);
      throw new BoulevardError("NETWORK", UNAVAILABLE, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToken(): Promise<string> {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.token;

    const res = await timed(log, "boulevard token", () =>
      fetchWithTimeout(`${config.baseUrl}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": log.requestId },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          business_id: config.businessId,
          resource: `${config.baseUrl}${API_PATH}`,
        }),
      }),
    );
    // A failed token call is our misconfiguration (wrong secret, app not installed), not the visitor's.
    if (!res.ok) throw new BoulevardError("AUTH_FAILED", UNAVAILABLE);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokenCache.set(cacheKey, { token: body.access_token, expiresAt: now() + (body.expires_in - 60) * 1000 });
    return body.access_token;
  }

  /**
   * One GraphQL call with timeout and retries. Queries retry on 429, 503 and timeouts.
   * Mutations retry only on 429, which Boulevard returns before running anything; after
   * a 503 or a timeout we can't know whether the mutation ran.
   */
  async function call<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const isMutation = query.trimStart().startsWith("mutation");
    let refreshedToken = false;

    for (let attempt = 0; ; attempt++) {
      const token = await getToken();
      let res: Response;
      try {
        res = await timed(
          log,
          `boulevard ${operation}`,
          () =>
            fetchWithTimeout(`${config.baseUrl}${API_PATH}`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-request-id": log.requestId },
              body: JSON.stringify({ operationName: operation, query, variables }),
            }),
          { operation, attempt },
        );
      } catch (error) {
        if (error instanceof BoulevardError && error.retryable && !isMutation && attempt < maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw error;
      }

      if (res.status === 401 && !refreshedToken) {
        // Token revoked or expired early: get a fresh one once.
        tokenCache.delete(cacheKey);
        refreshedToken = true;
        continue;
      }
      if (res.status === 429 && attempt < maxRetries) {
        const text = await res.text();
        await sleep(waitFrom429(text) ?? backoff(attempt));
        continue;
      }
      if (res.status === 503 && !isMutation && attempt < maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      if (!res.ok) {
        log.warn("boulevard http error", { operation, status: res.status });
        throw new BoulevardError(res.status === 429 ? "RATE_LIMITED" : `HTTP_${res.status}`, UNAVAILABLE, res.status >= 500 || res.status === 429);
      }

      const body = (await res.json()) as { data?: T; errors?: { __typename?: string; code?: string; message: string }[] };
      const [first] = body.errors ?? [];
      if (first) {
        // BlvdError messages are written for end users; other GraphQL errors are ours to fix.
        const code = first.__typename === "BlvdError" && first.code ? first.code : "GRAPHQL_ERROR";
        log.warn("boulevard error", { operation, errorCode: code });
        throw new BoulevardError(code, code === "GRAPHQL_ERROR" ? UNAVAILABLE : first.message);
      }
      return body.data as T;
    }
  }

  return {
    async startCart(locationId, serviceId) {
      const created = await call<{ createCart: { cart: { id: string } } }>(
        "CreateCart",
        `mutation CreateCart($locationId: ID!) { createCart(input: { locationId: $locationId }) { cart { id } } }`,
        { locationId },
      );
      const cartId = created.createCart.cart.id;
      await call(
        "AddCartSelectedBookableItem",
        `mutation AddCartSelectedBookableItem($id: ID!, $itemId: ID!) { addCartSelectedBookableItem(input: { id: $id, itemId: $itemId }) { cart { id } } }`,
        { id: cartId, itemId: serviceId },
      );
      return { cartId };
    },

    async bookableDates(cartId, from, to) {
      const data = await call<{ cartBookableDates: { date: string }[] }>(
        "CartBookableDates",
        `query CartBookableDates($id: ID!, $from: Date!, $to: Date!) { cartBookableDates(id: $id, searchRangeLower: $from, searchRangeUpper: $to) { date } }`,
        { id: cartId, from, to },
      );
      return data.cartBookableDates.map((d) => d.date);
    },

    async bookableTimes(cartId, date) {
      const data = await call<{ cartBookableTimes: { id: string; startTime: string }[] }>(
        "CartBookableTimes",
        `query CartBookableTimes($id: ID!, $date: Date!) { cartBookableTimes(id: $id, searchDate: $date) { id startTime } }`,
        { id: cartId, date },
      );
      // Normalize to UTC ISO. The browser formats it in the clinic's time zone.
      return data.cartBookableTimes.map((t) => ({ id: t.id, start: new Date(t.startTime).toISOString() }));
    },

    async reserve(cartId, timeId) {
      const data = await call<{ reserveCartBookableItems: { cart: { startTime: string; expiresAt: string } } }>(
        "ReserveCartBookableItems",
        `mutation ReserveCartBookableItems($id: ID!, $timeId: ID!) { reserveCartBookableItems(input: { id: $id, bookableTimeId: $timeId }) { cart { startTime expiresAt } } }`,
        { id: cartId, timeId },
      );
      const cart = data.reserveCartBookableItems.cart;
      return { start: new Date(cart.startTime).toISOString(), expiresAt: cart.expiresAt };
    },
  };
}

/** 250 ms, 500 ms, 1 s... plus up to 100 ms of jitter so retries from many isolates don't line up. */
const backoff = (attempt: number) => 250 * 2 ** attempt + Math.floor(Math.random() * 100);

/** Boulevard's 429 says "Please wait 280ms and try again." in the message, not in a header. */
export function waitFrom429(body: string): number | null {
  const match = body.match(/wait (\d+)ms/);
  return match ? Math.min(Number(match[1]), 5000) : null;
}
