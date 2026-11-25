// @vitest-environment node
// The scheduled jobs in memory: retrying events, reconciling stuck held bookings, and the
// silence check. pg_cron calls this every 5 minutes in production.
import { describe, expect, it } from "vitest";
import type { InboundEvent } from "../boulevard-webhook/handler.ts";
import { UNKNOWN_APPOINTMENT } from "../boulevard-webhook/process.ts";
import { createHandler, MAX_ATTEMPTS, type Deps, type HeldBooking, type JobsStore } from "./handler.ts";

const SECRET = "cron-secret-for-tests";
const NOW = Date.parse("2026-11-24T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

type EventRow = InboundEvent & { receivedAt: string; processed: boolean; attempts: number; lastError: string | null };
type BookingRow = HeldBooking & { status: string; createdAt: string; providerBookingId: string | null };

function memoryStore(events: EventRow[], bookings: BookingRow[]) {
  const store: JobsStore = {
    retryableEvents: async (before, maxAttempts, limit) =>
      events.filter((e) => !e.processed && e.attempts < maxAttempts && e.receivedAt < before).slice(0, limit),
    deadLetters: async (maxAttempts) => {
      const dead = events.filter((e) => !e.processed && e.attempts >= maxAttempts);
      const waiting = dead.filter((e) => e.lastError === UNKNOWN_APPOINTMENT).length;
      return { waitingForCreated: waiting, failed: dead.length - waiting };
    },
    staleHeld: async (before, limit) => bookings.filter((b) => b.status === "held" && b.providerSessionId && b.createdAt < before).slice(0, limit),
    confirmHeld: async (id, confirmationId) => void Object.assign(bookings.find((b) => b.id === id)!, { status: "confirmed", providerBookingId: confirmationId }),
    expireHeld: async (id) => void Object.assign(bookings.find((b) => b.id === id)!, { status: "expired" }),
    activity: async (since, until) => ({
      confirmed: bookings.filter((b) => b.status === "confirmed" && b.createdAt >= since && b.createdAt < until).length,
      webhooks: events.filter((e) => e.receivedAt >= since).length,
    }),
  };
  return store;
}

const event = (id: string, extra: Partial<EventRow> = {}): EventRow => ({
  provider: "boulevard",
  eventId: id,
  type: "APPOINTMENT_CANCELLED",
  payload: { id },
  receivedAt: minutesAgo(10),
  processed: false,
  attempts: 1,
  lastError: "bookings table unreachable",
  ...extra,
});
const heldBooking = (id: string, extra: Partial<BookingRow> = {}): BookingRow => ({
  id,
  provider: "boulevard",
  providerSessionId: `cart-${id}`,
  status: "held",
  createdAt: minutesAgo(60),
  providerBookingId: null,
  ...extra,
});

function setup({ events = [] as EventRow[], bookings = [] as BookingRow[], overrides = {} as Partial<Deps>, booked = {} as Record<string, string> } = {}) {
  const processed: string[] = [];
  const deferred: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const line = (l: string) => logs.push(JSON.parse(l));
  const statusCalls: string[] = [];
  const handler = createHandler({
    cronSecret: SECRET,
    store: memoryStore(events, bookings),
    events: {
      recordAttempt: async (_provider, eventId, error) => {
        const row = events.find((e) => e.eventId === eventId)!;
        row.attempts++;
        row.lastError = error;
        row.processed = error === null;
      },
    },
    process: async (e) => {
      processed.push(e.eventId);
    },
    providers: {
      boulevard: () => ({
        checkoutStatus: async (sessionId) => {
          statusCalls.push(sessionId);
          if (sessionId === "cart-broken") throw new Error("vendor down");
          return { confirmationId: booked[sessionId] ?? null };
        },
      }),
    },
    defer: (work) => deferred.push(work),
    now: () => NOW,
    sink: { log: line, warn: line, error: line },
    ...overrides,
  });
  const run = async (headers: Record<string, string> = { "x-cron-secret": SECRET }) => {
    const res = await handler(new Request("http://localhost/functions/v1/webhook-jobs", { method: "POST", headers }));
    await Promise.all(deferred);
    return res;
  };
  return { run, events, bookings, processed, logs, statusCalls };
}

describe("webhook-jobs", () => {
  it("only runs for the cron secret, and replies before doing the work", async () => {
    const { run, processed } = setup({ events: [event("e1")] });
    expect((await run({})).status).toBe(401);
    expect((await run({ "x-cron-secret": "guess" })).status).toBe(401);
    expect(processed).toEqual([]);
    expect((await run()).status).toBe(202); // pg_net gives up after a few seconds, so don't make it wait
    expect(processed).toEqual(["e1"]);
  });

  describe("retry", () => {
    it("re-runs unprocessed events and records the try", async () => {
      const { run, events, processed } = setup({ events: [event("e1"), event("e2", { processed: true })] });
      await run();
      expect(processed).toEqual(["e1"]);
      expect(events[0]).toMatchObject({ processed: true, attempts: 2, lastError: null });
    });

    it("leaves fresh events to the receiver, and stops at the attempt cap", async () => {
      const { run, processed } = setup({
        events: [event("fresh", { receivedAt: minutesAgo(0.5) }), event("capped", { attempts: MAX_ATTEMPTS })],
      });
      await run();
      expect(processed).toEqual([]);
    });

    it("reports dead letters, but only as an error when they aren't the expected kind", async () => {
      const { run, logs } = setup({
        events: [
          event("phone-booking", { attempts: MAX_ATTEMPTS, lastError: UNKNOWN_APPOINTMENT }),
          event("broken", { attempts: MAX_ATTEMPTS, lastError: "unexpected APPOINTMENT_CREATED payload (data.node.startAt)" }),
        ],
      });
      await run();
      expect(logs).toContainEqual(expect.objectContaining({ level: "error", msg: "webhook dead letters", failed: 1, waitingForCreated: 1 }));
    });
  });

  describe("reconcile", () => {
    it("confirms a stuck held booking the vendor did book, and expires one it didn't", async () => {
      const { run, bookings, statusCalls } = setup({
        bookings: [heldBooking("booked"), heldBooking("abandoned"), heldBooking("recent", { createdAt: minutesAgo(10) })],
        booked: { "cart-booked": "urn:blvd:Appointment:a1" },
      });
      await run();
      expect(statusCalls).toEqual(["cart-booked", "cart-abandoned"]); // a recent hold may still be checked out
      expect(bookings.map((b) => [b.id, b.status, b.providerBookingId])).toEqual([
        ["booked", "confirmed", "urn:blvd:Appointment:a1"],
        ["abandoned", "expired", null],
        ["recent", "held", null],
      ]);
    });

    it("keeps going when the vendor fails for one booking, leaving it held for the next run", async () => {
      const { run, bookings } = setup({ bookings: [heldBooking("broken"), heldBooking("abandoned")] });
      await run();
      expect(bookings.map((b) => b.status)).toEqual(["held", "expired"]);
    });
  });

  describe("silence check", () => {
    it("alerts when bookings were confirmed but no webhook arrived", async () => {
      const { run, logs } = setup({ bookings: [heldBooking("b1", { status: "confirmed", createdAt: minutesAgo(30) })] });
      await run();
      expect(logs).toContainEqual(expect.objectContaining({ level: "error", msg: "no webhooks for recent bookings", confirmedBookings: 1 }));
    });

    it("stays quiet when webhooks are arriving, or when nobody booked", async () => {
      const busy = setup({
        bookings: [heldBooking("b1", { status: "confirmed", createdAt: minutesAgo(30) })],
        events: [event("e1", { processed: true, receivedAt: minutesAgo(20) })],
      });
      await busy.run();
      const idle = setup();
      await idle.run();
      for (const logs of [busy.logs, idle.logs]) expect(logs.some((l) => l.msg === "no webhooks for recent bookings")).toBe(false);
    });
  });

  it("logs a summary of each run", async () => {
    const { run, logs } = setup({ events: [event("e1")], bookings: [heldBooking("abandoned")] });
    await run();
    expect(logs).toContainEqual(expect.objectContaining({ msg: "jobs finished", retried: 1, confirmed: 0, expired: 1 }));
  });
});
