import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase";

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

const isCode = (error: unknown, code: BookingErrorCode) => error instanceof BookingApiError && error.code === code;

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

// Retry only what retrying can fix, at most twice.
const retryTransient = (failures: number, error: Error) =>
  failures < 2 && (isCode(error, "UNAVAILABLE") || isCode(error, "NETWORK"));

// The session lives in sessionStorage: it survives a refresh, dies with the tab, and is
// specific to one treatment at one clinic (the vendor session is built for that pair).
const storageKey = (service: string, location: string) => `booking-session:${service}:${location}`;
const storage = {
  get: (key: string) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Private mode or storage disabled: the session just won't survive a refresh.
    }
  },
  remove: (key: string) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Same as above.
    }
  },
};

/**
 * The booking session for this treatment and clinic: reused from sessionStorage, or
 * started on the server. A query (not a mutation) so React's double render in dev and
 * remounts share one request instead of starting two sessions.
 */
export function useBookingSession(service: string | undefined, location: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["booking-session", service, location];
  const query = useQuery({
    queryKey,
    enabled: Boolean(service && location),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: retryTransient,
    queryFn: async () => {
      const key = storageKey(service!, location!);
      const saved = storage.get(key);
      if (saved) return saved;
      const { sessionId } = await bookingApi.start(location!, service!);
      storage.set(key, sessionId);
      return sessionId;
    },
  });

  /** Forget this session and start a new one (after SESSION_EXPIRED). */
  const reset = () => {
    if (service && location) storage.remove(storageKey(service, location));
    void queryClient.resetQueries({ queryKey });
  };

  return { ...query, reset };
}

type Session = ReturnType<typeof useBookingSession>;

/** On SESSION_EXPIRED, start over with a new session; always rethrow so the UI knows. */
const resetOnExpiry = (session: Session) => (error: unknown) => {
  if (isCode(error, "SESSION_EXPIRED")) session.reset();
  throw error;
};

export function useAvailableDates(session: Session, from: string, to: string) {
  const sessionId = session.data;
  return useQuery({
    queryKey: ["booking-dates", sessionId, from, to],
    enabled: Boolean(sessionId),
    // Short and per session: dates change as the calendar fills.
    staleTime: 60_000,
    retry: retryTransient,
    queryFn: () => bookingApi.dates(sessionId!, from, to).then((r) => r.dates, resetOnExpiry(session)),
  });
}

export function useAvailableTimes(session: Session, date: string | undefined) {
  const sessionId = session.data;
  return useQuery({
    queryKey: ["booking-times", sessionId, date],
    // Only after the visitor picks a day (the vendor asks for queries on user action).
    enabled: Boolean(sessionId && date),
    staleTime: 30_000,
    retry: retryTransient,
    queryFn: () => bookingApi.times(sessionId!, date!).then((r) => r.times, resetOnExpiry(session)),
  });
}

export function useHold(session: Session) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slotId: string) => bookingApi.hold(session.data!, slotId),
    onError: (error) => {
      if (isCode(error, "SESSION_EXPIRED")) session.reset();
      // Someone else got it: refresh the times so the visitor sees what's really left.
      if (isCode(error, "SLOT_UNAVAILABLE")) void queryClient.invalidateQueries({ queryKey: ["booking-times", session.data] });
    },
  });
}
