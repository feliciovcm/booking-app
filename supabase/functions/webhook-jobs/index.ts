// Deno entry for the scheduled webhook jobs. pg_cron calls it; see handler.ts.

import { createClient } from "@supabase/supabase-js";
import { parseBoulevardEvent } from "../_shared/boulevard-events.ts";
import { createBoulevard } from "../_shared/boulevard.ts";
import { applyAppointmentChange } from "../boulevard-webhook/process.ts";
import { createAppointmentBookings, createWebhookEvents } from "../boulevard-webhook/store.ts";
import { createHandler } from "./handler.ts";
import { createJobsStore } from "./store.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

const secretKey = (JSON.parse(env("SUPABASE_SECRET_KEYS")) as Record<string, string>).default;
const admin = createClient(env("SUPABASE_URL"), secretKey, { auth: { persistSession: false } });
const bookings = createAppointmentBookings(admin);

const boulevardConfig = {
  baseUrl: env("BOULEVARD_BASE_URL"),
  clientId: env("BOULEVARD_CLIENT_ID"),
  clientSecret: env("BOULEVARD_CLIENT_SECRET"),
  businessId: env("BOULEVARD_BUSINESS_ID"),
};

export default {
  fetch: createHandler({
    // The same value as the webhook_jobs_secret in Vault, which the cron job sends.
    cronSecret: env("WEBHOOK_JOBS_SECRET"),
    store: createJobsStore(admin),
    events: createWebhookEvents(admin),
    // Same processing as the receiver.
    process: async (event, log) => {
      await applyAppointmentChange(bookings, event.provider, parseBoulevardEvent(event.payload), log);
    },
    providers: {
      boulevard: (log) => createBoulevard(boulevardConfig, log),
    },
    defer: (work) => EdgeRuntime.waitUntil(work),
  }),
};
