// Boulevard's appointment webhooks, read into our vendor-neutral AppointmentChange.
// The only place that knows Boulevard's payload shape (Admin API reference, 2026-06).
// Another vendor gets its own parser next to its adapter; processing stays the same.

import { z } from "zod";
import type { AppointmentChange } from "./booking-provider.ts";

const KINDS: Record<string, AppointmentChange["kind"]> = {
  APPOINTMENT_CREATED: "created",
  APPOINTMENT_RESCHEDULED: "rescheduled",
  APPOINTMENT_CANCELLED: "cancelled",
};

// An ISO time with an offset ("2026-11-25T10:00:00-05:00" or "...Z"), turned into UTC.
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());

// Only the fields we use. Everything else in the payload is ignored, so Boulevard adding
// fields never breaks us.
const Payload = z.object({
  timestamp: instant,
  data: z.object({
    node: z.object({
      id: z.string().min(1),
      locationId: z.string().min(1),
      startAt: instant,
      client: z.object({ email: z.string().nullable().optional() }).nullable().optional(),
    }),
  }),
});

/**
 * Null for event types we don't act on. Throws for a type we act on whose payload doesn't
 * match: the event then stays unprocessed and visible, instead of being dropped.
 */
export function parseBoulevardEvent(payload: unknown): AppointmentChange | null {
  const kind = KINDS[(payload as { eventType?: unknown } | null)?.eventType as string];
  if (!kind) return null;

  const parsed = Payload.safeParse(payload);
  // Issue paths only, never values: the payload holds client details.
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`unexpected ${(payload as { eventType: string }).eventType} payload (${paths})`);
  }
  const { timestamp, data } = parsed.data;
  return {
    kind,
    vendorAppointmentId: data.node.id,
    vendorLocationId: data.node.locationId,
    start: data.node.startAt,
    email: data.node.client?.email ?? null,
    occurredAt: timestamp,
  };
}
