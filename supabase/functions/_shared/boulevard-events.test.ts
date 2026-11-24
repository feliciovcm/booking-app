// @vitest-environment node
// The parser is tested against what the mock really sends, so a change to the mock's
// payload shape breaks here instead of silently in production.
import { describe, expect, it } from "vitest";
import { SERVICES, VENDOR_LOCATIONS } from "../mock-boulevard/slots.ts";
import { appointmentEvent, type Appointment, type AppointmentEventType } from "../mock-boulevard/webhooks.ts";
import { parseBoulevardEvent } from "./boulevard-events.ts";

const LOCATION = Object.keys(VENDOR_LOCATIONS)[0];
const appointment: Appointment = {
  id: "urn:blvd:Appointment:a1",
  clientId: "urn:blvd:Client:c1",
  locationId: LOCATION,
  serviceId: SERVICES[0].id,
  start: new Date("2026-11-25T15:00:00Z"),
  client: { firstName: "Avery", lastName: "Quinn", email: "avery@example.com", phoneNumber: null },
  bookedByType: "CLIENT",
};
const ids = { businessId: "urn:blvd:Business:b1", apiApplicationId: "urn:blvd:ApiApplication:app1", webhookId: "urn:blvd:Webhook:w1", idempotencyKey: "evt-1" };
const payload = (type: AppointmentEventType, extra: Partial<Appointment> = {}) =>
  JSON.parse(JSON.stringify(appointmentEvent(type, { ...appointment, ...extra }, ids, new Date("2026-11-24T12:00:00Z"))));

describe("parseBoulevardEvent", () => {
  it("turns APPOINTMENT_CREATED into a vendor-neutral change, with the start in UTC", () => {
    expect(parseBoulevardEvent(payload("APPOINTMENT_CREATED"))).toEqual({
      kind: "created",
      vendorAppointmentId: "urn:blvd:Appointment:a1",
      vendorLocationId: LOCATION,
      start: "2026-11-25T15:00:00.000Z", // Boulevard sends local time with an offset
      email: "avery@example.com",
      occurredAt: "2026-11-24T12:00:00.000Z",
    });
  });

  it("reads the new start of a reschedule and the cancellation", () => {
    const moved = parseBoulevardEvent(payload("APPOINTMENT_RESCHEDULED", { start: new Date("2026-11-26T15:00:00Z") }));
    expect(moved).toMatchObject({ kind: "rescheduled", start: "2026-11-26T15:00:00.000Z" });
    const cancelled = parseBoulevardEvent(payload("APPOINTMENT_CANCELLED", { cancelledAt: new Date("2026-11-24T12:00:00Z") }));
    expect(cancelled).toMatchObject({ kind: "cancelled", vendorAppointmentId: "urn:blvd:Appointment:a1" });
  });

  it("keeps a booking without a client (made by staff) and without an email", () => {
    expect(parseBoulevardEvent(payload("APPOINTMENT_CREATED", { client: null, bookedByType: "STAFF" }))).toMatchObject({ email: null });
  });

  it("returns null for event types we don't act on", () => {
    expect(parseBoulevardEvent({ ...payload("APPOINTMENT_CREATED"), eventType: "APPOINTMENT_ARRIVED" })).toBeNull();
    expect(parseBoulevardEvent({ eventType: "CLIENT_UPDATED", data: { node: {} } })).toBeNull();
  });

  it("throws on a payload it should understand but can't, so the event isn't silently dropped", () => {
    const broken = payload("APPOINTMENT_CREATED");
    delete broken.data.node.startAt;
    expect(() => parseBoulevardEvent(broken)).toThrow("unexpected APPOINTMENT_CREATED payload");
    expect(() => parseBoulevardEvent({ ...payload("APPOINTMENT_CREATED"), timestamp: "yesterday" })).toThrow();
  });
});
