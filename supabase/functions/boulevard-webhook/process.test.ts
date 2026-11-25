// @vitest-environment node
// What an appointment change does to our bookings table, vendor-neutral and in memory.
import { describe, expect, it } from "vitest";
import type { AutomationEvent } from "../_shared/automations.ts";
import type { AppointmentChange } from "../_shared/booking-provider.ts";
import { createLogger } from "../_shared/log.ts";
import { applyAppointmentChange, type AppointmentBookings, type BookingRef } from "./process.ts";

type Row = BookingRef & { provider: string; vendorLocationId: string; slotStart: string; email: string; providerBookingId: string | null };

function memoryBookings(rows: Row[]) {
  const byId = (id: string) => rows.find((r) => r.id === id)!;
  const repo: AppointmentBookings = {
    findByVendorId: async (provider, vendorId) => rows.find((r) => r.provider === provider && r.providerBookingId === vendorId) ?? null,
    findHeld: async (provider, vendorLocationId, start, email) =>
      rows.find(
        (r) => r.status === "held" && r.provider === provider && r.vendorLocationId === vendorLocationId && r.slotStart === start && r.email.toLowerCase() === email.toLowerCase(),
      ) ?? null,
    confirm: async (id, vendorId, occurredAt) => void Object.assign(byId(id), { status: "confirmed", providerBookingId: vendorId, vendorUpdatedAt: occurredAt }),
    reschedule: async (id, start, occurredAt) => void Object.assign(byId(id), { slotStart: start, vendorUpdatedAt: occurredAt }),
    cancel: async (id, occurredAt) => void Object.assign(byId(id), { status: "cancelled", vendorUpdatedAt: occurredAt }),
    describe: async (id) => ({ location: "noho", treatment: "prp", start: byId(id).slotStart }),
  };
  return repo;
}

const confirmed = (): Row => ({
  id: "b1",
  status: "confirmed",
  provider: "boulevard",
  vendorLocationId: "loc-noho",
  slotStart: "2026-11-25T15:00:00.000Z",
  email: "Avery@Example.com",
  providerBookingId: "appt-1",
  vendorUpdatedAt: null,
});
const held = (): Row => ({ ...confirmed(), status: "held", providerBookingId: null });

const change = (kind: AppointmentChange["kind"], extra: Partial<AppointmentChange> = {}): AppointmentChange => ({
  kind,
  vendorAppointmentId: "appt-1",
  vendorLocationId: "loc-noho",
  start: "2026-11-25T15:00:00.000Z",
  email: "avery@example.com",
  occurredAt: "2026-11-24T12:00:00.000Z",
  ...extra,
});

const log = createLogger("test", "r1", { log() {}, warn() {}, error() {} });
const apply = (rows: Row[], c: AppointmentChange | null, forwarded?: AutomationEvent[]) =>
  applyAppointmentChange(memoryBookings(rows), "boulevard", c, log, forwarded && ((e) => void forwarded.push(e)));

