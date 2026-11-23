// The mock's webhook sender: what Boulevard does when an appointment changes.
//
// Payloads follow the APPOINTMENT_* examples in Boulevard's Admin API reference (2026-06).
// The `cancellation` object's fields aren't shown in the docs, so that shape is the mock's
// guess. Delivery follows the webhooks guide: signed headers, a 10 s timeout, maxRetries
// (default 1), and a 410 Gone disables the subscription for good.
//
// Simplification: real webhooks are created per location with the Admin API's
// createWebhook; the mock sends everything to one configured URL.

import { SALT_HEADER, SIGNATURE_HEADER, makeSalt, signBoulevardWebhook } from "../_shared/boulevard-signature.ts";
import type { ClientInformation } from "./schema.ts";
import { SERVICES, SLOT_MINUTES, VENDOR_LOCATIONS, formatLocal } from "./slots.ts";

export type AppointmentEventType = "APPOINTMENT_CREATED" | "APPOINTMENT_RESCHEDULED" | "APPOINTMENT_CANCELLED";

/** What the mock knows about an appointment, enough to build Boulevard's payload. */
export type Appointment = {
  id: string;
  clientId: string;
  locationId: string;
  serviceId: string;
  start: Date;
  client: ClientInformation | null;
  /** CLIENT when booked online through a cart, STAFF when the front desk did it. */
  bookedByType: "CLIENT" | "STAFF";
  cancelledAt?: Date;
};

export type EventIds = { businessId: string; apiApplicationId: string; webhookId: string; idempotencyKey: string };

const EVENT_NAMES: Record<AppointmentEventType, string> = {
  APPOINTMENT_CREATED: "appointment.created",
  APPOINTMENT_RESCHEDULED: "appointment.rescheduled",
  APPOINTMENT_CANCELLED: "appointment.cancelled",
};

export function appointmentEvent(type: AppointmentEventType, appointment: Appointment, ids: EventIds, now: Date) {
  const location = VENDOR_LOCATIONS[appointment.locationId];
  const service = SERVICES.find((s) => s.id === appointment.serviceId);
  const tz = location?.timezone ?? "UTC";
  const startAt = formatLocal(appointment.start, tz);
  const endAt = formatLocal(new Date(appointment.start.getTime() + SLOT_MINUTES * 60_000), tz);
  const client = appointment.client;
  const name = [client?.firstName, client?.lastName].filter(Boolean).join(" ") || null;

  return {
    apiApplicationId: ids.apiApplicationId,
    businessId: ids.businessId,
    data: {
      node: {
        __typename: "Appointment",
        appointmentServices: [
          {
            baseAppointmentServiceId: null,
            id: `${appointment.id}:service:1`,
            service: { externalId: null, id: appointment.serviceId, name: service?.name ?? null },
            serviceId: appointment.serviceId,
            staff: null,
            staffId: null,
            staffRequested: false,
            startAt,
            startTimeOffset: 0,
          },
        ],
        bookedByType: appointment.bookedByType,
        cancellation: appointment.cancelledAt ? { cancelledAt: appointment.cancelledAt.toISOString(), reason: "STAFF_CANCEL", notes: null } : null,
        client: client
          ? {
              dob: null,
              email: client.email ?? null,
              externalId: null,
              firstName: client.firstName ?? null,
              id: appointment.clientId,
              lastName: client.lastName ?? null,
              mobilePhone: client.phoneNumber ?? null,
              name,
            }
          : null,
        clientId: appointment.clientId,
        clientPhone: client?.phoneNumber ?? null,
        deliveryMethod: "IN_PERSON",
        duration: SLOT_MINUTES,
        endAt,
        id: appointment.id,
        inPersonLocation: "BUSINESS",
        location: { businessName: "Great Many", externalId: null, id: appointment.locationId, name: location?.name ?? null, tz },
        locationId: appointment.locationId,
        notes: null,
        orderId: null,
        startAt,
        tags: [],
        virtualJoiningInstructions: null,
        virtualMeetingUrl: null,
      },
    },
    event: EVENT_NAMES[type],
    eventType: type,
    idempotencyKey: ids.idempotencyKey,
    resource: "Appointment",
    timestamp: now.toISOString(),
    webhookId: ids.webhookId,
  };
}

export type WebhookSender = { send(event: object): Promise<void> };

/**
 * Delivers events like Boulevard: one signed POST, retried up to maxRetries times on a
 * non-2xx or a timeout, and never again after a 410. It never throws: a delivery that
 * fails is logged and dropped, which is why our receiver needs a reconciliation job.
 */
export function createWebhookSender(config: {
  url: string;
  /** The OAuth client secret, as the portal shows it (Base64 text). */
  clientSecret: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}): WebhookSender {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = config.now ?? (() => new Date());
  const maxRetries = config.maxRetries ?? 1;
  const log = config.log ?? (() => {});
  let disabled = false;

  return {
    async send(event) {
      const meta = event as { eventType?: string; idempotencyKey?: string };
      const fields = { fn: "mock-boulevard", msg: "webhook delivery", eventType: meta.eventType, idempotencyKey: meta.idempotencyKey };
      if (disabled) return log({ ...fields, outcome: "skipped", reason: "subscription disabled after 410" });

      const body = JSON.stringify(event);
      const deliveryId = crypto.randomUUID();
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const salt = makeSalt(deliveryId, Math.floor(now().getTime() / 1000));
        let status = 0;
        try {
          const res = await doFetch(config.url, {
            method: "POST",
            headers: { "content-type": "application/json", [SALT_HEADER]: salt, [SIGNATURE_HEADER]: await signBoulevardWebhook(config.clientSecret, salt, body) },
            body,
            signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
          });
          status = res.status;
        } catch {
          // timeout or connection error: status stays 0
        }
        log({ ...fields, attempt, status });
        if (status >= 200 && status < 300) return;
        if (status === 410) {
          disabled = true; // Boulevard: a 410 is a permanent "this endpoint is gone"
          return log({ ...fields, outcome: "disabled" });
        }
        if (attempt < maxRetries) await sleep(config.retryDelayMs ?? 1000);
      }
      log({ ...fields, outcome: "failed permanently" });
    },
  };
}
