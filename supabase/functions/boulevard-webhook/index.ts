// Deno entry for the Boulevard webhook receiver. Wires the handler to Postgres and to
// EdgeRuntime.waitUntil, which keeps processing running after the 200 goes back.

import { createClient } from "@supabase/supabase-js";
import { parseBoulevardEvent } from "../_shared/boulevard-events.ts";
import { createHandler } from "./handler.ts";
import { applyAppointmentChange } from "./process.ts";
import { createAppointmentBookings, createWebhookEvents } from "./store.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

// Secret key = service_role: webhook_events and the mapping tables are server only, and
// clients can't write bookings. Every value written comes from a verified, parsed event.
const secretKey = (JSON.parse(env("SUPABASE_SECRET_KEYS")) as Record<string, string>).default;
const admin = createClient(env("SUPABASE_URL"), secretKey, { auth: { persistSession: false } });
const bookings = createAppointmentBookings(admin);

export default {
  fetch: createHandler({
    secretBase64: env("BOULEVARD_CLIENT_SECRET"),
    events: createWebhookEvents(admin),
    // Boulevard's payload -> our AppointmentChange -> bookings. Throwing leaves the event unprocessed.
    process: async (event, log) => {
      await applyAppointmentChange(bookings, event.provider, parseBoulevardEvent(event.payload), log);
    },
    defer: (work) => EdgeRuntime.waitUntil(work),
  }),
};