describe("applyAppointmentChange", () => {
  describe("created", () => {
    it("changes nothing when checkout already confirmed the booking (the usual case)", async () => {
      const rows = [confirmed()];
      expect(await apply(rows, change("created"))).toBe("unchanged");
      expect(rows[0]).toEqual(confirmed());
    });

    it("confirms a held booking whose checkout response was lost, matched by place, time and email", async () => {
      const rows = [held()];
      expect(await apply(rows, change("created"))).toBe("confirmed");
      expect(rows[0]).toMatchObject({ status: "confirmed", providerBookingId: "appt-1", vendorUpdatedAt: "2026-11-24T12:00:00.000Z" });
    });

    it("doesn't confirm a held booking for another time, person or vendor", async () => {
      const rows = [held(), { ...held(), id: "b2", provider: "acme" }];
      expect(await apply(rows, change("created", { start: "2026-11-25T16:00:00.000Z" }))).toBe("not ours");
      expect(await apply(rows, change("created", { email: "someone@example.com" }))).toBe("not ours");
      expect(await apply(rows, change("created", { email: null }))).toBe("not ours");
      expect(rows.map((r) => r.status)).toEqual(["held", "held"]);
    });

    it("leaves bookings made outside our funnel alone (phone, front desk)", async () => {
      const rows: Row[] = [];
      expect(await apply(rows, change("created", { vendorAppointmentId: "appt-phone" }))).toBe("not ours");
      expect(rows).toEqual([]);
    });

    it("doesn't revive a booking that was cancelled before its CREATED arrived", async () => {
      const rows = [{ ...confirmed(), status: "cancelled" as const }];
      expect(await apply(rows, change("created"))).toBe("unchanged");
      expect(rows[0].status).toBe("cancelled");
    });
  });

  describe("rescheduled", () => {
    it("moves the booking to the new start", async () => {
      const rows = [confirmed()];
      expect(await apply(rows, change("rescheduled", { start: "2026-11-26T15:00:00.000Z" }))).toBe("rescheduled");
      expect(rows[0]).toMatchObject({ slotStart: "2026-11-26T15:00:00.000Z", vendorUpdatedAt: "2026-11-24T12:00:00.000Z" });
    });

    it("skips a reschedule older than one already applied, so out-of-order delivery keeps the latest time", async () => {
      const rows = [confirmed()];
      await apply(rows, change("rescheduled", { start: "2026-11-27T15:00:00.000Z", occurredAt: "2026-11-24T12:05:00.000Z" }));
      expect(await apply(rows, change("rescheduled", { start: "2026-11-26T15:00:00.000Z", occurredAt: "2026-11-24T12:01:00.000Z" }))).toBe("stale");
      expect(rows[0].slotStart).toBe("2026-11-27T15:00:00.000Z");
    });

    it("ignores a reschedule of a cancelled booking", async () => {
      const rows = [{ ...confirmed(), status: "cancelled" as const }];
      expect(await apply(rows, change("rescheduled", { start: "2026-11-26T15:00:00.000Z" }))).toBe("unchanged");
      expect(rows[0].slotStart).toBe("2026-11-25T15:00:00.000Z");
    });
  });

  describe("cancelled", () => {
    it("cancels the booking", async () => {
      const rows = [confirmed()];
      expect(await apply(rows, change("cancelled"))).toBe("cancelled");
      expect(rows[0]).toMatchObject({ status: "cancelled", vendorUpdatedAt: "2026-11-24T12:00:00.000Z" });
    });

    it("keeps the later event time when an older cancel arrives after a reschedule", async () => {
      const rows = [{ ...confirmed(), vendorUpdatedAt: "2026-11-24T12:05:00.000Z" }];
      expect(await apply(rows, change("cancelled", { occurredAt: "2026-11-24T12:01:00.000Z" }))).toBe("cancelled");
      expect(rows[0]).toMatchObject({ status: "cancelled", vendorUpdatedAt: "2026-11-24T12:05:00.000Z" });
    });
  });

  it("throws for a reschedule or cancel of an appointment we don't know, so it's retried until the cap", async () => {
    // Either its CREATED hasn't been processed yet (out of order) or it was booked outside the funnel.
    await expect(apply([], change("rescheduled"))).rejects.toThrow("unknown appointment");
    await expect(apply([held()], change("cancelled"))).rejects.toThrow("unknown appointment");
  });

  describe("forwarding to automations", () => {
    it("forwards each change it made, with our slugs and the booking's current start", async () => {
      const forwarded: AutomationEvent[] = [];
      await apply([held()], change("created"), forwarded);
      await apply([confirmed()], change("rescheduled", { start: "2026-11-26T15:00:00.000Z" }), forwarded);
      await apply([confirmed()], change("cancelled"), forwarded);
      expect(forwarded).toEqual([
        { type: "booking.confirmed", bookingId: "b1", location: "noho", treatment: "prp", start: "2026-11-25T15:00:00.000Z" },
        { type: "booking.rescheduled", bookingId: "b1", location: "noho", treatment: "prp", start: "2026-11-26T15:00:00.000Z" },
        { type: "booking.cancelled", bookingId: "b1", location: "noho", treatment: "prp", start: "2026-11-25T15:00:00.000Z" },
      ]);
    });

    it("forwards nothing when nothing changed, so a redelivery or a phone booking isn't announced", async () => {
      const forwarded: AutomationEvent[] = [];
      await apply([confirmed()], change("created"), forwarded); // checkout already announced it
      await apply([], change("created", { vendorAppointmentId: "appt-phone" }), forwarded);
      await apply([{ ...confirmed(), vendorUpdatedAt: "2026-11-24T13:00:00.000Z" }], change("rescheduled"), forwarded);
      await apply([{ ...confirmed(), status: "cancelled" as const }], change("cancelled"), forwarded);
      expect(forwarded).toEqual([]);
    });

    it("still succeeds when forwarding fails", async () => {
      const rows = [confirmed()];
      const outcome = applyAppointmentChange(memoryBookings(rows), "boulevard", change("cancelled"), log, () => Promise.reject(new Error("n8n down")));
      await expect(outcome).resolves.toBe("cancelled");
      expect(rows[0].status).toBe("cancelled");
    });
  });

  it("does nothing for event types the parser doesn't act on", async () => {
    expect(await apply([confirmed()], null)).toBe("ignored");
  });
});
