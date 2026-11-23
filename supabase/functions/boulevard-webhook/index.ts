// Deno entry for the Boulevard webhook receiver. Wires the handler to Postgres and to
// EdgeRuntime.waitUntil, which keeps processing running after the 200 goes back.

import { createClient } from "@supabase/supabase-js";
import { createHandler, type WebhookEventsRepo } from "./handler.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

// Secret key = service_role: webhook_events is server only (no policies, no client grants).
const secretKey = (JSON.parse(env("SUPABASE_SECRET_KEYS")) as Record<string, string>).default;
const admin = createClient(env("SUPABASE_URL"), secretKey, { auth: { persistSession: false } });

const events: WebhookEventsRepo = {
  async record(event) {
    // "insert ... on conflict (provider, event_id) do nothing", then read whichever row is there.
    const { error } = await admin
      .from("webhook_events")
      .upsert({ provider: event.provider, event_id: event.eventId, type: event.type, payload: event.payload }, {
        onConflict: "provider,event_id",
        ignoreDuplicates: true,
      });
    if (error) throw error;
    const { data, error: readError } = await admin
      .from("webhook_events")
      .select("processed_at")
      .eq("provider", event.provider)
      .eq("event_id", event.eventId)
      .single();
    if (readError) throw readError;
    return { alreadyProcessed: data.processed_at !== null };
  },
  async recordAttempt(provider, eventId, error) {
    const { error: rpcError } = await admin.rpc("record_webhook_attempt", { p_provider: provider, p_event_id: eventId, p_error: error });
    if (rpcError) throw rpcError;
  },
};

export default {
  fetch: createHandler({
    secretBase64: env("BOULEVARD_CLIENT_SECRET"),
    events,
    // Piece 4 of step 5 fills this in. Until then events stay unprocessed (with this
    // reason on the row), so nothing is lost: they run once processing exists.
    process: async () => {
      throw new Error("processing not implemented yet");
    },
    defer: (work) => EdgeRuntime.waitUntil(work),
  }),
};
