import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../lib/supabase";

// Client for our `booking` edge function. The browser never talks to the booking vendor
// and never knows which one it is: it gets an opaque sessionId and our own error codes.

export type Slot = { id: string; start: string };
export type Hold = { start: string; expiresAt: string };

export type BookingErrorCode =
  | "SLOT_UNAVAILABLE" // someone else got the time: pick another
  | "SESSION_EXPIRED" // the vendor session is gone: start a new one
  | "UNAVAILABLE" // vendor down or slow: retrying may work
  | "NETWORK" // we couldn't reach our function at all
  | (string & {}); // NOT_BOOKABLE, INVALID, MISCONFIGURED, ...

export class BookingApiError extends Error {
  readonly code: BookingErrorCode;
  readonly status: number;
  constructor(code: BookingErrorCode, message: string, status: number) {
    super(message);
    this.name = "BookingApiError";
    this.code = code;
    this.status = status;
  }
}

export const isBookingError = (error: unknown, code: BookingErrorCode) =>
  error instanceof BookingApiError && error.code === code;

async function request<T>(body: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/booking`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "content-type": "application/json",
        // Follows this request through our logs and the vendor's.
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new BookingApiError("NETWORK", "We couldn't reach the booking service. Check your connection and try again.", 0);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new BookingApiError(json?.error?.code ?? "UNKNOWN", json?.error?.message ?? "Something went wrong. Please try again.", res.status);
  }
  return json as T;
}

export const bookingApi = {
  start: (location: string, service: string) => request<{ sessionId: string }>({ action: "start", location, service }),
  dates: (sessionId: string, from: string, to: string) => request<{ dates: string[] }>({ action: "dates", sessionId, from, to }),
  times: (sessionId: string, date: string) => request<{ times: Slot[] }>({ action: "times", sessionId, date }),
  hold: (sessionId: string, slotId: string) => request<Hold>({ action: "hold", sessionId, slotId }),
};
