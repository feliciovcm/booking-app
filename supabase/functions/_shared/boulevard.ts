// Boulevard adapter: implements our BookingProvider contract on top of Boulevard's
// Client API. The only code that knows Boulevard speaks GraphQL, uses carts and has
// its own error codes; everything it returns or throws is in our vocabulary.
//
// Works against the mock and Boulevard's sandbox/production the same way; only
// baseUrl and credentials change (mock: <SUPABASE_URL>/functions/v1/mock-boulevard,
// sandbox: https://sandbox.joinblvd.com).

import { BookingError, UNAVAILABLE_MESSAGE, type BookingErrorCode, type BookingProvider } from "./booking-provider.ts";
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

const API_PATH = "/api/2026-06/client";

// Boulevard's codes (from its docs, plus the mock's own) -> ours. Anything not listed
// with a BlvdError becomes INVALID, with Boulevard's user-facing message.
const ERROR_MAP: Record<string, BookingErrorCode> = {
  CART_TIME_NOT_AVAILABLE: "SLOT_UNAVAILABLE",
  CART_MISSING_ITEM_TIME: "SESSION_EXPIRED",
  CART_NOT_FOUND: "SESSION_EXPIRED",
  CART_COMPLETED: "SESSION_EXPIRED",
};

// One token per isolate, reused across requests until a minute before it expires.
// Client credentials tokens last 24 hours, so this saves a token call on nearly every request.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export const clearTokenCache = () => tokenCache.clear();

const unavailable = (vendorCode: string) => new BookingError("UNAVAILABLE", UNAVAILABLE_MESSAGE, vendorCode);
const misconfigured = (vendorCode: string) => new BookingError("MISCONFIGURED", UNAVAILABLE_MESSAGE, vendorCode);

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
      throw unavailable(controller.signal.aborted ? "TIMEOUT" : "NETWORK");
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
    if (!res.ok) throw misconfigured("AUTH_FAILED");
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
        if (error instanceof BookingError && error.retryable && !isMutation && attempt < maxRetries) {
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
        await sleep(waitFrom429(await res.text()) ?? backoff(attempt));
        continue;
      }
      if (res.status === 503 && !isMutation && attempt < maxRetries) {
        await sleep(backoff(attempt));
        continue;
      }
      if (!res.ok) {
        log.warn("boulevard http error", { operation, status: res.status });
        throw res.status === 429 || res.status >= 500 ? unavailable(`HTTP_${res.status}`) : misconfigured(`HTTP_${res.status}`);
      }

      const body = (await res.json()) as { data?: T; errors?: { __typename?: string; code?: string; message: string }[] };
      const [first] = body.errors ?? [];
      if (first) {
        // A BlvdError is about the request (its message is written for end users).
        // Any other GraphQL error means our query is wrong: ours to fix.
        const isBlvd = first.__typename === "BlvdError" && !!first.code;
        const vendorCode = isBlvd ? first.code! : "GRAPHQL_ERROR";
        log.warn("boulevard error", { operation, vendorCode });
        if (!isBlvd) throw misconfigured(vendorCode);
        throw new BookingError(ERROR_MAP[vendorCode] ?? "INVALID", first.message, vendorCode);
      }
      return body.data as T;
    }
  }

  return {
    async startSession(locationId, serviceId) {
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
      // In Boulevard, a booking session is a cart.
      return { sessionId: cartId };
    },

    async availableDates(cartId, from, to) {
      const data = await call<{ cartBookableDates: { date: string }[] }>(
        "CartBookableDates",
        `query CartBookableDates($id: ID!, $from: Date!, $to: Date!) { cartBookableDates(id: $id, searchRangeLower: $from, searchRangeUpper: $to) { date } }`,
        { id: cartId, from, to },
      );
      return data.cartBookableDates.map((d) => d.date);
    },

    async availableTimes(cartId, date) {
      const data = await call<{ cartBookableTimes: { id: string; startTime: string }[] }>(
        "CartBookableTimes",
        `query CartBookableTimes($id: ID!, $date: Date!) { cartBookableTimes(id: $id, searchDate: $date) { id startTime } }`,
        { id: cartId, date },
      );
      // Normalize to UTC ISO. The browser formats it in the clinic's time zone.
      return data.cartBookableTimes.map((t) => ({ id: t.id, start: new Date(t.startTime).toISOString() }));
    },

    async hold(cartId, timeId) {
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
