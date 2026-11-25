// Forwards clean events to an automation tool (n8n in step 5b): booking changes and ops
// alerts. Vendor-neutral and free of client data: ids, slugs and times only, so the
// automation tool never holds personal or health data.
//
// Delivery is one try with a short timeout, and a failure is only logged: an automation
// can miss an event. That keeps bookings independent of n8n. The production answer is an
// outbox table, written in the same transaction as the change, that a job delivers and retries.

import type { Log } from "./log.ts";

export type AutomationEvent =
  | {
      type: "booking.confirmed" | "booking.rescheduled" | "booking.cancelled";
      bookingId: string;
      /** Our slugs, not vendor ids. */
      location: string;
      treatment: string;
      /** UTC ISO. */
      start: string;
    }
  | { type: "alert.dead_letters"; failed: number; waitingForCreated: number }
  | { type: "alert.webhooks_silent"; confirmedBookings: number };

export type Automations = { send(event: AutomationEvent, log: Log): Promise<void> };

export const SECRET_HEADER = "x-automations-secret";

export function createAutomations(config: {
  /** AUTOMATIONS_WEBHOOK_URL. Unset: nothing is sent. */
  url?: string;
  /** AUTOMATIONS_SECRET, checked by the receiving workflow. */
  secret?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): Automations {
  const { url, secret } = config;
  if (url && !secret) throw new Error("AUTOMATIONS_SECRET must be set when AUTOMATIONS_WEBHOOK_URL is");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());

  return {
    async send(event, log) {
      if (!url || !secret) return;
      // The id lets the workflow drop a duplicate if one ever arrives.
      const body = JSON.stringify({ id: crypto.randomUUID(), sentAt: now().toISOString(), ...event });
      let status = 0;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", [SECRET_HEADER]: secret },
          body,
          signal: AbortSignal.timeout(config.timeoutMs ?? 5000),
        });
        status = res.status;
      } catch {
        // timeout or connection error: status stays 0
      }
      if (status >= 200 && status < 300) log.info("automation delivered", { type: event.type, status });
      else log.warn("automation not delivered", { type: event.type, status });
    },
  };
}
