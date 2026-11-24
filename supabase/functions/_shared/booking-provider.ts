// The contract between our booking code and any booking vendor (Boulevard today).
// Our functions and our frontend only ever see these names and these error codes;
// each vendor adapter translates its own API and errors into them.

/** A bookable time. `id` is opaque: pass it back to hold(). `start` is UTC ISO. */
export type Slot = { id: string; start: string };

/** A hold on a time. `start` and `expiresAt` are UTC ISO. */
export type Hold = { start: string; expiresAt: string };

/** Who the booking is for. Phone, when given, is E.164 (+13105555555). */
export type Client = { firstName: string; lastName: string; email: string; phone?: string };

export interface BookingProvider {
  /** Starts a booking session for one service at one location (vendor ids from our mapping tables). */
  startSession(vendorLocationId: string, vendorServiceId: string): Promise<{ sessionId: string }>;
  /** Days in [from, to] (YYYY-MM-DD, the clinic's local dates) with at least one free time. */
  availableDates(sessionId: string, from: string, to: string): Promise<string[]>;
  availableTimes(sessionId: string, date: string): Promise<Slot[]>;
  /** Holds a time for this session until expiresAt. */
  hold(sessionId: string, slotId: string): Promise<Hold>;
  /** What the vendor says this session is for, and its live hold (null if none or lapsed). */
  summary(sessionId: string): Promise<{ vendorLocationId: string; vendorServiceId: string; hold: Hold | null }>;
  /** Books the held time. Safe to retry: a session that already checked out returns the same confirmation. */
  checkout(sessionId: string, client: Client, cardToken: string): Promise<{ confirmationId: string }>;
}

/**
 * A vendor's webhook, in our terms: what happened to which appointment. Each vendor's
 * parser produces this, so processing never reads a vendor payload. Times are UTC ISO.
 */
export type AppointmentChange = {
  kind: "created" | "rescheduled" | "cancelled";
  vendorAppointmentId: string;
  vendorLocationId: string;
  /** The appointment's start after this change. */
  start: string;
  email: string | null;
  /** When the vendor says it happened. Orders changes that arrive out of order. */
  occurredAt: string;
};

/**
 * Our error codes, the only ones callers handle:
 * - SLOT_UNAVAILABLE: someone else got the time; pick another
 * - SESSION_EXPIRED: the hold lapsed or the session is gone; start the time step again
 * - INVALID: the vendor rejected the input (the message says why)
 * - UNAVAILABLE: the vendor is down or slow; retrying later may work
 * - MISCONFIGURED: our setup is wrong (credentials, mappings); retrying won't help
 */
export type BookingErrorCode = "SLOT_UNAVAILABLE" | "SESSION_EXPIRED" | "INVALID" | "UNAVAILABLE" | "MISCONFIGURED";

export class BookingError extends Error {
  readonly code: BookingErrorCode;
  /** Safe to show the visitor. */
  readonly userMessage: string;
  /** The vendor's own code, for logs only (e.g. CART_TIME_NOT_AVAILABLE). */
  readonly vendorCode?: string;
  constructor(code: BookingErrorCode, userMessage: string, vendorCode?: string) {
    super(`Booking ${code}${vendorCode ? ` (${vendorCode})` : ""}`);
    this.name = "BookingError";
    this.code = code;
    this.userMessage = userMessage;
    this.vendorCode = vendorCode;
  }

  get retryable(): boolean {
    return this.code === "UNAVAILABLE";
  }
}

export const UNAVAILABLE_MESSAGE = "Booking is temporarily unavailable. Please try again in a moment.";
