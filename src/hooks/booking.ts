import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { bookingApi, isBookingError, type Client } from "../api/booking";

// Retry only what retrying can fix, at most twice.
const retryTransient = (failures: number, error: Error) =>
  failures < 2 && (isBookingError(error, "UNAVAILABLE") || isBookingError(error, "NETWORK"));

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
  if (isBookingError(error, "SESSION_EXPIRED")) session.reset();
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
      if (isBookingError(error, "SESSION_EXPIRED")) session.reset();
      // Someone else got it: refresh the times so the visitor sees what's really left.
      if (isBookingError(error, "SLOT_UNAVAILABLE")) void queryClient.invalidateQueries({ queryKey: ["booking-times", session.data] });
    },
  });
}

/** The live hold on this session, read from the vendor: the checkout page survives a refresh. */
export function useHoldSummary(session: Session) {
  const sessionId = session.data;
  return useQuery({
    queryKey: ["booking-summary", sessionId],
    enabled: Boolean(sessionId),
    staleTime: 0, // a hold can lapse at any moment
    retry: retryTransient,
    queryFn: () => bookingApi.summary(sessionId!).then((r) => r.hold, resetOnExpiry(session)),
  });
}

// One idempotency key per checkout attempt, kept per session. Retries and a refresh reuse
// it, so the server answers "the same booking" instead of booking twice. A definite "no"
// (the time is gone, the hold lapsed) ends the attempt, and the next one gets a new key.
const checkoutKeyName = (sessionId: string) => `booking-checkout:${sessionId}`;
function checkoutKey(sessionId: string): string {
  const saved = storage.get(checkoutKeyName(sessionId));
  if (saved) return saved;
  const key = crypto.randomUUID();
  storage.set(checkoutKeyName(sessionId), key);
  return key;
}

export function useCheckout(session: Session, service: string, location: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Only the token from the vendor's tokenizer comes in here, never card data: mutation
    // variables live in the query cache.
    mutationFn: ({ client, cardToken }: { client: Client; cardToken: string }) => {
      const sessionId = session.data!;
      return bookingApi.checkout({ sessionId, location, service, idempotencyKey: checkoutKey(sessionId), client, cardToken });
    },
    // Unlike other mutations, checkout is safe to retry: the same key can't book twice.
    retry: retryTransient,
    onSuccess: () => {
      // The booking is done. Drop the session and key so the next booking starts clean.
      storage.remove(checkoutKeyName(session.data!));
      storage.remove(storageKey(service, location));
    },
    onError: (error) => {
      if (isBookingError(error, "SLOT_UNAVAILABLE") || isBookingError(error, "SESSION_EXPIRED")) {
        storage.remove(checkoutKeyName(session.data!));
        void queryClient.invalidateQueries({ queryKey: ["booking-summary", session.data] });
      }
      if (isBookingError(error, "SESSION_EXPIRED")) session.reset();
    },
  });
}

/** After a booking: forget its session in memory too, so going back starts a new one. */
export function useForgetBookingSession(service: string | undefined, location: string | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.removeQueries({ queryKey: ["booking-session", service, location] });
  }, [queryClient, service, location]);
}
