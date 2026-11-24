// Deno entry for the Boulevard webhook receiver. Wires the handler to Postgres and to
// EdgeRuntime.waitUntil, which keeps processing running after the 200 goes back.

import { createClient } from "@supabase/supabase-js";
import { parseBoulevardEvent } from "../_shared/boulevard-events.ts";
import { createHandler, type WebhookEventsRepo } from "./handler.ts";
import { applyAppointmentChange, type AppointmentBookings, type BookingRef } from "./process.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

// Secret key = service_role: webhook_events and the mapping tables are server only, and
// clients can't write bookings. Every value written comes from a verified, parsed event.
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

// Each update repeats the processor's checks in its WHERE clause, so two deliveries of
// the same change processed at once can't overwrite each other's work.
const REF_COLUMNS = "id, status, vendor_updated_at";
type RefRecord = { id: string; status: BookingRef["status"]; vendor_updated_at: string | null };
const toRef = (r: RefRecord): BookingRef => ({
  id: r.id,
  status: r.status,
  vendorUpdatedAt: r.vendor_updated_at ? new Date(r.vendor_updated_at).toISOString() : null,
});
// ilike treats % and _ as wildcards, and "_" is common in emails: escape them.
const likeLiteral = (text: string) => text.replace(/[\\%_]/g, "\\$&");

const bookings: AppointmentBookings = {
  async findByVendorId(provider, vendorAppointmentId) {
    const { data, error } = await admin
      .from("bookings")
      .select(REF_COLUMNS)
      .eq("provider", provider)
      .eq("provider_booking_id", vendorAppointmentId)
      .maybeSingle();
    if (error) throw error;
    return data ? toRef(data as RefRecord) : null;
  },
  async findHeld(provider, vendorLocationId, start, email) {
    const { data: mapping, error: mappingError } = await admin
      .from("location_provider_mappings")
      .select("location_id")
      .eq("provider", provider)
      .eq("provider_location_id", vendorLocationId)
      .maybeSingle();
    if (mappingError) throw mappingError;
    if (!mapping) return null;
    const { data, error } = await admin
      .from("bookings")
      .select(REF_COLUMNS)
      .eq("provider", provider)
      .eq("location_id", mapping.location_id)
      .eq("status", "held")
      .eq("slot_start", start)
      .ilike("email", likeLiteral(email))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? toRef(data as RefRecord) : null;
  },
  async confirm(id, vendorAppointmentId, occurredAt) {
    const { error } = await admin
      .from("bookings")
      .update({ status: "confirmed", provider_booking_id: vendorAppointmentId, vendor_updated_at: occurredAt })
      .eq("id", id)
      .eq("status", "held");
    if (error) throw error;
  },
  async reschedule(id, start, occurredAt) {
    const { error } = await admin
      .from("bookings")
      .update({ slot_start: start, vendor_updated_at: occurredAt })
      .eq("id", id)
      .neq("status", "cancelled")
      .or(`vendor_updated_at.is.null,vendor_updated_at.lt."${occurredAt}"`);
    if (error) throw error;
  },
  async cancel(id, vendorUpdatedAt) {
    const { error } = await admin.from("bookings").update({ status: "cancelled", vendor_updated_at: vendorUpdatedAt }).eq("id", id).neq("status", "cancelled");
    if (error) throw error;
  },
};

export default {
  fetch: createHandler({
    secretBase64: env("BOULEVARD_CLIENT_SECRET"),
    events,
    // Boulevard's payload -> our AppointmentChange -> bookings. Throwing leaves the event unprocessed.
    process: async (event, log) => {
      await applyAppointmentChange(bookings, event.provider, parseBoulevardEvent(event.payload), log);
    },
    defer: (work) => EdgeRuntime.waitUntil(work),
  }),
};
