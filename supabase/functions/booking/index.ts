// Deno entry for the booking function, and its composition root: the only file that
// knows which vendors exist. Adding a vendor = write its adapter, register it below,
// and point mapping rows at its name. The handler doesn't change.

import { createClient } from "@supabase/supabase-js";
import { createAutomations } from "../_shared/automations.ts";
import { createBoulevard } from "../_shared/boulevard.ts";
import { createHandler, type BookingRow, type BookingsRepo, type Mapping } from "./handler.ts";

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

// The new API keys arrive as JSON dictionaries keyed by name ("default", ...).
const publishableKeys = Object.values(JSON.parse(env("SUPABASE_PUBLISHABLE_KEYS")) as Record<string, string>);
const secretKey = (JSON.parse(env("SUPABASE_SECRET_KEYS")) as Record<string, string>).default;
// Secret key = service_role: bypasses RLS. Used for the mapping tables (read) and the
// bookings table (write). Every value written is validated by the handler first.
const admin = createClient(env("SUPABASE_URL"), secretKey, { auth: { persistSession: false } });

// Optional: where booking changes and alerts go (n8n, step 5b). Unset: nothing is sent.
const automations = createAutomations({ url: Deno.env.get("AUTOMATIONS_WEBHOOK_URL"), secret: Deno.env.get("AUTOMATIONS_SECRET") });

const boulevardConfig = {
  baseUrl: env("BOULEVARD_BASE_URL"),
  clientId: env("BOULEVARD_CLIENT_ID"),
  clientSecret: env("BOULEVARD_CLIENT_SECRET"),
  businessId: env("BOULEVARD_BUSINESS_ID"),
};

async function resolve(locationSlug: string, serviceSlug: string): Promise<Mapping | null> {
  const { data: location, error: locationError } = await admin
    .from("locations")
    .select("id, location_provider_mappings(provider, provider_location_id)")
    .eq("slug", locationSlug)
    .eq("active", true)
    .maybeSingle();
  if (locationError) throw locationError;
  const vendor = location?.location_provider_mappings as { provider: string; provider_location_id: string } | null | undefined;
  if (!location || !vendor) return null;

  const { data: service, error: serviceError } = await admin
    .from("service_provider_mappings")
    .select("treatment_id, provider_service_id, treatments!inner(slug, active)")
    .eq("provider", vendor.provider)
    .eq("treatments.slug", serviceSlug)
    .eq("treatments.active", true)
    .maybeSingle();
  if (serviceError) throw serviceError;
  if (!service) return null;

  return {
    provider: vendor.provider,
    vendorLocationId: vendor.provider_location_id,
    vendorServiceId: service.provider_service_id,
    treatmentId: service.treatment_id,
    locationId: location.id,
  };
}

// The bookings table in the handler's names. Postgres returns timestamptz as
// "2026-11-25 14:00:00+00" style text; normalize it so a retry answers byte for byte the same.
const BOOKING_COLUMNS = "id, idempotency_key, status, email, treatment_id, location_id, slot_start, provider, provider_booking_id, provider_session_id";
type BookingRecord = {
  id: string;
  idempotency_key: string;
  status: BookingRow["status"];
  email: string;
  treatment_id: string;
  location_id: string;
  slot_start: string;
  provider: string;
  provider_booking_id: string | null;
  provider_session_id: string | null;
};
const toRow = (r: BookingRecord): BookingRow => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  status: r.status,
  email: r.email,
  treatmentId: r.treatment_id,
  locationId: r.location_id,
  slotStart: new Date(r.slot_start).toISOString(),
  provider: r.provider,
  providerBookingId: r.provider_booking_id,
  providerSessionId: r.provider_session_id,
});

const bookings: BookingsRepo = {
  async findByKey(key) {
    const { data, error } = await admin.from("bookings").select(BOOKING_COLUMNS).eq("idempotency_key", key).maybeSingle();
    if (error) throw error;
    return data ? toRow(data as BookingRecord) : null;
  },
  async insertHeld(row) {
    // "insert ... on conflict (idempotency_key) do nothing": a concurrent retry with the same
    // key can't create a second row. Then read whichever row won.
    const { error } = await admin.from("bookings").upsert(
      {
        idempotency_key: row.idempotencyKey,
        email: row.email,
        treatment_id: row.treatmentId,
        location_id: row.locationId,
        slot_start: row.slotStart,
        provider: row.provider,
        provider_session_id: row.providerSessionId,
        status: "held",
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
    if (error) throw error;
    const saved = await bookings.findByKey(row.idempotencyKey);
    if (!saved) throw new Error("booking row missing after insert");
    return saved;
  },
  async confirm(id, providerBookingId) {
    const { error } = await admin.from("bookings").update({ status: "confirmed", provider_booking_id: providerBookingId }).eq("id", id);
    if (error) throw error;
  },
  async expire(id) {
    // Only a held row can expire; never downgrade one that got confirmed meanwhile.
    const { error } = await admin.from("bookings").update({ status: "expired" }).eq("id", id).eq("status", "held");
    if (error) throw error;
  },
};

export default {
  fetch: createHandler({
    publishableKeys,
    allowedOrigins: env("BOOKING_ALLOWED_ORIGINS").split(",").map((o) => o.trim()),
    resolve,
    bookings,
    // In the background: checkout never waits on n8n.
    forward: (event, log) => EdgeRuntime.waitUntil(automations.send(event, log)),
    // Keys match `provider` in the mapping tables.
    providers: {
      boulevard: (log) => createBoulevard(boulevardConfig, log),
    },
  }),
};
