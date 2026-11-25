// What an appointment change means for our bookings table. Vendor-neutral: it gets an
// AppointmentChange from the vendor's parser and never reads a vendor payload.
//
// Webhooks can arrive late, twice, or out of order, so every rule here is safe to run
// again and checks what it's about to overwrite:
// - created:     confirm our held row if its checkout response was lost; otherwise nothing
// - rescheduled: move the start, unless cancelled or older than a change already applied
// - cancelled:   cancel (it's final)
// A reschedule or cancel for an appointment we don't know throws: its CREATED may not be
// processed yet. The retry job runs it again, and the cap dead-letters bookings made
// outside our funnel.

import type { AppointmentChange } from "../_shared/booking-provider.ts";
import type { Log } from "../_shared/log.ts";

/** The part of a bookings row these rules read. vendorUpdatedAt: the latest change applied. */
export type BookingRef = { id: string; status: "held" | "confirmed" | "cancelled" | "expired"; vendorUpdatedAt: string | null };

/** The bookings table as webhook processing uses it. Times are UTC ISO. */
export type AppointmentBookings = {
  findByVendorId(provider: string, vendorAppointmentId: string): Promise<BookingRef | null>;
  /** A held row for this vendor location, start and email (case-insensitive): a checkout whose response was lost. */
  findHeld(provider: string, vendorLocationId: string, start: string, email: string): Promise<BookingRef | null>;
  confirm(id: string, vendorAppointmentId: string, occurredAt: string): Promise<void>;
  reschedule(id: string, start: string, occurredAt: string): Promise<void>;
  cancel(id: string, vendorUpdatedAt: string): Promise<void>;
};

/** The error a reschedule or cancel throws for an appointment we have no row for. */
export const UNKNOWN_APPOINTMENT = "unknown appointment, waiting for its CREATED";

export type Outcome = "ignored" | "not ours" | "unchanged" | "confirmed" | "rescheduled" | "stale" | "cancelled";

const isOlder = (occurredAt: string, applied: string | null) => applied !== null && Date.parse(occurredAt) <= Date.parse(applied);
const latest = (a: string, b: string | null) => (b && Date.parse(b) > Date.parse(a) ? b : a);

export async function applyAppointmentChange(
  bookings: AppointmentBookings,
  provider: string,
  change: AppointmentChange | null,
  log: Log,
): Promise<Outcome> {
  const outcome = await decide(bookings, provider, change);
  log.info("appointment change applied", { provider, kind: change?.kind, outcome });
  return outcome;
}

async function decide(bookings: AppointmentBookings, provider: string, change: AppointmentChange | null): Promise<Outcome> {
  if (!change) return "ignored";
  const row = await bookings.findByVendorId(provider, change.vendorAppointmentId);

  switch (change.kind) {
    case "created": {
      if (row) {
        // Usually checkout confirmed it already. Never revive a cancelled or expired row.
        if (row.status !== "held") return "unchanged";
        await bookings.confirm(row.id, change.vendorAppointmentId, change.occurredAt);
        return "confirmed";
      }
      // No row has this vendor id: maybe our checkout booked it but never heard back.
      const lost = change.email ? await bookings.findHeld(provider, change.vendorLocationId, change.start, change.email) : null;
      if (!lost) return "not ours"; // booked by phone or at the front desk
      await bookings.confirm(lost.id, change.vendorAppointmentId, change.occurredAt);
      return "confirmed";
    }
    case "rescheduled": {
      if (!row) throw new Error(UNKNOWN_APPOINTMENT);
      if (row.status === "cancelled") return "unchanged";
      if (isOlder(change.occurredAt, row.vendorUpdatedAt)) return "stale";
      await bookings.reschedule(row.id, change.start, change.occurredAt);
      return "rescheduled";
    }
    case "cancelled": {
      if (!row) throw new Error(UNKNOWN_APPOINTMENT);
      if (row.status === "cancelled") return "unchanged";
      // Cancelling is final, so even an older cancel applies; keep the newest event time.
      await bookings.cancel(row.id, latest(change.occurredAt, row.vendorUpdatedAt));
      return "cancelled";
    }
  }
}
